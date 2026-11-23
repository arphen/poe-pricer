// Idle explorer. All training data used to come from searching our own items: a few hundred distinct
// searches, a handful per slot, so the model had seen maybe ten kinds of gloves. When nothing of ours
// is queued and nobody else is using trade on this account (the user isn't trading), spend the budget
// on probes: one search for any rare of a slot with one affix, or a pair of affixes, rolled well.
//
// Payoffs per probe:
// - its floor (cheapest instant buyouts) reads what that affix (pair) alone is worth in that slot:
//   the "affix floors" table on the overview page, i.e. which prefixes/suffixes are valuable;
// - floors become rule weights (learnWeights): an affix whose good roll alone holds a price, or that
//   lifts life well above life alone, is searched first and given up last;
// - its listings are training data from parts of item space our stash never searched.
//
// Order: affixes on our stash (prices we need), then pairs of the best lines of our items (value
// lives in combinations: life alone is 0.1c on 10k amulets), then every other affix seen on stored
// listings, most common first. "Rolled well" = the upper quarter of the rolls seen in that slot.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { allListings, recordSearch } from './dataset.ts';
import { loadModDb, type IndexedDb } from './moddb.ts';
import { lastUserTrade } from './poeClient.ts';
import { analyzeItem, normalizeMod, ownType, type StatsIndex } from './query.ts';
import { chaosRates, toChaos } from './rates.ts';
import { retrain } from './model.ts';
import { dumpTabs, scanStatus } from './scanner.ts';
import { stashTab } from './stash.ts';
import { getStats, priceCheck } from './trade.ts';
import { priceable, setLearned, type Learned, type Slot } from './valuation.ts';

const CATEGORY: Partial<Record<Slot, string>> = {
  ring: 'accessory.ring', amulet: 'accessory.amulet', belt: 'accessory.belt', quiver: 'armour.quiver',
  helmet: 'armour.helmet', chest: 'armour.chest', gloves: 'armour.gloves', boots: 'armour.boots', shield: 'armour.shield',
  jewel: 'jewel.base', abyss: 'jewel.abyss', cluster: 'jewel.cluster', weapon: 'weapon',
};
const LIFE = 'pseudo.pseudo_total_life';
const REPROBE_MS = 3 * 24 * 3600 * 1000; // markets drift; a probe older than this is due again
const CANDIDATES_MS = 6 * 3600 * 1000;
const PAIR_LINES = 3; // pairs among each stash item's best this-many lines
const file = join(import.meta.dirname, '..', 'data', `probes-${config.league}.json`);

export type Part = { statId: string; text: string; affix: string | null };
export type ProbeResult = {
  key: string; slot: Slot; type: string | null; parts: (Part & { min: number })[];
  total: number; floor: number | null; median: number | null; asks: number[]; link: string; at: number; error?: string;
};
type Single = Part & { key: string; slot: Slot; type: string | null; values: number[]; stash: number };
type Candidate = { key: string; slot: Slot; type: string | null; parts: Part[]; stash: number };

let store: { enabled: boolean; probes: Record<string, ProbeResult> } = { enabled: true, probes: {} };
const loaded = readFile(file, 'utf8').then((s) => {
  store = { ...store, ...JSON.parse(s) };
  // probes stored before pairs existed carry one affix in flat fields
  for (const p of Object.values(store.probes) as any[]) p.parts ??= [{ statId: p.statId, text: p.text, affix: p.affix, min: p.min }];
  setLearned(learnWeights(Object.values(store.probes)));
}, () => undefined);
const save = async () => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store));
};

const state = { busy: false, current: null as string | null, paused: null as string | null, lastAt: 0, errors: [] as string[] };
let built: { at: number; list: Candidate[]; singles: Map<string, Single> } | null = null;

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const round = (v: number) => (v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10);
// a good roll for the affix in this slot: upper quarter of what we've seen, or ours if seen rarely
export function goodRoll(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (v.length >= 4) return round(v[Math.floor(v.length * 0.75)]);
  return round(v[v.length - 1] * 0.9);
}
const singleKey = (slot: Slot, type: string | null, statId: string) => `${slot}|${type ?? ''}|${statId}`;

