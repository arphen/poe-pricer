// Background pricer: walks dump tabs, prices every rare the local model rates check/maybe with the
// default selection, and keeps results on disk. All GGG calls go through poeFetch's limiter, so the
// queue runs as fast as the budget allows and no faster.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { loadModDb } from './moddb.ts';
import { rateWait } from './poeClient.ts';
import { recordSearch } from './dataset.ts';
import { estimate as modelEstimate, isTrash, retrain, type Estimate } from './model.ts';
import { analyzeItem, buildQuery, describeSelection, dropOrder } from './query.ts';
import { priceable } from './valuation.ts';
import { chaosRates, toChaos } from './rates.ts';
import { stashTab, stashTabs } from './stash.ts';
import { getStats, priceCheck } from './trade.ts';
import { dominator, warmDominance, type Dominator } from './dominance.ts';
import { featuresOf } from './features.ts';

export type Price = {
  chaos: number | null; // estimate; null = no comparable listings
  low: number | null; // cheapest listing
  n: number; // listings fetched with a known currency
  total: number; // total matches on trade
  confidence: 'ok' | 'low' | 'none';
  relaxed: boolean; // had to drop lines to find comparables
  dropped?: number; // how many lines, least important first
  lost?: number; // highest weight among the dropped lines: >= 2 means the comparables lack a good mod
  cheap?: boolean; // trade-confirmed cheap: (nearly) the whole item searched, enough listed, all cheap
  asks?: number[]; // chaos asks of the cheapest listings found, ascending
  searched?: string[]; // analysis keys of the lines the final search used
  droppedKeys?: string[]; // ...and of the lines given up on the way, least important first
  link: string;
  at: number;
  hash: string;
  name: string;
  tab: number;
  // model = confidently trash, no search spent; beaten = a stored listing at least as good on every
  // line that matters asks under the trash line, so this is worth at most that (no search spent)
  source: 'trade' | 'model' | 'beaten';
  beatenBy?: Dominator; // beaten: that listing; trade: set when it capped a higher trade price
  model?: Estimate | null; // model's view at pricing time, for comparing against the trade result
};

// tier ladder: below this many matches a search's listings are too few to price from
const MIN_COMPARABLE = 5;
// bump when the pricing method changes: every stored trade price then gets searched again
const PRICE_VERSION = 3;
const FRESH_MS = 3 * 3600 * 1000;
export const DUMP_TYPES = new Set(['NormalStash', 'PremiumStash', 'QuadStash']);
const file = join(import.meta.dirname, '..', '.cache', `prices-${config.league}.json`);

let prices: Record<string, Price> = {};
const loaded = readFile(file, 'utf8').then((s) => void (prices = JSON.parse(s)), () => undefined);
const save = async () => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(prices));
};

export async function getPrices() {
  await loaded;
  return prices;
}

// Estimate: listings are instant buyouts, so each is a real offer. The cheapest one that matches is
// what a buyer pays for an item like ours (comparables are at least as good on every searched line),
// so it is the price; the others only show the spread. A market with few matches is a guess: rare
// combos attract hopeful asks that may never sell.
const THIN = 10;
export function estimate(chaos: number[], total = Infinity): { chaos: number | null; confidence: Price['confidence'] } {
  const v = [...chaos].sort((a, b) => a - b);
  if (!v.length) return { chaos: null, confidence: 'none' };
  return { chaos: Math.round(v[0] * 10) / 10, confidence: v.length >= 5 && total >= THIN ? 'ok' : 'low' };
}

type Job = { item: any; tab: number; explore?: boolean };
// what this scan has done with an item, in order: priced by trade, priced by the model alone, failed
type Seen = { id: string; name: string; how: 'trade' | 'model' | 'beaten' | 'error' };
const state = {
  running: false,
  stop: false,
  queue: [] as Job[],
  explore: [] as Job[], // learning searches: only run once the main queue is empty
  skipped: 0, // searches saved by the model this scan
  done: 0,
  total: 0,
  current: '',
  currentId: '',
  seen: [] as Seen[], // new to this scan only: re-judging an unchanged model price is no progress
  errors: [] as string[],
  startedAt: 0,
  nextScanAt: null as number | null, // next automatic re-read of the dump tabs
};

