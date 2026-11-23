import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeItem, indexStats } from '../src/query.ts';
import { featuresOf } from '../src/features.ts';
import { dominates, needsOf } from '../src/dominance.ts';
import { train, predict } from '../src/gbdt.ts';

const stats = indexStats({ result: [{ entries: [
  { id: 'explicit.stat_life', text: '+# to maximum Life', type: 'explicit' },
  { id: 'explicit.stat_cold', text: '+#% to Cold Resistance', type: 'explicit' },
  { id: 'explicit.stat_mana', text: '+# to maximum Mana', type: 'explicit' },
  { id: 'explicit.stat_light', text: '#% increased Light Radius', type: 'explicit' },
] }] });
const ring = (mods: string[], extra: any = {}) => ({ id: Math.random().toString(36), frameType: 2, baseType: 'Gold Ring', typeLine: 'Gold Ring', ilvl: 80, explicitMods: mods.map((description) => ({ description })), ...extra });
const feats = (it: any) => featuresOf(it, analyzeItem(it, stats));
const needs = (it: any) => needsOf(it, analyzeItem(it, stats), feats(it))!;

test('80 life 30 res is beaten by 100 life 30 res, not by 100 life 20 res', () => {
  const ours = needs(ring(['+80 to maximum Life', '+30% to Cold Resistance', '10% increased Light Radius']));
  assert.deepEqual(Object.keys(ours.lines).sort(), ['pseudo.pseudo_total_elemental_resistance', 'pseudo.pseudo_total_life']); // junk light radius not needed
  assert.ok(dominates(feats(ring(['+100 to maximum Life', '+30% to Cold Resistance'])), ours));
  assert.ok(!dominates(feats(ring(['+100 to maximum Life', '+20% to Cold Resistance'])), ours));
});

test('no worse in kind: corrupted, other slot, missing a rated line', () => {
  const ours = needs(ring(['+80 to maximum Life', '+30% to Cold Resistance', '+60 to maximum Mana']));
  assert.ok(!dominates(feats(ring(['+100 to maximum Life', '+40% to Cold Resistance'])), ours), 'mana is rated on rings: must be matched');
  assert.ok(!dominates(feats(ring(['+100 to maximum Life', '+40% to Cold Resistance', '+70 to maximum Mana'], { corrupted: true })), ours));
  const amulet = { ...ring(['+100 to maximum Life', '+40% to Cold Resistance', '+70 to maximum Mana']), baseType: 'Gold Amulet', typeLine: 'Gold Amulet' };
  assert.ok(!dominates(feats(amulet), ours));
  assert.ok(dominates(feats(ring(['+100 to maximum Life', '+40% to Cold Resistance', '+70 to maximum Mana'])), ours));
});

test('items hard to compare are left out', () => {
  assert.equal(needsOf(ring(['+80 to maximum Life'], { influences: { shaper: true } }), analyzeItem(ring(['+80 to maximum Life']), stats), feats(ring(['+80 to maximum Life'], { influences: { shaper: true } }))), null);
});

test('monotone trees: the prediction never falls as a constrained feature rises', () => {
  // noisy data where a free model would learn a dip in the middle
  const rows = Array.from({ length: 300 }, (_, i) => ({ life: i % 100 }));
  const y = rows.map((r, i) => r.life / 20 + (r.life > 40 && r.life < 60 ? -2 : 0) + Math.sin(i) * 0.3);
  const free = train(rows, y, ['life']);
  const mono = train(rows, y, ['life'], { monotone: () => 1 });
  const at = (m: any) => Array.from({ length: 100 }, (_, v) => predict(m, { life: v }));
  const rises = (p: number[]) => p.every((v, i) => i === 0 || v >= p[i - 1] - 1e-12);
  assert.ok(!rises(at(free)), 'the free model follows the dip');
  assert.ok(rises(at(mono)));
});