function affixOf(norm: string, type: string, db: IndexedDb | null): string | null {
  if (type === 'pseudo') return 'total';
  if (type === 'implicit') return 'implicit';
  if (type === 'enchant') return 'enchant';
  // the same line can be a prefix on one item kind and a suffix on another: take the usual one
  const n = { prefix: 0, suffix: 0 };
  for (const m of db?.byNorm.get(norm) ?? []) if (!m.crafted) n[m.gen]++;
  return n.prefix > n.suffix ? 'prefix' : n.suffix > n.prefix ? 'suffix' : null;
}

// Every (slot, affix) seen, with the rolls seen; for stash items also pairs of their best lines.
async function collect(items: any[], fromStash: boolean, stats: StatsIndex, db: IndexedDb | null, singles: Map<string, Single>, pairs: Map<string, Candidate>) {
  let n = 0;
  for (const it of items) {
    if (++n % 200 === 0) await new Promise((r) => setImmediate(r)); // thousands of items: let requests through
    if (!priceable(it)) continue;
    let a;
    try {
      a = analyzeItem(it, stats, db);
    } catch {
      continue;
    }
    if (a.kind !== 'base' || (!CATEGORY[a.slot] && a.slot !== 'viscera')) continue;
    const type = a.slot === 'viscera' ? a.tradeType : null;
    const mine: { s: Single; weight: number }[] = [];
    for (const m of a.mods) {
      if (!m.statId || m.statId.startsWith('prop:') || m.statId.includes('|') || m.negate || !m.values.length) continue;
      if (m.min == null) continue; // ceilings-only stats ("-# ..." searched as a maximum)
      const total = m.type === 'pseudo' && /^pseudo:(?:life|ele|chaos)$/.test(m.key);
      if (!total && (m.covered || !ownType(a.slot, m.type))) continue;
      const statId = m.statId.replace(/^fractured\./, 'explicit.');
      const key = singleKey(a.slot, type, statId);
      const norm = m.type === 'pseudo' ? m.text.replace(/[\d.]+/g, '#') : normalizeMod(m.text).norm;
      const s = singles.get(key) ?? { key, slot: a.slot, type, statId, text: norm, affix: affixOf(norm, m.type, db), values: [], stash: 0 };
      s.values.push(avg(m.values));
      if (fromStash) s.stash++;
      singles.set(key, s);
      mine.push({ s, weight: m.weight });
    }
    if (!fromStash) continue;
    const best = mine.sort((x, y) => y.weight - x.weight).slice(0, PAIR_LINES).map((x) => x.s);
    for (let i = 0; i < best.length; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const [x, y] = [best[i], best[j]].sort((p, q) => (p.statId < q.statId ? -1 : 1));
        const key = `${a.slot}|${type ?? ''}|${x.statId}+${y.statId}`;
        const p = pairs.get(key) ?? { key, slot: a.slot, type, parts: [x, y].map(({ statId, text, affix }) => ({ statId, text, affix })), stash: 0 };
        p.stash++;
        pairs.set(key, p);
      }
    }
  }
}

export async function buildCandidates() {
  const [stats, db] = await Promise.all([getStats(), loadModDb().catch(() => null)]);
  const singles = new Map<string, Single>();
  const pairs = new Map<string, Candidate>();
  for (const t of await dumpTabs()) await collect(await stashTab(t).catch(() => []), true, stats, db, singles, pairs);
  await collect((await allListings()).map((o) => o.item), false, stats, db, singles, pairs);
  const asCandidate = (s: Single): Candidate => ({ key: s.key, slot: s.slot, type: s.type, parts: [{ statId: s.statId, text: s.text, affix: s.affix }], stash: s.stash });
  const all = [...singles.values()];
  const list = [
    ...all.filter((s) => s.stash).sort((a, b) => b.stash - a.stash || b.values.length - a.values.length).map(asCandidate),
    ...[...pairs.values()].sort((a, b) => b.stash - a.stash),
    ...all.filter((s) => !s.stash).sort((a, b) => b.values.length - a.values.length).map(asCandidate),
  ];
  return { list, singles };
}

