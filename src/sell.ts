// Sell list: the stash's trade-priced items grouped by the round price to list them at, each group
// with stash search strings that light up exactly its items. In game: paste a string, move every lit
// item to the merchant tab at the group's price, next string, next group.
//
// An item goes to the highest price level at or below its price (the cheapest matching instant
// buyout), so it lists at or just under the market and should move. Items whose price is shaky in the
// direction of underselling are kept out of the groups and listed for a look by hand.
import { stashTab, stashTabs } from './stash.ts';
import { DUMP_TYPES, getPrices, queryHash } from './scanner.ts';
import { analyzeItem } from './query.ts';
import { getStats } from './trade.ts';
import { loadModDb } from './moddb.ts';
import { chaosRates } from './rates.ts';
import { buildRegexes } from './regex.ts';

// tabs that are not dump tabs change rarely; they only matter as "don't light these up"
const SPECIAL_TTL = 6 * 3600 * 1000;

export const LADDERS = {
  fine: {
    chaos: [20, 22, 25, 28, 30, 33, 36, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 125, 140, 160, 180, 200, 225, 250],
    div: [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 50, 60, 75, 100],
  },
  normal: {
    chaos: [20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 175, 200, 250],
    div: [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100],
  },
  coarse: { chaos: [20, 30, 50, 75, 100, 150, 200], div: [1, 2, 3, 5, 10, 20, 50, 100] },
};
export type Step = keyof typeof LADDERS;
export type Level = { chaos: number; amount: number; currency: 'chaos' | 'divine' };

// Round prices from `min` up: chaos below a divine, divines from there.
export function priceLevels(min: number, step: Step, divine: number | null): Level[] {
  const l = LADDERS[step] ?? LADDERS.normal;
  const out: Level[] = [{ chaos: min, amount: min, currency: 'chaos' }];
  for (const c of l.chaos) if (c > min && (!divine || c < divine)) out.push({ chaos: c, amount: c, currency: 'chaos' });
  if (divine) for (const d of l.div) if (d * divine > min) out.push({ chaos: d * divine, amount: d, currency: 'divine' });
  return out.sort((a, b) => a.chaos - b.chaos);
}

export function levelFor(chaos: number, levels: Level[]): Level | null {
  let best: Level | null = null;
  for (const l of levels) if (l.chaos <= chaos + 1e-9) best = l;
  return best;
}

const clean = (s: unknown) => String(s ?? '').replace(/<<.*?>>/g, '').trim();

export type SellItem = {
  id: string; name: string; base: string; icon: string; frame: number; chaos: number; total: number; link: string; at: number;
  tab: number; tabName: string; warn: string[]; why?: string;
};

export async function sellList(min = 20, step: Step = 'normal', fresh = false) {
  const [tabs, prices, rates, stats, db] = await Promise.all([
    stashTabs(), getPrices(), chaosRates().catch(() => ({}) as Record<string, number>), getStats(), loadModDb().catch(() => null),
  ]);
  const divine = rates.divine ?? null;

  // the whole stash: the strings must not light up anything anywhere in it
  const all: any[] = [];
  const where = new Map<string, { tab: number; name: string }>();
  const unread: string[] = [];
  for (const t of tabs) {
    const dump = DUMP_TYPES.has(t.type);
    try {
      for (const it of await stashTab(t.i, fresh && dump, dump ? undefined : SPECIAL_TTL)) {
        if (!it?.id || where.has(it.id)) continue;
        all.push(it);
        where.set(it.id, { tab: t.i, name: t.n });
      }
    } catch (e) {
      unread.push(`${t.n} (${e instanceof Error ? e.message : e})`);
    }
  }

  const levels = priceLevels(min, step, divine);
  const groups = new Map<Level, SellItem[]>();
  const byHand: SellItem[] = [];
  for (const it of all) {
    const p = prices[it.id];
    if (!p || p.source !== 'trade' || p.chaos == null || p.chaos < min) continue;
    const w = where.get(it.id)!;
    const e: SellItem = {
      id: it.id, name: clean(it.name) || clean(it.typeLine), base: clean(it.name) ? clean(it.typeLine) : '', icon: it.icon, frame: it.frameType,
      chaos: p.chaos, total: p.total, link: p.link, at: p.at, tab: w.tab, tabName: w.name, warn: [],
    };
    // the search it was priced with is no longer the one we'd run (the item changed, or the rules did)
    if (p.hash !== queryHash(it, analyzeItem(it, stats, db))) {
      byHand.push({ ...e, why: 'priced under older rules (or the item changed): the next scan re-prices it' });
      continue;
    }
    if (!p.asks) {
      byHand.push({ ...e, why: 'old estimate (median of asks, overstates thin markets): the next scan re-prices it' });
      continue;
    }
    if ((p.lost ?? 0) >= 2) {
      byHand.push({ ...e, why: 'a good line was dropped to find comparables, so it may be worth more' });
      continue;
    }
    if (p.total < 10) e.warn.push(`only ${p.total} listed`);
    if (it.note) e.warn.push(`already noted "${clean(it.note)}"`);
    const lv = levelFor(p.chaos, levels)!;
    if (!groups.has(lv)) groups.set(lv, []);
    groups.get(lv)!.push(e);
  }

  const ordered = [...groups.entries()].sort((a, b) => b[0].chaos - a[0].chaos);
  const regex = buildRegexes(all, ordered.map(([, items]) => items.map((i) => i.id)));
  return {
    divine, min, step, at: Date.now(), unread, stashItems: all.length,
    groups: ordered.map(([lv, items], k) => {
      const tabCount = new Map<string, number>();
      for (const i of items) tabCount.set(i.tabName, (tabCount.get(i.tabName) ?? 0) + 1);
      return {
        level: lv,
        note: `~price ${lv.amount} ${lv.currency}`,
        items: items.sort((a, b) => b.chaos - a.chaos),
        sum: Math.round(items.length * lv.chaos),
        tabs: [...tabCount].map(([name, n]) => ({ name, n })),
        ...regex[k],
      };
    }),
    byHand: byHand.sort((a, b) => b.chaos - a.chaos),
  };
}
