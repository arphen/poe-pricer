import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegexes, LIMIT } from '../src/regex.ts';
import { levelFor, priceLevels } from '../src/sell.ts';

const rare = (id: string, name: string, base: string, mods: string[], extra: any = {}) => ({ id, frameType: 2, rarity: 'Rare', name, typeLine: base, baseType: base, ilvl: 80, explicitMods: mods, ...extra });

// what the stash search could see of an item, flattened (no ids, icons)
const text = (it: any) => {
  const out: string[] = [];
  const walk = (v: any, k = '') => {
    if (['id', 'icon'].includes(k)) return;
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, kk);
  };
  walk(it);
  return out.join('\n');
};
const lit = (strings: string[], it: any) => strings.some((s) => new RegExp(s.slice(1, -1), 'i').test(text(it)));

const stash = [
  rare('a', 'Doom Spiral', 'Leather Belt', ['+80 to maximum Life', '+40% to Fire Resistance']),
  rare('b', 'Doom Grip', 'Leather Belt', ['+81 to maximum Life', '+35% to Cold Resistance']),
  rare('c', 'Gale Spiral', 'Heavy Belt', ['+30 to Strength', '+38% to Fire Resistance']),
  rare('d', 'Kraken Bite', 'Two-Stone Ring', ['+12% to all Elemental Resistances', 'Adds 3 to 7 Physical Damage to Attacks']),
  rare('e', 'Hypnotic Eye', 'Cobalt Jewel', ['7% increased maximum Life', '+11% to Cold Resistance']),
  // twin of "a" except one roll: only the roll can tell them apart
  rare('f', 'Doom Spiral', 'Leather Belt', ['+80 to maximum Life', '+41% to Fire Resistance']),
  { id: 'g', frameType: 5, typeLine: 'Chaos Orb', baseType: 'Chaos Orb', stackSize: 12, properties: [{ name: 'Stack Size', values: [['12/40', 0]] }], descrText: 'Right click to use' },
  { id: 'h', frameTypeId: 'Viscera', frameType: 15, typeLine: "Cutthroat's Head", baseType: "Cutthroat's Head", implicitMods: [{ description: '24% increased Global Physical Damage' }], descrText: 'Take this to the Wickerman in a town or hideout to attach it.' },
  { id: 'i', frameTypeId: 'Viscera', frameType: 15, typeLine: "Cutthroat's Head", baseType: "Cutthroat's Head", implicitMods: [{ description: '20% increased Global Physical Damage' }], descrText: 'Take this to the Wickerman in a town or hideout to attach it.' },
];

test('each group lights up all its items and nothing else in the stash', () => {
  const groups = [['a', 'd'], ['b', 'e', 'h'], ['c', 'f']];
  const res = buildRegexes(stash, groups);
  res.forEach((r, g) => {
    assert.deepEqual(r.missing, []);
    assert.equal(r.count, groups[g].length);
    for (const s of r.strings) assert.ok(s.length <= LIMIT && s.startsWith('"') && s.endsWith('"'), s);
    for (const it of stash) assert.equal(lit(r.strings, it), groups[g].includes(it.id), `${r.strings} vs ${it.id}`);
  });
});

test('twins that differ by a single roll are told apart by the roll', () => {
  const [r] = buildRegexes(stash, [['a']]);
  assert.ok(lit(r.strings, stash[0]));
  assert.ok(!lit(r.strings, stash[5]));
  assert.match(r.strings.join(''), /40/);
});

test('identical items in different groups cannot be separated: reported, never mis-lit', () => {
  const twin = { ...stash[0], id: 'a2' };
  const [r] = buildRegexes([...stash, twin], [['a']]);
  assert.deepEqual(r.missing, ['Doom Spiral']);
  assert.ok(!lit(r.strings, twin));
});

test('fragments avoid what every item shows (rarity, item class, requirements)', () => {
  const [r] = buildRegexes(stash, [['a', 'b', 'c', 'd', 'e', 'f', 'h', 'i']]);
  const frags = r.strings.flatMap((s) => s.slice(1, -1).split('|'));
  for (const f of frags) for (const bad of ['rare', 'rarity', 'item', 'level', 'requires', 'belt']) assert.ok(!bad.includes(f), `${f} sits in "${bad}"`);
});

test('many targets pack into few strings', () => {
  const many = Array.from({ length: 40 }, (_, k) => rare(`m${k}`, `Name${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + Math.floor(k / 26))}x Bind`, 'Iron Ring', [`+${10 + k} to Strength`]));
  const [r] = buildRegexes(many, [many.slice(0, 30).map((m) => m.id)]);
  assert.deepEqual(r.missing, []);
  for (const it of many) assert.equal(lit(r.strings, it), many.indexOf(it) < 30);
  assert.ok(r.strings.length <= 4, `${r.strings.length} strings`);
});

test('price levels: round chaos below a divine, divines above, item goes to the level at or under its price', () => {
  const lv = priceLevels(20, 'normal', 200);
  assert.deepEqual(lv.slice(0, 4).map((l) => l.amount), [20, 25, 30, 40]);
  assert.ok(lv.every((l) => l.currency === 'divine' || l.chaos < 200));
  assert.equal(levelFor(19.9, lv), null);
  assert.equal(levelFor(20, lv)!.amount, 20);
  assert.equal(levelFor(34, lv)!.amount, 30);
  assert.deepEqual(levelFor(310, lv), { chaos: 300, amount: 1.5, currency: 'divine' });
  // a custom floor becomes the first level
  assert.equal(priceLevels(35, 'coarse', 200)[0].amount, 35);
  assert.equal(levelFor(45, priceLevels(35, 'coarse', 200))!.amount, 35);
});