export function probeBody(c: { slot: Slot; type: string | null }, parts: { statId: string; min: number }[]) {
  const query: any = {
    status: { option: 'securable' },
    stats: [{ type: 'and', filters: parts.map((p) => ({ id: p.statId, value: { min: p.min }, disabled: false })) }],
    filters: { misc_filters: { filters: { corrupted: { option: 'false' } } } },
  };
  if (c.type) query.type = c.type;
  else query.filters.type_filters = { filters: { category: { option: CATEGORY[c.slot] }, rarity: { option: 'nonunique' } } };
  return { query, sort: { price: 'asc' } };
}

async function probe(c: Candidate, singles: Map<string, Single>) {
  const parts = c.parts.map((p) => ({ ...p, min: goodRoll(singles.get(singleKey(c.slot, c.type, p.statId))?.values ?? [1]) }));
  const body = probeBody(c, parts);
  const base = { key: c.key, slot: c.slot, type: c.type, parts, at: Date.now() };
  try {
    const r = await priceCheck(body, 10, 10);
    const rates = await chaosRates().catch(() => ({ chaos: 1 }) as Record<string, number>);
    const asks = r.listings.map((l) => toChaos(l.amount, l.currency, rates)).filter((x): x is number => x != null).sort((a, b) => a - b);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    store.probes[c.key] = { ...base, total: r.total, floor: asks.length ? r1(asks[0]) : null, median: asks.length ? r1(asks[asks.length >> 1]) : null, asks: asks.map(r1), link: r.link };
    await recordSearch({ id: `probe:${c.key}` }, body, r, rates, { chaos: asks[0] ?? null, relaxed: false }).catch((e) => console.warn('dataset:', e.message));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    store.probes[c.key] = { ...base, total: 0, floor: null, median: null, asks: [], link: '', error: msg.slice(0, 200) };
    state.errors = [...state.errors.slice(-4), `${parts.map((p) => p.text).join(' + ')}: ${msg.slice(0, 120)}`];
  }
  await save();
  setLearned(learnWeights(Object.values(store.probes)));
  retrain().catch((e) => console.warn('model:', e.message)); // retrains itself once enough is new
}

// --- probe floors -> rule weights ----------------------------------------------------------------

// Thresholds in chaos: a good roll that alone holds this floor is worth searching on / a key line.
export const FLOOR_GOOD = 5;
export const FLOOR_KEY = 30;
const COMBO = 3; // a pair is worth more than its parts when its floor beats the best part's this many times