const nameOf = (j: Job) => j.item.name?.replace(/<<.*?>>/g, '') || j.item.typeLine?.replace(/<<.*?>>/g, '') || '?';

export function scanStatus() {
  const perItem = state.done ? (Date.now() - state.startedAt) / state.done : 0;
  const waiting = [...state.queue, ...state.explore];
  return {
    running: state.running,
    done: state.done,
    total: state.total,
    skipped: state.skipped,
    seen: state.seen,
    current: state.running && state.currentId ? { id: state.currentId, name: state.current } : null,
    queue: waiting.map((j) => ({ id: j.item.id, name: nameOf(j) })),
    wait: state.running ? rateWait() : null,
    nextScanAt: state.nextScanAt,
    etaS: perItem ? Math.round((perItem * waiting.length) / 1000) : null,
    errors: state.errors.slice(-5),
    calls: modelCalls(24),
  };
}

// How close the model's guess was to the trade price, per searched item, oldest first. The guess is
// stored at pricing time, before that item's own listings reached the training data.
export function modelCalls(limit = Infinity) {
  return Object.values(prices)
    .filter((p) => p.source === 'trade' && p.chaos != null && p.model?.chaos)
    .sort((x, y) => x.at - y.at)
    .slice(-limit)
    .map((p) => ({ name: p.name, at: p.at, guess: p.model!.chaos, trade: p.chaos! }));
}

export function stopScan() {
  state.stop = true;
  state.queue = [];
  state.explore = [];
}

export async function dumpTabs(): Promise<number[]> {
  return (await stashTabs()).filter((t) => DUMP_TYPES.has(t.type)).map((t) => t.i);
}

// Queue up candidates from the given tabs (default: all dump-type tabs). Already-priced items with
// an unchanged query are skipped unless older than FRESH_MS.
export async function startScan(tabs?: number[], fresh = false) {
  await loaded;
  const [stats, db] = await Promise.all([getStats(), loadModDb().catch(() => null)]);
  if (!state.running) {
    state.done = 0;
    state.skipped = 0;
    state.seen = [];
    state.errors = [];
  }
  const queued = new Set([...state.queue, ...state.explore].map((j) => j.item.id));
  const explore: Job[] = [];
  for (const tab of tabs ?? (await dumpTabs())) {
    for (const item of await stashTab(tab, fresh)) {
      if (!priceable(item) || queued.has(item.id)) continue;
      const a = analyzeItem(item, stats, db);
      if (a.slot === 'other' || a.kind !== 'base') continue;
      if (!describeSelection(a).mods.some((m) => m.enabled)) continue; // nothing on it to search for
      const hash = queryHash(item, a);
      const p = prices[item.id];
      // model/dominance prices are re-judged every pass (free, and the data keeps growing)
      if (p && p.hash === hash && p.source === 'trade' && Date.now() - p.at < FRESH_MS) continue;
      const v = a.useCraft ? a.craftedVerdict : a.verdict;
      // a stored listing at least as good on every line that matters asks under the trash line:
      // worth that at most, no search needed (bar the exploration share, which checks this too)
      const dom = await dominator(item, a, featuresOf(item, a)).catch(() => null);
      if (dom && dom.chaos < config.trashChaos && Math.random() >= config.exploreRate) {
        if (p?.hash !== hash || p.source !== 'beaten') state.seen.push({ id: item.id, name: a.name || a.baseType, how: 'beaten' });
        prices[item.id] = { chaos: dom.chaos, low: dom.chaos, n: 0, total: dom.count, confidence: 'ok', relaxed: false, cheap: true, link: '', at: Date.now(), hash, name: a.name || a.baseType, tab, source: 'beaten', beatenBy: dom };
        state.skipped++;
        continue;
      }
      const m = await modelEstimate(item, a);
      // model is sure it's trash: record its price, keep the search (bar a small exploration share)
      if (isTrash(m, a) && Math.random() >= config.exploreRate) {
        if (p?.hash !== hash) state.seen.push({ id: item.id, name: a.name || a.baseType, how: 'model' });
        prices[item.id] = modelPrice(item, a, tab, hash, m!);
        state.skipped++;
        continue;
      }
      if (v === 'check' || v === 'maybe') state.queue.push({ item, tab });
      else explore.push({ item, tab, explore: true });
      queued.add(item.id);
    }
  }
  // the rules only order the work: "check" first, then "maybe", then every rule-skipped rare, most
  // surprising first (the model thinks it may be worth more). Nothing is junk until trade says so.
  const rank = (j: Job) => {
    const a = analyzeItem(j.item, stats, db);
    return (a.useCraft ? a.craftedVerdict : a.verdict) === 'check' ? 0 : 1;
  };
  state.queue.sort((x, y) => rank(x) - rank(y));
  const guess = new Map<string, number>();
  for (const j of explore) guess.set(j.item.id, (await modelEstimate(j.item, analyzeItem(j.item, stats, db)))?.hi ?? Math.random());
  explore.sort((x, y) => guess.get(y.item.id)! - guess.get(x.item.id)!);
  state.explore.push(...(config.explorePerScan > 0 ? explore.slice(0, config.explorePerScan) : explore));
  if (state.skipped) await save();
  state.total = state.done + state.queue.length + state.explore.length;
  // a Stop pressed while the last item was still searching must not swallow this new work
  state.stop = false;
  if (!state.running) void run();
  return scanStatus();
}

