// Learned price model on top of the stored listings: log(chaos) ~ boosted trees over item features.
// Uses: (1) price items without a trade query when the model is sure they're trash, (2) explain
// prices per item, (3) rank which attributes matter per slot (feeds back into query selection).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { allListings, ownPrices, queryInfo, type ListingObs, type QueryInfo } from './dataset.ts';
import { featuresOf, type Features } from './features.ts';
import { contributions, predict, train, type Model } from './gbdt.ts';
import { loadModDb } from './moddb.ts';
import { analyzeItem, type Analysis } from './query.ts';
import { getStats } from './trade.ts';
import { priceable } from './valuation.ts';

// informative: listings that say something beyond the market floor (see `informative` below)
export type SlotMetrics = { n: number; val: number; rmse: number | null; baseline: number | null; informative?: number };
export type Saved = {
  version?: number;
  at: number;
  trainedOn: number;
  // vsTrade: the model's guess for our own held-out items against the trade price our pricer found
  metrics: { rmse: number | null; baseline: number | null; slots: Record<string, SlotMetrics>; vsTrade?: { n: number; rmse: number; bias: number; within2: number } | null };
  importance: Record<string, { feature: string; label: string; impact: number }[]>;
  // learned price effect of each affix (mean log-price contribution when present), per slot and overall
  affixes?: Record<string, AffixValue[]>;
  labels: Record<string, string>;
  model: Model;
};
export type AffixValue = { feature: string; label: string; n: number; delta: number };
export type Estimate = { chaos: number; lo: number; hi: number; support: number; informative: number; rmse: number; drivers: { label: string; delta: number }[] };

export const MIN_TRAIN = 150; // listings needed before the model is used at all
export const MIN_SUPPORT = 80; // listings of a slot needed before we trust it to skip searches there
export const MIN_INFORMATIVE = 40; // ...of which this many must be informative: priced above the market floor
export const RETRAIN_EVERY = 50; // new listings
// bump when training changes (data selection, weights): a saved model of another version is retrained
const MODEL_VERSION = 5;
// Asks above the cheapest few are often hopeful and never sell, so the mean of asks overprices: fit
// to the cheap end instead. Tested against our own items' trade prices (held out): squared loss
// guessed ×1.66 too high on average; 0.15-0.25 brought that to ~×1.1 and the typical miss from ×3.5 to ×3.2.
export const EXPECTILE = 0.2;

// More of these is never worth less: rolled values, life/res totals, defences, DPS, tier quality,
// open affixes, links. Free: lines where more is worse or unclear ("reduced", "taken", costs,
// requirements, a cluster's passive count: fewer passives is the dearer jewel), flags, one-hots.
const WORSE_WITH_MORE = /reduced|less\b|taken|Cost|Requirement|Adds # Passive Skills|(?:^|: )-|Duration on you/i;
export function monotoneOf(feature: string, label = ''): number {
  if (/^(?:pdps|edps|dps|t1|t2|openPrefix|openSuffix|links)$/.test(feature)) return 1;
  if (/^(?:tq:)?(?:explicit|implicit|enchant|crafted|pseudo|fractured)\.|^(?:tq:)?prop:/.test(feature)) return WORSE_WITH_MORE.test(label) ? 0 : 1;
  return 0;
}

// The cheapest few results of a broad search are the market floor: true prices, but only of the
// cheapest items, so a model fed mostly those learns that everything is cheap. A listing is
// informative when it came from a specific search (few matches) or from further up the price list.
const SPECIFIC = 100;
export function informative(o: ListingObs, q: QueryInfo | undefined): boolean {
  return (o.rank ?? 0) >= 10 || (!!q && q.filters > 0 && q.total <= SPECIFIC);
}
// Training weight: floor samples count less, a base-type-only search's floor least of all.
export function sampleWeight(o: ListingObs, q: QueryInfo | undefined): number {
  if (!q || informative(o, q)) return 1;
  return q.filters === 0 ? 0.25 : q.total > 1000 ? 0.5 : 1;
}
const file = join(import.meta.dirname, '..', 'data', `model-${config.league}.json`);

let saved: Saved | null = null;
const loaded = readFile(file, 'utf8').then((s) => void (saved = JSON.parse(s)), () => undefined);
const feats = new Map<string, Features>(); // listing id -> features (per process; feature code may change)

