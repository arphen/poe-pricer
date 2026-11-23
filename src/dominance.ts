// Dominance: an item is worth at most the cheapest listed item that is at least as good on every
// line that carries value. If 100 life 30 res sits at 1c, 80 life 30 res is worth 1c at most: no
// buyer pays more for it while the better one is up for less. No model, no trade search: just the
// listings already stored (every search and probe adds ~20).
//
// "Every line that carries value" is our item's: life/res totals, base implicits, defence/DPS rows
// and its own rated lines (weight >= 1). A listing dominates when it has each of those at least as
// high, and is no worse in kind: same slot, same base where the base matters, not corrupted when ours
// isn't, at least our open affixes (and item level) when we have room to craft, as many links.
// Items whose value is harder to compare (influenced, fractured, synthesised, clusters) are left out.
import { allListings, queryInfo, type ListingObs } from './dataset.ts';
import type { Features } from './features.ts';
import { loadModDb } from './moddb.ts';
import { listingFeatures } from './model.ts';
import { ownType, type Analysis } from './query.ts';
import { getStats } from './trade.ts';
import { priceable, type Slot } from './valuation.ts';

const FRESH_MS = 7 * 24 * 3600 * 1000; // older listings may well be sold
// slots where the base is mostly a container for its implicit (compared as a line) and its mods
const ANY_BASE: Slot[] = ['ring', 'amulet', 'belt', 'jewel', 'abyss', 'quiver'];

type Entry = { id: string; itemId: string; chaos: number; at: number; name: string; x: Features };
let pool: Entry[] = [];
let seen = new Set<string>();
let building: Promise<void> | null = null;

// Instant-buyout listings from the last week, featurized. Incremental: new listings are added on
// the next call.
async function refresh() {
  const [stats, db, qi, all] = await Promise.all([getStats(), loadModDb().catch(() => null), queryInfo(), allListings()]);
  const cutoff = Date.now() - FRESH_MS;
  let n = 0;
  for (const o of all) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    if (++n % 200 === 0) await new Promise((r) => setImmediate(r));
    if (o.at < cutoff || !priceable(o.item) || qi.get(o.query)?.status !== 'securable') continue;
    const x = listingFeatures(o, stats, db);
    if (x) pool.push({ id: o.id, itemId: o.item?.id ?? '', chaos: o.chaos, at: o.at, name: nameOf(o), x });
  }
  pool = pool.filter((e) => e.at >= cutoff);
}
const nameOf = (o: ListingObs) => String(o.item?.name || o.item?.typeLine || '?').replace(/<<.*?>>/g, '');

export function warmDominance() {
  building ??= refresh().finally(() => (building = null));
  return building;
}

export type Needs = { slot: Slot; base: string; magic: boolean; lines: Record<string, number>; f: Features['f'] };

// What a listing must match or beat to dominate this item; null when the item can't be compared.
// strict: every own line with a trade stat counts, not just those the rules rate (a line the rules
// don't know may still carry value): used before overruling a real trade price.
export function needsOf(item: any, a: Analysis, x: Features, strict = false): Needs | null {
  if (a.kind !== 'base' || a.slot === 'cluster' || a.slot === 'other') return null;
  if (x.f.influences || x.f.synthesised || x.f.fractured) return null;
  const lines: Record<string, number> = {};
  for (const m of a.mods) {
    if (m.negate) continue; // our own search ceilings
    const total = m.type === 'pseudo' && /^pseudo:(?:life|ele|chaos)$/.test(m.key);
    const rated = (m.type === 'prop' || (ownType(a.slot, m.type) && !m.covered)) && (m.weight >= 1 || (strict && m.type !== 'prop'));
    if (!total && !rated && m.type !== 'implicit') continue;
    if (!m.statId) {
      if (rated) return null; // something of value trade has no stat for: can't compare
      continue;
    }
    if (m.statId.includes('|')) continue;
    if (m.min == null && m.max != null) return null; // a lower-is-better roll: no "at least"
    const k = m.statId.replace(/^fractured\./, 'explicit.');
    lines[k] = x.f[k] ?? 0;
  }
  return { slot: a.slot, base: a.baseType, magic: item.frameType === 1, lines, f: x.f };
}

export function dominates(l: Features, n: Needs): boolean {
  const f = l.f;
  if (l.slot !== n.slot) return false;
  if (n.magic !== !!f.magic) return false; // magic items compete with magic items
  if (!ANY_BASE.includes(n.slot) && !f[`base:${n.base}`]) return false;
  if (f.corrupted && !n.f.corrupted) return false;
  const room = (n.f.openPrefix ?? 0) + (n.f.openSuffix ?? 0) > 0;
  if (room && ((f.openPrefix ?? 0) < (n.f.openPrefix ?? 0) || (f.openSuffix ?? 0) < (n.f.openSuffix ?? 0) || (f.ilvl ?? 0) < (n.f.ilvl ?? 0))) return false;
  if ((n.f.links ?? 0) >= 5 && (f.links ?? 0) < n.f.links) return false;
  for (const [k, v] of Object.entries(n.lines)) if ((f[k] ?? 0) < v - 1e-9) return false;
  return true;
}

export type Dominator = { chaos: number; name: string; at: number; count: number };

// The cheapest stored listing that dominates this item, if any.
export async function dominator(item: any, a: Analysis, x: Features, strict = false): Promise<Dominator | null> {
  const n = needsOf(item, a, x, strict);
  if (!n) return null;
  await warmDominance();
  let best: Entry | null = null;
  let count = 0;
  for (const e of pool) {
    if (e.itemId === item.id || !dominates(e.x, n)) continue; // our own item, listed
    count++;
    if (!best || e.chaos < best.chaos) best = e;
  }
  return best && { chaos: Math.round(best.chaos * 10) / 10, name: best.name, at: best.at, count };
}
