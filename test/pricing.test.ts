import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeItem, buildQuery, describeSelection, dropOrder, indexStats } from '../src/query.ts';
import { verdictOf } from '../src/valuation.ts';
import { spreadIds } from '../src/trade.ts';
import { ladder } from '../src/scanner.ts';
import { informative, isTrash, sampleWeight } from '../src/model.ts';
import { loadModDb } from '../src/moddb.ts';
import { existsSync } from 'node:fs';
import { predict, train } from '../src/gbdt.ts';

const stats = indexStats({
  result: [
    {
      entries: [
        { id: 'explicit.stat_life', text: '+# to maximum Life', type: 'explicit' },
        { id: 'explicit.stat_mana', text: '+# to maximum Mana', type: 'explicit' },
        { id: 'explicit.stat_light', text: '#% increased Light Radius', type: 'explicit' },
        { id: 'explicit.stat_cold', text: '+#% to Cold Resistance', type: 'explicit' },
        { id: 'crafted.stat_cold', text: '+#% to Cold Resistance', type: 'crafted' },
        { id: 'explicit.stat_str', text: '+# to Strength', type: 'explicit' },
        { id: 'explicit.stat_es', text: '+# to maximum Energy Shield', type: 'explicit' },
        { id: 'explicit.stat_acc', text: '+# to Accuracy Rating', type: 'explicit' },
        { id: 'explicit.stat_ev', text: '+# to Evasion Rating', type: 'explicit' },
      ],
    },
  ],
});

// life (folds into the total), a minor line, a junk line and a bench craft; corrupted
const ring = {
  frameType: 2, baseType: 'Gold Ring', typeLine: 'Gold Ring', corrupted: true,
  explicitMods: [
    { description: '+70 to maximum Life' },
    { description: '+19 to maximum Mana' },
    { description: '10% increased Light Radius' },
    { description: '+20% to Cold Resistance', flags: { crafted: true } },
  ],
};
const statFilters = (body: any) => body.query.stats.flatMap((g: any) => g.filters).map((f: any) => f.id);

test('describeSelection searches the whole item: unticked and junk lines too, never crafted or folded ones', () => {
  const a = analyzeItem(ring, stats);
  const on = new Set(describeSelection(a).mods.filter((m) => m.enabled).map((m) => m.key));
  const key = (s: string) => a.mods.find((m) => m.type !== 'pseudo' && m.text.includes(s))!.key;
  assert.ok(on.has('pseudo:life') && on.has(key('Mana')) && on.has(key('Light Radius')));
  assert.ok(!on.has(key('maximum Life')), 'folded into the life total');
  assert.ok(!on.has(key('Cold')), 'bench craft');
  // corruption picks the market
  const q = buildQuery(ring, a, describeSelection(a)).query;
  assert.equal(q.filters.misc_filters.filters.corrupted.option, 'true');
  assert.equal(analyzeItem({ ...ring, corrupted: false }, stats).filters.corrupted, 'false');
});

test('dropOrder: lowest weight first, then the worse roll for its tier range; required lines stay', () => {
  const m = (key: string, weight: number, tier: number | null, tiers: number | null, extra = {}) => ({ key, weight, tier, tiers, statId: `s.${key}`, ...extra });
  const a: any = { mods: [m('life', 3, 1, 8), m('good', 1, 1, 9), m('bad', 1, 8, 9), m('junk', 0, null, null), m('ms', 2, 3, 6, { required: true })] };
  const sel: any = { mods: a.mods.map((x: any) => ({ key: x.key, enabled: true })) };
  assert.deepEqual(dropOrder(a, sel), ['junk', 'bad', 'good', 'life']);
});