function modelPrice(item: any, a: ReturnType<typeof analyzeItem>, tab: number, hash: string, m: Estimate): Price {
  return { chaos: m.chaos, low: null, n: 0, total: 0, confidence: 'low', relaxed: false, link: '', at: Date.now(), hash, name: a.name || a.baseType, tab, source: 'model', model: m };
}

export function queryHash(item: any, a: ReturnType<typeof analyzeItem>) {
  return createHash('sha1').update(JSON.stringify({ v: PRICE_VERSION, q: buildQuery(item, a, describeSelection(a)) })).digest('hex').slice(0, 12);
}

async function run() {
  state.running = true;
  state.stop = false;
  state.startedAt = Date.now();
  try {
    const [stats, db] = await Promise.all([getStats(), loadModDb().catch(() => null)]);
    while ((state.queue.length || state.explore.length) && !state.stop) {
      const job = (state.queue.shift() ?? state.explore.shift())!;
      const { item, tab } = job;
      state.current = nameOf(job);
      state.currentId = item.id;
      let how: Seen['how'] = 'trade';
      try {
        const a = analyzeItem(item, stats, db);
        state.current = a.name || a.baseType;
        prices[item.id] = await priceItem(item, a, tab);
        await save();
      } catch (e) {
        how = 'error';
        state.errors.push(`${state.current}: ${e instanceof Error ? e.message : e}`);
      }
      state.seen.push({ id: item.id, name: state.current, how });
      state.done++;
    }
  } finally {
    state.running = false;
    state.current = '';
    state.currentId = '';
  }
  await retrain().catch((e) => state.errors.push(`model: ${e.message}`));
}