// Per (slot, stat): a floor for its rule weight, or a cap. Only from clear evidence:
// - promote: its good roll alone holds a floor, or paired with another line (life, typically) it
//   lifts the floor well above either line alone;
// - demote (to minor): cheap alone on a big market AND cheap even next to good life.
export function learnWeights(probes: ProbeResult[]): Map<string, Learned> {
  const ok = probes.filter((p) => !p.error && p.floor != null);
  const single = new Map<string, ProbeResult>();
  for (const p of ok) if (p.parts.length === 1) single.set(`${p.slot}|${p.type ?? ''}|${p.parts[0].statId}`, p);
  const floorOf = (slot: Slot, type: string | null, statId: string) => single.get(`${slot}|${type ?? ''}|${statId}`)?.floor ?? null;
  const out = new Map<string, Learned>();
  const raise = (slot: Slot, statId: string, min: number, why: string) => {
    if (statId.startsWith('pseudo.')) return; // totals have their own weighting
    const k = `${slot}|${statId}`;
    const cur = out.get(k);
    if (!cur || (cur.min ?? 0) < min) out.set(k, { min, why });
  };
  for (const p of single.values()) {
    const { statId, text } = p.parts[0];
    if (p.floor! >= FLOOR_KEY) raise(p.slot, statId, 3, `a good roll alone sells from ${p.floor}c (${text})`);
    else if (p.floor! >= FLOOR_GOOD) raise(p.slot, statId, 2, `a good roll alone sells from ${p.floor}c`);
  }
  for (const p of ok) {
    if (p.parts.length !== 2) continue;
    const [a, b] = p.parts;
    const fa = floorOf(p.slot, p.type, a.statId), fb = floorOf(p.slot, p.type, b.statId);
    if (fa == null || fb == null) continue; // need both parts alone to call it a combination
    if (p.floor! >= FLOOR_GOOD && p.floor! >= COMBO * Math.max(fa, fb, 0.5)) {
      raise(p.slot, a.statId, 2, `with ${b.text.replace('#', '…')} sells from ${p.floor}c (alone ${fa}c)`);
      raise(p.slot, b.statId, 2, `with ${a.text.replace('#', '…')} sells from ${p.floor}c (alone ${fb}c)`);
    }
  }
  // demote: cheap alone among many, and cheap even with good life
  for (const p of single.values()) {
    const { statId } = p.parts[0];
    if (statId.startsWith('pseudo.') || out.has(`${p.slot}|${statId}`) || p.floor! >= 1 || p.total < 500) continue;
    const pair = ok.find((q) => q.parts.length === 2 && q.slot === p.slot && q.parts.some((x) => x.statId === LIFE) && q.parts.some((x) => x.statId === statId));
    if (pair && pair.floor! < 1 && pair.total >= 100) out.set(`${p.slot}|${statId}`, { max: 1, why: `cheap alone (${p.floor}c, ${p.total} listed) and with good life (${pair.floor}c)` });
  }
  return out;
}

// --- loop ------------------------------------------------------------------------------------------

const due = (c: Candidate) => {
  const p = store.probes[c.key];
  return !p || Date.now() - p.at > REPROBE_MS;
};

async function tick() {
  await loaded;
  if (state.busy || !store.enabled || !(config.probeSeconds > 0)) return;
  const pause = (why: string) => void (state.paused = why);
  if (scanStatus().running) return pause('pricing the stash first');
  const foreign = Math.max(lastUserTrade('search'), lastUserTrade('fetch'));
  if (Date.now() - foreign < config.probeIdleMinutes * 60_000) return pause(`trade site in use, waiting until it's been quiet ${config.probeIdleMinutes} min`);
  state.paused = null;
  if (Date.now() - state.lastAt < config.probeSeconds * 1000) return;
  state.busy = true;
  try {
    if (!built || Date.now() - built.at > CANDIDATES_MS) built = { at: Date.now(), ...(await buildCandidates()) };
    const next = built.list.find(due);
    if (!next) return pause('every affix probed recently');
    state.current = `${next.slot}: ${next.parts.map((p) => p.text).join(' + ')}`;
    state.lastAt = Date.now();
    await probe(next, built.singles);
  } catch (e) {
    state.errors = [...state.errors.slice(-4), e instanceof Error ? e.message : String(e)];
  } finally {
    state.busy = false;
    state.current = null;
  }
}

export function startExplorer() {
  void loaded; // learned weights apply from startup, whether or not probing is on
  if (!(config.probeSeconds > 0)) return;
  setInterval(() => void tick(), 5000);
}

export async function setExplorer(on: boolean) {
  await loaded;
  store.enabled = on;
  await save();
  return exploreStatus();
}

export async function exploreStatus() {
  await loaded;
  const list = built?.list ?? [];
  const learned = learnWeights(Object.values(store.probes));
  return {
    enabled: store.enabled && config.probeSeconds > 0,
    configured: config.probeSeconds > 0,
    everySeconds: config.probeSeconds,
    current: state.current,
    paused: state.paused,
    errors: state.errors,
    candidates: list.length,
    due: list.filter(due).length,
    probes: Object.values(store.probes).sort((a, b) => (b.floor ?? -1) - (a.floor ?? -1)),
    learned: Object.fromEntries(learned),
  };
}
