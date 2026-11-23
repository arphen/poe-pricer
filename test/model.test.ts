import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contributions, predict, train } from '../src/gbdt.ts';
import { featuresOf } from '../src/features.ts';
import { analyzeItem, indexStats } from '../src/query.ts';

// deterministic pseudo-random
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test('boosted trees learn a threshold + additive price on sparse rows, ignore noise features', () => {
  // log price: +2 if life >= 80, +1 per open prefix; "noise" is unrelated; many rows lack features
  const rows: Record<string, number>[] = [];
  const y: number[] = [];
  for (let i = 0; i < 600; i++) {
    const r: Record<string, number> = {};
    if (rnd() < 0.7) r.life = Math.round(40 + rnd() * 60);
    if (rnd() < 0.5) r.open = 1 + Math.floor(rnd() * 2);
    if (rnd() < 0.5) r.noise = rnd() * 100;
    rows.push(r);
    y.push((r.life ?? 0) >= 80 ? 2 + (r.open ?? 0) : r.open ?? 0);
  }
  const m = train(rows, y, ['life', 'open', 'noise'], { trees: 150 });
  assert.ok(Math.abs(predict(m, { life: 95, open: 2 }) - 4) < 0.3);
  assert.ok(Math.abs(predict(m, { life: 50 }) - 0) < 0.3);
  assert.ok(Math.abs(predict(m, {}) - 0) < 0.3); // missing = 0 = no life

  const c = contributions(m, { life: 95, open: 2, noise: 50 });
  const sum = Object.values(c.byFeature).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(c.base + sum - predict(m, { life: 95, open: 2, noise: 50 })) < 1e-9); // exact decomposition
  assert.ok(c.byFeature.life > 1);
  assert.ok(Math.abs(c.byFeature.noise ?? 0) < 0.2);
});

test('features: pseudo totals, tiers, open affixes, slot, crafted marker', () => {
  const stats = indexStats({ result: [{ entries: [
    { id: 'explicit.stat_life', text: '+# to maximum Life', type: 'explicit' },
    { id: 'explicit.stat_fire', text: '+#% to Fire Resistance', type: 'explicit' },
    { id: 'crafted.stat_cold', text: '+#% to Cold Resistance', type: 'crafted' },
  ] }] });
  const ring = { frameType: 2, baseType: 'Gold Ring', ilvl: 80, explicitMods: ['+70 to maximum Life', '+40% to Fire Resistance', { description: '+20% to Cold Resistance', flags: { crafted: true } }] };
  const x = featuresOf(ring, analyzeItem(ring, stats));
  assert.equal(x.slot, 'ring');
  assert.equal(x.f['slot:ring'], 1);
  assert.equal(x.f['explicit.stat_life'], 70);
  assert.equal(x.f['pseudo.pseudo_total_life'], 70);
  assert.equal(x.f['pseudo.pseudo_total_elemental_resistance'], 60);
  assert.equal(x.f['crafted.stat_cold'], 20);
  assert.equal(x.f.crafted, 1);
  assert.equal(x.f.ilvl, 80);
  assert.equal(x.labels['explicit.stat_life'], '+# to maximum Life');
});
