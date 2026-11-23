import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goodRoll, learnWeights, probeBody, type ProbeResult } from '../src/explore.ts';
import { modWeight, setLearned } from '../src/valuation.ts';
import { analyzeItem, indexStats } from '../src/query.ts';

test('a good roll is the upper quarter of the rolls seen, or near ours when seen rarely', () => {
  assert.equal(goodRoll([10, 20, 30, 40, 50, 60, 70, 80]), 70);
  assert.equal(goodRoll([42]), 37); // whole numbers from 10 up
  assert.equal(goodRoll([4.4, 5.5]), 4.9);
});

test('probe: any non-unique of the slot (or the viscera type) with the affixes, instant buyout, cheapest first', () => {
  const ring = probeBody({ slot: 'ring', type: null }, [{ statId: 'explicit.stat_1', min: 30 }, { statId: 'pseudo.pseudo_total_life', min: 60 }]).query;
  assert.equal(ring.status.option, 'securable');
  assert.deepEqual(ring.filters.type_filters.filters, { category: { option: 'accessory.ring' }, rarity: { option: 'nonunique' } });
  assert.deepEqual(ring.stats[0].filters.map((f: any) => [f.id, f.value.min]), [['explicit.stat_1', 30], ['pseudo.pseudo_total_life', 60]]);
  const head = probeBody({ slot: 'viscera', type: "Soldier's Head" }, [{ statId: 'implicit.stat_2', min: 101 }]).query;
  assert.equal(head.type, "Soldier's Head");
  assert.equal(head.filters.type_filters, undefined);
});

const P = (slot: any, parts: [string, string][], floor: number | null, total = 1000): ProbeResult => ({
  key: `${slot}|${parts.map((p) => p[0]).join('+')}`, slot, type: null, parts: parts.map(([statId, text]) => ({ statId, text, affix: null, min: 1 })),
  total, floor, median: floor, asks: [], link: '', at: 0,
});
const LIFE: [string, string] = ['pseudo.pseudo_total_life', '+# total maximum Life'];
const AS: [string, string] = ['explicit.stat_as', '#% increased Attack Speed'];
const MANA: [string, string] = ['explicit.stat_mana', '+# to maximum Mana'];
const GEM: [string, string] = ['explicit.stat_gem', '+# to Level of all Skill Gems'];

test('probe floors become weights: alone, in combination, and cheap even with life', () => {
  const w = learnWeights([
    P('amulet', [GEM], 120), // a good roll alone sells high: key line
    P('gloves', [LIFE], 0.2), P('gloves', [AS], 1), P('gloves', [AS, LIFE], 15), // worthless alone, valuable together
    P('ring', [MANA], 0.1, 5000), P('ring', [LIFE], 0.3), P('ring', [MANA, LIFE], 0.2, 800), // cheap even with life
  ]);
  assert.equal(w.get('amulet|explicit.stat_gem')!.min, 3);
  assert.equal(w.get('gloves|explicit.stat_as')!.min, 2);
  assert.match(w.get('gloves|explicit.stat_as')!.why, /15c/);
  assert.equal(w.has('gloves|pseudo.pseudo_total_life'), false); // totals keep their own weighting
  assert.equal(w.get('ring|explicit.stat_mana')!.max, 1);
});

test('no call without evidence: a pair without both parts probed alone, or a small market', () => {
  const w = learnWeights([P('gloves', [AS, LIFE], 15), P('ring', [MANA], 0.1, 50), P('ring', [MANA, LIFE], 0.2)]);
  assert.equal(w.size, 0);
});

test('learned weights move the rule weight before the tier nudge, and say why', () => {
  const ctx = { slot: 'ring' as const, defences: new Set<any>() };
  assert.equal(modWeight('+# to maximum Mana', [60], ctx, undefined, 'explicit.stat_mana'), 1);
  setLearned(new Map([['ring|explicit.stat_mana', { min: 3, why: 'test' }]]));
  try {
    assert.equal(modWeight('+# to maximum Mana', [60], ctx, undefined, 'explicit.stat_mana'), 3);
    assert.equal(modWeight('+# to maximum Mana', [60], ctx, undefined, 'fractured.stat_mana'), 3); // same stat when fractured
    assert.equal(modWeight('+# to maximum Mana', [60], ctx, { tier: 7, tiers: 8 }, 'explicit.stat_mana'), 1); // a bad roll stays minor
    const stats = indexStats({ result: [{ entries: [{ id: 'explicit.stat_mana', text: '+# to maximum Mana', type: 'explicit' }] }] });
    const a = analyzeItem({ frameType: 2, baseType: 'Gold Ring', typeLine: 'Gold Ring', explicitMods: ['+60 to maximum Mana'] }, stats);
    assert.equal(a.mods[0].weight, 3);
    assert.equal(a.mods[0].learned, 'test');
  } finally {
    setLearned(new Map());
  }
});