// A stored listing's features, computed once per process (also used by the dominance check).
export function listingFeatures(o: ListingObs, stats: Awaited<ReturnType<typeof getStats>>, db: Awaited<ReturnType<typeof loadModDb>> | null): Features | null {
  let x = feats.get(o.id);
  if (!x) {
    try {
      x = featuresOf(o.item, analyzeItem(o.item, stats, db));
    } catch {
      return null;
    }
    feats.set(o.id, x);
  }
  return x;
}

export async function affixValues(): Promise<Record<string, AffixValue[]> | null> {
  await loaded;
  if (saved && !saved.affixes) await retrain(true); // model saved before affix values existed
  return saved?.affixes ?? null;
}

export async function modelInfo() {
  await loaded;
  if (!saved) return null;
  const { model, labels, affixes, ...rest } = saved;
  return { ...rest, trees: model.trees.length, features: model.features.length };
}

// stat-like features (mods, tiers excluded); slot/base/ilvl/score features are not "affixes"
const AFFIX_FEATURE = /^(?:explicit|implicit|enchant|fractured|crafted|pseudo|text)[.:]/;
export const ALL = 'all';
// stable 20% holdout, by the item a search was for (or the search): listings of one search, and of
// the several searches for one item, are near-twins, so splitting them would test the model on
// copies of what it trained on (that read ×4 typical error where the honest figure was ×5.5)
const isVal = (key: string) => createHash('sha1').update(key).digest()[0] % 5 === 0;
const rmse = (e: number[]) => (e.length ? Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length) : null);

export async function retrain(force = false): Promise<Saved | null> {
  await loaded;
  const all = (await allListings()).filter((o) => priceable(o.item));
  if (all.length < MIN_TRAIN) return null;
  if (!force && saved && saved.version === MODEL_VERSION && all.length - saved.trainedOn < RETRAIN_EVERY) return saved;
  const t0 = Date.now();
  const [stats, db, qi, owned] = await Promise.all([getStats(), loadModDb().catch(() => null), queryInfo(), ownPrices()]);
  const samples: { id: string; query: string; x: Features; y: number; w: number; info: boolean }[] = [];
  for (const o of all) {
    const x = listingFeatures(o, stats, db);
    if (!x) continue;
    const q = qi.get(o.query);
    // rares/magics: only instant-buyout asks are real offers; others are often price-fixing bait
    if (q && q.status !== 'securable') continue;
    samples.push({ id: o.id, query: q?.own || o.query || o.id, x, y: Math.log(o.chaos), w: sampleWeight(o, q), info: informative(o, q) });
  }

  // vocabulary: features seen on at least 3 items
  const count = new Map<string, number>();
  const labels: Record<string, string> = {};
  for (const s of samples) for (const k in s.x.f) (count.set(k, (count.get(k) ?? 0) + 1), (labels[k] ??= s.x.labels[k] ?? k));
  const features = [...count].filter(([, c]) => c >= 3).map(([k]) => k);

  // holdout metrics: how far off (in log-chaos) on items the model never saw, vs. guessing the mean
  const tr = samples.filter((s) => !isVal(s.query));
  const va = samples.filter((s) => isVal(s.query));
  const monotone = (k: string) => monotoneOf(k, labels[k]);
  const m1 = train(tr.map((s) => s.x.f), tr.map((s) => s.y), features, { weights: tr.map((s) => s.w), expectile: EXPECTILE, monotone });
  const mean = tr.reduce((a, s) => a + s.y, 0) / Math.max(1, tr.length);
  const slots: Record<string, SlotMetrics> = {};
  const err: number[] = [], base: number[] = [];
  const bySlot = new Map<string, { e: number[]; b: number[] }>();
  for (const s of va) {
    const e = predict(m1, s.x.f) - s.y;
    err.push(e), base.push(mean - s.y);
    const g = bySlot.get(s.x.slot) ?? { e: [], b: [] };
    g.e.push(e), g.b.push(mean - s.y);
    bySlot.set(s.x.slot, g);
  }
  for (const s of samples) slots[s.x.slot] ??= { n: 0, val: 0, rmse: null, baseline: null, informative: 0 };
  for (const s of samples) (slots[s.x.slot].n++, s.info && (slots[s.x.slot].informative! += 1));
  for (const [slot, g] of bySlot) Object.assign(slots[slot], { val: g.e.length, rmse: rmse(g.e), baseline: rmse(g.b) });
  // the number that matters: our held-out items, model guess vs the trade price we settled on
  const own: number[] = [];
  for (const p of owned) {
    if (!isVal(p.own) || p.status !== 'securable' || !priceable(p.item)) continue;
    try {
      own.push(predict(m1, featuresOf(p.item, analyzeItem(p.item, stats, db)).f) - Math.log(p.chaos));
    } catch {}
  }
  const vsTrade = own.length >= 10
    ? { n: own.length, rmse: rmse(own)!, bias: own.reduce((a, b) => a + b, 0) / own.length, within2: own.filter((e) => Math.abs(e) <= Math.LN2).length / own.length }
    : null;

  // final model on everything; per-slot importance = mean |contribution| over that slot's items
  const model = train(samples.map((s) => s.x.f), samples.map((s) => s.y), features, { weights: samples.map((s) => s.w), expectile: EXPECTILE, monotone });
  const imp = new Map<string, Map<string, number>>();
  const aff = new Map<string, Map<string, { n: number; sum: number }>>(); // slot -> feature -> signed effect
  for (const s of samples) {
    const m = imp.get(s.x.slot) ?? new Map<string, number>();
    for (const [k, v] of Object.entries(contributions(model, s.x.f).byFeature)) {
      m.set(k, (m.get(k) ?? 0) + Math.abs(v));
      if (!AFFIX_FEATURE.test(k) || !(k in s.x.f)) continue;
      for (const slot of [s.x.slot, ALL]) {
        const g = aff.get(slot) ?? new Map<string, { n: number; sum: number }>();
        const e = g.get(k) ?? { n: 0, sum: 0 };
        e.n++, e.sum += v;
        g.set(k, e), aff.set(slot, g);
      }
    }
    imp.set(s.x.slot, m);
  }
  const affixes: Record<string, AffixValue[]> = {};
  for (const [slot, g] of aff) {
    affixes[slot] = [...g]
      .filter(([, e]) => e.n >= 3)
      .map(([feature, e]) => ({ feature, label: labels[feature] ?? feature, n: e.n, delta: Math.round((e.sum / e.n) * 1000) / 1000 }))
      .sort((a, b) => b.delta - a.delta);
  }
  const importance: Saved['importance'] = {};
  for (const [slot, m] of imp) {
    importance[slot] = [...m]
      .map(([feature, v]) => ({ feature, label: labels[feature] ?? feature, impact: Math.round((v / slots[slot].n) * 1000) / 1000 }))
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 20);
  }

  saved = { version: MODEL_VERSION, at: Date.now(), trainedOn: all.length, metrics: { rmse: rmse(err), baseline: rmse(base), slots, vsTrade }, importance, affixes, labels, model };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(saved));
  const vt = vsTrade ? `, vs trade price ×${Math.exp(vsTrade.rmse).toFixed(2)} (bias ×${Math.exp(vsTrade.bias).toFixed(2)}, n ${vsTrade.n})` : '';
  console.log(`[model] trained on ${samples.length} listings, ${features.length} features, holdout rmse ${saved.metrics.rmse?.toFixed(2)} (mean-guess ${saved.metrics.baseline?.toFixed(2)})${vt} in ${Date.now() - t0}ms`);
  return saved;
}