// Tier ladder: search the whole item, then give up its least important line per step until enough
// comparables are listed (or one line is left). `thin` sees each search that had too few, since its
// listings are still training data. `lost`: highest weight among the lines given up.
export async function ladder<R extends { total: number }>(
  item: any,
  a: ReturnType<typeof analyzeItem>,
  search: (body: ReturnType<typeof buildQuery>) => Promise<R>,
  thin: (body: ReturnType<typeof buildQuery>, r: R, dropped: number) => Promise<void>,
) {
  const base = describeSelection(a);
  const order = dropOrder(a, base);
  // ceilings ("not" filters) are never given up and aren't lines of the item
  const capped = new Set(a.mods.filter((m) => m.negate).map((m) => m.key));
  const lines = base.mods.filter((m) => m.enabled && !capped.has(m.key)).length;
  for (let dropped = 0; ; dropped++) {
    const off = new Set(order.slice(0, dropped));
    const body = buildQuery(item, a, { ...base, mods: base.mods.map((m) => (off.has(m.key) ? { ...m, enabled: false } : m)) });
    const r = await search(body);
    if (r.total >= MIN_COMPARABLE || dropped >= order.length || lines - dropped <= 1) {
      const weight = new Map(a.mods.map((m) => [m.key, m.weight]));
      const droppedKeys = order.slice(0, dropped);
      const searched = base.mods.filter((m) => m.enabled && !off.has(m.key)).map((m) => m.key);
      return { body, r, dropped, droppedKeys, searched, lost: Math.max(0, ...droppedKeys.map((k) => weight.get(k) ?? 0)) };
    }
    await thin(body, r, dropped);
  }
}

export async function priceItem(item: any, a: ReturnType<typeof analyzeItem>, tab: number): Promise<Price> {
  const rates = await chaosRates().catch(() => ({ chaos: 1 }) as Record<string, number>);
  const { body, r, dropped, droppedKeys, searched, lost } = await ladder(item, a, priceCheck, (b, res, d) =>
    recordSearch(item, b, res, rates, { chaos: null, relaxed: d > 0, dropped: d }).then(() => undefined, (e) => console.warn('dataset:', e.message)),
  );
  const chaos = r.listings.map((l) => toChaos(l.amount, l.currency, rates)).filter((x): x is number => x !== null);
  const est = estimate(chaos, r.total);
  // never above what a stored listing at least as good on every line asks (strict: all lines with a
  // trade stat, rated or not, since this overrules a real trade price)
  const dom = await dominator(item, a, featuresOf(item, a), true).catch(() => null);
  const capped = dom && est.chaos != null && dom.chaos < est.chaos ? dom : null;
  if (capped) est.chaos = capped.chaos;
  // comparables missing a good line of ours undersell it, so the price is only a floor
  const confidence = lost >= 2 && est.confidence === 'ok' ? 'low' : est.confidence;
  await recordSearch(item, body, r, rates, { chaos: est.chaos, relaxed: dropped > 0, dropped }).catch((e) => console.warn('dataset:', e.message));
  return {
    chaos: est.chaos,
    low: chaos.length ? Math.min(...chaos) : null,
    n: chaos.length,
    total: r.total,
    confidence,
    relaxed: dropped > 0,
    dropped,
    lost,
    cheap: confidence === 'ok' && est.chaos != null && est.chaos < config.trashChaos,
    asks: chaos.sort((x, y) => x - y).map((c) => Math.round(c * 10) / 10),
    searched,
    droppedKeys,
    link: r.link,
    at: Date.now(),
    hash: queryHash(item, a),
    name: a.name || a.baseType,
    tab,
    source: 'trade',
    ...(capped ? { beatenBy: capped } : {}),
    model: await modelEstimate(item, a).catch(() => null),
  };
}

// Background loop: re-read dump tabs every few minutes and price whatever is new.
export function autoScan(everyMs = 10 * 60 * 1000) {
  void warmDominance().catch((e) => console.warn('dominance:', e.message));
  const tick = () => startScan(undefined, true).catch((e) => state.errors.push(`auto: ${e.message}`));
  state.nextScanAt = Date.now() + 5000;
  setTimeout(tick, 5000);
  setInterval(() => {
    state.nextScanAt = Date.now() + everyMs;
    if (!state.running) tick();
  }, everyMs);
}