test('ladder gives up the least important line per search until enough comparables', async () => {
  const a = analyzeItem(ring, stats);
  // the market: 4+ lines match nothing, 2 lines match 2 items, 1 line matches 50
  const market = async (body: any) => ({ total: [50, 50, 2, 0, 0][statFilters(body).length] ?? 0 });
  const thin: number[] = [];
  const r = await ladder(ring, a, market, async (_b, _r, d) => void thin.push(d));
  assert.deepEqual(thin, [0, 1, 2]); // whole item, then 3 and 2 lines: too few, but logged
  assert.equal(r.dropped, 3);
  assert.deepEqual(statFilters(r.body), ['pseudo.pseudo_total_life']); // the key line survives
  assert.equal(r.lost, 1); // mana was the best line given up
  // nothing listed at all: stops with one line left
  const none = await ladder(ring, a, async () => ({ total: 0 }), async () => {});
  assert.equal(statFilters(none.body).length, 1);
});

test('verdicts: one key mod is enough for maybe, minor lines count half', () => {
  assert.equal(verdictOf([3]).verdict, 'maybe');
  assert.equal(verdictOf([2, 2, 1, 1]).verdict, 'skip'); // 5 points
  assert.equal(verdictOf([2, 2, 1, 1, 1, 1]).verdict, 'maybe'); // 6 points
  assert.equal(verdictOf([0, 0, 0]).verdict, 'skip');
});

test('magic items: two lines at most, so one good line decides', () => {
  const magic = (mods: string[]) => analyzeItem({ frameType: 1, baseType: 'Gold Ring', typeLine: 'Gold Ring', explicitMods: mods }, stats);
  assert.equal(magic(['+70 to maximum Life']).verdict, 'check');
  assert.equal(magic(['+19 to maximum Mana']).verdict, 'skip');
});

test('spreadIds picks evenly past the cheapest, always including the last', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `i${i}`);
  const s = spreadIds(ids, 10, 10);
  assert.equal(s.length, 10);
  assert.equal(s[0], 'i10');
  assert.equal(s.at(-1), 'i99');
  assert.equal(new Set(s).size, 10);
  assert.deepEqual(spreadIds(ids.slice(0, 14), 10, 10), ['i10', 'i11', 'i12', 'i13']);
});

test('training: floor samples weigh less; the model only skips searches with data beyond the floor', () => {
  const l = (rank?: number): any => ({ rank });
  assert.equal(sampleWeight(l(), { total: 5000, filters: 0, status: 'securable' }), 0.25);
  assert.equal(sampleWeight(l(), { total: 5000, filters: 2, status: 'securable' }), 0.5);
  assert.equal(informative(l(), { total: 40, filters: 2, status: 'securable' }), true);
  assert.equal(informative(l(40), { total: 5000, filters: 0, status: 'securable' }), true); // further up the price list

  const e = (informative: number): any => ({ chaos: 0.5, lo: 0.2, hi: 1, support: 200, informative, rmse: 1, drivers: [] });
  const skip: any = { verdict: 'skip', useCraft: false };
  assert.equal(isTrash(e(10), skip), false); // only floor data so far
  assert.equal(isTrash(e(60), skip), true);
  assert.equal(isTrash(e(60), { ...skip, verdict: 'maybe' }), false); // rules see something: search it
});

test('weighted trees follow the weighted rows', () => {
  const rows: Record<string, number>[] = [];
  const y: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ f: 1 }), y.push(2), w.push(1);
    rows.push({ f: 1 }), y.push(10), w.push(0.01); // contradicting rows that barely count
    rows.push({}), y.push(0), w.push(1);
  }
  const m = train(rows, y, ['f'], { trees: 150, weights: w });
  assert.ok(Math.abs(predict(m, { f: 1 }) - 2) < 0.2);
  assert.ok(Math.abs(predict(m, {})) < 0.2);
});

// corrupted, so no room to craft life; +19 Str is all the life it has (9)
const lifeless = {
  frameType: 2, baseType: 'Two-Stone Ring', typeLine: 'Two-Stone Ring', corrupted: true,
  explicitMods: ['+19 to Strength', '+193 to Accuracy Rating', '+150 to Evasion Rating', '+30% to Cold Resistance'].map((description) => ({ description })),
};
const notGroup = (body: any) => body.query.stats.find((g: any) => g.type === 'not');

