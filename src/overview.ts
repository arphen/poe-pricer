// Read-only summary of what has been learned so far: how much data is stored, how well the model
// does per slot, which affixes it values most/least, and what the priced stash looks like.
import { datasetStats, allListings, obsFile } from './dataset.ts';
import { ALL, MIN_SUPPORT, MIN_TRAIN, RETRAIN_EVERY, affixValues, modelInfo } from './model.ts';
import { getPrices } from './scanner.ts';
import { slotOf } from './valuation.ts';
import { stat } from 'node:fs/promises';

const RARITY = ['normal', 'magic', 'rare', 'unique'];
const BUCKETS: [string, number][] = [['<1c', 1], ['1-5c', 5], ['5-20c', 20], ['20-100c', 100], ['100c+', Infinity]];
const TOP = 15;

const quantile = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

export async function overview() {
  const [listings, ds, info, aff, prices, size] = await Promise.all([
    allListings(),
    datasetStats(),
    modelInfo(),
    affixValues().catch(() => null),
    getPrices(),
    stat(obsFile).then((s) => s.size, () => 0),
  ]);

  // --- stored listings ---
  const bySlot: Record<string, { n: number; median: number | null; p90: number | null; ready: boolean; error: number | null }> = {};
  const group: Record<string, number[]> = {};
  const rarity: Record<string, number> = {};
  const buckets = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
  let oldest = Infinity, newest = 0;
  for (const o of listings) {
    const slot = slotOf(o.item);
    (group[slot] ??= []).push(o.chaos);
    const rn = RARITY[o.item?.frameType] ?? 'other';
    rarity[rn] = (rarity[rn] ?? 0) + 1;
    buckets[BUCKETS.find(([, hi]) => o.chaos < hi)![0]]++;
    oldest = Math.min(oldest, o.at), newest = Math.max(newest, o.at);
  }
  for (const [slot, v] of Object.entries(group)) {
    v.sort((a, b) => a - b);
    const sm = info?.metrics.slots[slot];
    bySlot[slot] = { n: v.length, median: r1(quantile(v, 0.5)), p90: r1(quantile(v, 0.9)), ready: v.length >= MIN_SUPPORT, error: sm?.rmse != null ? Math.round(Math.exp(sm.rmse) * 100) / 100 : null };
  }

  // --- learned affix values ---
  const view = (list: { feature: string; label: string; n: number; delta: number }[] = []) => {
    const fmt = (a: (typeof list)[number]) => ({ label: a.label, n: a.n, factor: Math.round(Math.exp(a.delta) * 100) / 100 });
    return {
      count: list.length,
      high: list.filter((a) => a.delta > 0.05).slice(0, TOP).map(fmt),
      low: list.filter((a) => a.delta < -0.05).slice(-TOP).reverse().map(fmt),
      neutral: list.filter((a) => Math.abs(a.delta) <= 0.05).length,
    };
  };
  const affixes = aff ? Object.fromEntries(Object.entries(aff).map(([slot, l]) => [slot, view(l)])) : null;

  // --- priced stash ---
  const ps = Object.values(prices);
  const priced = ps.filter((p) => p.chaos != null);
  const stash = {
    items: ps.length,
    byTrade: ps.filter((p) => p.source === 'trade').length,
    byModel: ps.filter((p) => p.source === 'model').length,
    noComparables: ps.filter((p) => p.chaos == null).length,
    totalChaos: Math.round(priced.reduce((a, p) => a + (p.chaos ?? 0), 0)),
    top: priced.toSorted((a, b) => b.chaos! - a.chaos!).slice(0, 8).map((p) => ({ name: p.name, chaos: p.chaos, tab: p.tab, source: p.source, link: p.link })),
  };

  return {
    data: {
      listings: ds.listings,
      queries: ds.queries,
      fileMB: Math.round(size / 1e5) / 10,
      oldest: Number.isFinite(oldest) ? oldest : null,
      newest: newest || null,
      rarity,
      buckets,
      slots: bySlot,
    },
    model: info && {
      at: info.at,
      trainedOn: info.trainedOn,
      trees: info.trees,
      features: info.features,
      error: info.metrics.rmse != null ? Math.round(Math.exp(info.metrics.rmse) * 100) / 100 : null,
      baseline: info.metrics.baseline != null ? Math.round(Math.exp(info.metrics.baseline) * 100) / 100 : null,
      vsTrade: info.metrics.vsTrade ? { n: info.metrics.vsTrade.n, error: Math.round(Math.exp(info.metrics.vsTrade.rmse) * 100) / 100, bias: Math.round(Math.exp(info.metrics.vsTrade.bias) * 100) / 100, within2: Math.round(info.metrics.vsTrade.within2 * 100) } : null,
      pendingListings: Math.max(0, ds.listings - info.trainedOn),
    },
    thresholds: { minTrain: MIN_TRAIN, minSupport: MIN_SUPPORT, retrainEvery: RETRAIN_EVERY },
    all: ALL,
    affixes,
    stash,
  };
}
