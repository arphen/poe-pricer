import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeItem, buildQuery, contribution, dpsWithCraft, indexStats, normalizeMod, weaponDps } from '../src/query.ts';

const stats = indexStats({
  result: [
    {
      entries: [
        { id: 'explicit.stat_life', text: '+# to maximum Life', type: 'explicit' },
        { id: 'explicit.stat_fire', text: '+#% to Fire Resistance', type: 'explicit' },
        { id: 'explicit.stat_armour', text: '+# to Armour', type: 'explicit' },
        { id: 'explicit.stat_armour_local', text: '+# to Armour (Local)', type: 'explicit' },
        { id: 'explicit.stat_ms', text: '#% increased Movement Speed', type: 'explicit' },
      ],
    },
  ],
});

const sel = (a: any, extra = {}) => ({ mods: a.mods.map((m: any) => ({ key: m.key, enabled: m.enabled, min: m.min, max: null })), ilvlMin: null, linksMin: null, corrupted: 'any' as const, matchAtLeast: null, ...extra });

test('normalizeMod replaces numbers, strips [Tag|Text] markup', () => {
  assert.deepEqual(normalizeMod('Adds 5 to 10 Physical Damage'), { norm: 'Adds # to # Physical Damage', values: [5, 10] });
  assert.deepEqual(normalizeMod('+9% to [PlayerItemRarity|Item Rarity]'), { norm: '+#% to Item Rarity', values: [9] });
});

test('pseudo contributions', () => {
  assert.deepEqual(contribution('+#% to Fire and Cold Resistances', [12]), { life: 0, ele: 24, chaos: 0 });
  assert.deepEqual(contribution('+#% to Lightning and Chaos Resistances', [19]), { life: 0, ele: 19, chaos: 19 });
  assert.deepEqual(contribution('+# to Strength', [30]), { life: 15, ele: 0, chaos: 0 });
});

const boots = {
  frameType: 2, name: 'Doom Stride', baseType: 'Slink Boots', typeLine: 'Slink Boots', ilvl: 84,
  properties: [{ name: 'Evasion Rating', values: [['300', 1]] }],
  implicitMods: [],
  explicitMods: [
    { description: '+95 to maximum Life' },
    { description: '+42% to Fire Resistance' },
    { description: '30% increased Movement Speed' },
    { description: '+21% to Cold Resistance', flags: { crafted: true } },
  ],
};

test('life and res fold into pseudo totals; crafted lines never ticked', () => {
  const a = analyzeItem(boots, stats);
  const life = a.mods.find((m) => m.key === 'pseudo:life')!;
  const ele = a.mods.find((m) => m.key === 'pseudo:ele')!;
  assert.equal(life.values[0], 95);
  assert.equal(life.enabled, true);
  assert.equal(ele.values[0], 63); // 42 + crafted 21: the trade site counts crafted mods too
  assert.equal(ele.weight, 1); // ...but value is judged without the bench craft (42)
  const fire = a.mods.find((m) => m.text.includes('Fire'))!;
  assert.equal(fire.covered, 'pseudo:ele');
  assert.equal(fire.enabled, false);
  assert.equal(a.mods.find((m) => m.type === 'crafted')!.enabled, false);
  assert.equal(a.mods.find((m) => m.text.includes('Movement'))!.enabled, true);
});

test('buildQuery: pseudo stats, property filters, count group', () => {
  const a = analyzeItem(boots, stats);
  const q = buildQuery(boots, a, sel(a)).query;
  assert.equal(q.type, 'Slink Boots');
  // movement speed on boots is required: its own "and" group, outside "match at least"
  assert.deepEqual(q.stats[0], { type: 'and', filters: [{ id: 'explicit.stat_ms', value: { min: 27 }, disabled: false }] });
  assert.deepEqual(q.stats[1].filters.map((f: any) => f.id), ['pseudo.pseudo_total_life']);

  const ring = { frameType: 2, baseType: 'Gold Ring', explicitMods: ['+70 to maximum Life'] };
  const ra = analyzeItem(ring, stats);
  assert.equal(ra.searchBy, 'category');
  const rq = buildQuery(ring, ra, sel(ra)).query;
  assert.equal(rq.type, undefined);
  assert.equal(rq.filters.type_filters.filters.category.option, 'accessory.ring');
});

test('uniques search by name and type with no stat filters by default', () => {
  const u = { frameType: 3, name: '<<set:MS>>Headhunter', baseType: 'Leather Belt', typeLine: 'Leather Belt', explicitMods: ['+40 to maximum Life'] };
  const a = analyzeItem(u, stats);
  const q = buildQuery(u, a, sel(a)).query;
  assert.equal(q.name, 'Headhunter');
  assert.equal(q.type, 'Leather Belt');
  assert.equal(q.stats[0].filters.length, 0);
});

test('rares are priced from instant-buyout listings only', () => {
  const a = analyzeItem(boots, stats);
  // 'securable' is the trade API's Merchant Only (instant buyout) status
  assert.equal(buildQuery(boots, a, sel(a)).query.status.option, 'securable');
  const u = { frameType: 3, name: 'Headhunter', baseType: 'Leather Belt', typeLine: 'Leather Belt', explicitMods: ['+40 to maximum Life'] };
  const ua = analyzeItem(u, stats);
  assert.equal(buildQuery(u, ua, sel(ua)).query.status.option, 'online');
});

test('weapon dps and dps after a bench craft', () => {
  const axe = {
    properties: [
      { name: 'Quality', values: [['+20%', 1]] },
      { name: 'Physical Damage', values: [['100-200', 1]] },
      { name: 'Elemental Damage', values: [['10-20', 4]] },
      { name: 'Attacks per Second', values: [['1.50', 1]] },
    ],
  };
  const d = weaponDps(axe)!;
  assert.equal(d.pdps, 225);
  assert.equal(d.edps, 22.5);
  // +100% phys on a weapon with 20% quality and no % phys: x (1+.2+1)/(1+.2)
  const after = dpsWithCraft(d, [{ norm: '#% increased Physical Damage', ranges: [[100, 100]] }], 0, 0);
  assert.equal(after.pdps, Math.round(225 * (2.2 / 1.2) * 10) / 10);
});

test('price estimate: the cheapest buyout listing; few listed or few matches is a guess', async () => {
  const { estimate } = await import('../src/scanner.ts');
  assert.deepEqual(estimate([]), { chaos: null, confidence: 'none' });
  assert.deepEqual(estimate([9, 5]), { chaos: 5, confidence: 'low' });
  assert.deepEqual(estimate([95, 160, 428, 428, 642, 642, 1070], 7), { chaos: 95, confidence: 'low' }); // 7 matches: thin
  assert.deepEqual(estimate([1, 10, 11, 12, 13], 400), { chaos: 1, confidence: 'ok' });
});

test('magic items: scored like gear, searched against magic items only', () => {
  const ring = { frameType: 1, baseType: 'Gold Ring', typeLine: 'Hale Gold Ring of the Furnace', explicitMods: ['+70 to maximum Life', '+40% to Fire Resistance'] };
  const a = analyzeItem(ring, stats);
  assert.ok(a.mods.some((m) => m.key === 'pseudo:life'));
  assert.notEqual(a.verdict, 'n/a');
  const q = buildQuery(ring, a, sel(a)).query;
  assert.equal(q.status.option, 'securable');
  assert.equal(q.filters.type_filters.filters.rarity.option, 'magic');
});