test('no life and no room to craft it: rings with real life are kept out of every search', async () => {
  const a = analyzeItem(lifeless, stats);
  const cap = a.mods.find((m) => m.key === 'cap:life')!;
  assert.ok(cap?.negate && cap.required && cap.enabled);
  assert.equal(cap.min, 25); // the least life that counts on a ring
  assert.deepEqual(notGroup(buildQuery(lifeless, a, describeSelection(a))).filters, [{ id: 'pseudo.pseudo_total_life', value: { min: 25 }, disabled: false }]);
  assert.ok(!dropOrder(a, describeSelection(a)).includes('cap:life'));
  // nothing listed at all: every real line but one is given up, the ceiling never is
  const none = await ladder(lifeless, a, async () => ({ total: 0 }), async () => {});
  assert.equal(notGroup(none.body).filters.length, 1);
  assert.equal(none.body.query.stats.filter((g: any) => g.type !== 'not').flatMap((g: any) => g.filters).length, 1);
});

test('life ceiling only when life is too low, cannot be crafted, and the piece is not for energy shield', () => {
  const cap = (it: any) => analyzeItem(it, stats).mods.some((m) => m.key === 'cap:life');
  assert.ok(!cap({ ...lifeless, explicitMods: [...lifeless.explicitMods, { description: '+60 to maximum Life' }] }));
  assert.ok(!cap({ ...lifeless, corrupted: false })); // without the mod db: room to craft unknown, so no ceiling
  assert.ok(!cap({ ...lifeless, explicitMods: [...lifeless.explicitMods, { description: '+40 to maximum Energy Shield' }] }));
});

// needs the RePoE-derived mod db (tiers); uses the local cache when present
const dbCache = new URL('../.cache/moddb-v3.json', import.meta.url);
test('a low-tier roll of a mod buyers pay for: well-rolled versions stay out of the search', { skip: !existsSync(dbCache) && 'no cached mod db' }, async () => {
  const db = await loadModDb();
  const s = indexStats({ result: [{ entries: [
    { id: 'explicit.stat_light_atk', text: 'Adds # to # Lightning Damage to Attacks', type: 'explicit' },
    { id: 'explicit.stat_phys_atk', text: 'Adds # to # Physical Damage to Attacks', type: 'explicit' },
    { id: 'explicit.stat_acc', text: '+# to Accuracy Rating', type: 'explicit' },
  ] }] });
  // the Entropy Coil: T8/9 lightning, T4/6 phys (both bottom band), T3/5 accuracy (a minor mod on rings)
  const coil = { frameType: 2, baseType: 'Two-Stone Ring', typeLine: 'Two-Stone Ring', ilvl: 77, implicitMods: [{ description: '+12% to Fire and Cold Resistances' }],
    explicitMods: ['+19 to Strength', 'Adds 4 to 7 Physical Damage to Attacks', 'Adds 1 to 15 Lightning Damage to Attacks', '+193 to Accuracy Rating', '+150 to Evasion Rating'].map((description) => ({ description })) };
  const a = analyzeItem(coil, s, db);
  const caps = a.mods.filter((m) => m.negate);
  const light = caps.find((m) => m.statId === 'explicit.stat_light_atk');
  assert.ok(light && light.min! > 8, 'lightning gets a ceiling above our roll');
  assert.ok(caps.some((m) => m.statId === 'explicit.stat_phys_atk'), 'bottom-band phys too');
  assert.ok(!caps.some((m) => m.statId === 'explicit.stat_acc'), 'a mod buyers do not pay for gets none');
  assert.ok(caps.some((m) => m.key === 'cap:life'), 'full prefixes: no room for life');
});