export async function estimate(item: any, a: Analysis): Promise<Estimate | null> {
  await loaded;
  if (!saved || !priceable(item)) return null;
  const x = featuresOf(item, a);
  const sm = saved.metrics.slots[x.slot];
  if (!sm) return null;
  const err = sm.rmse != null && sm.val >= 10 ? sm.rmse : saved.metrics.rmse ?? 1;
  const p = predict(saved.model, x.f);
  const c = contributions(saved.model, x.f);
  const drivers = Object.entries(c.byFeature)
    .filter(([, v]) => Math.abs(v) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 6)
    .map(([k, v]) => ({ label: saved!.labels[k] ?? x.labels[k] ?? k, delta: Math.round(v * 100) / 100 }));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { chaos: r1(Math.exp(p)), lo: r1(Math.exp(p - err)), hi: r1(Math.exp(p + err)), support: sm.n, informative: sm.informative ?? 0, rmse: Math.round(err * 100) / 100, drivers };
}

// Confident it's vendor trash, so a trade search can be saved: the slot has enough data beyond the
// market floor, even the optimistic end is cheap, and the rules see nothing worth checking on it.
export function isTrash(e: Estimate | null, a: Analysis): boolean {
  if (!e || e.support < MIN_SUPPORT || (e.informative ?? 0) < MIN_INFORMATIVE || e.hi >= config.trashChaos) return false;
  return (a.useCraft ? a.craftedVerdict : a.verdict) === 'skip';
}
