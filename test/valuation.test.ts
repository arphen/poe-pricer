import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeItem, buildQuery, describeSelection, dropOrder, indexStats } from '../src/query.ts';
import { modWeight, slotOf, verdictOf, defencesOf, lifeWeight } from '../src/valuation.ts';

const ctx = (slot: any, ...d: any[]) => ({ slot, defences: new Set<any>(d) });

test('junk mods get weight 0', () => {
  for (const t of ['#% increased Stun and Block Recovery', '#% increased Light Radius', 'Reflects # Physical Damage to Melee Attackers', '#% reduced Attribute Requirements']) {
    assert.equal(modWeight(t, [10], ctx('gloves', 'dex')), 0, t);
  }
});

test('suppression is worth most on evasion bases, least on pure armour, and needs a real roll', () => {
  const t = '+#% chance to Suppress Spell Damage';
  assert.equal(modWeight(t, [14], ctx('boots', 'dex')), 3);
  assert.equal(modWeight(t, [14], ctx('boots', 'int')), 2);
  assert.equal(modWeight(t, [14], ctx('boots', 'str')), 1);
  assert.equal(modWeight(t, [6], ctx('boots', 'dex')), 1);
});

test('tiers: T1 bumps a useful mod, bottom tiers cap it', () => {
  assert.equal(modWeight('#% increased Attack Speed', [10], ctx('gloves'), { tier: 1, tiers: 5 }), 3);
  assert.equal(modWeight('#% increased Attack Speed', [10], ctx('gloves'), { tier: 4, tiers: 5 }), 1);
  assert.equal(modWeight('#% increased Light Radius', [10], ctx('helmet'), { tier: 1, tiers: 5 }), 0);
});

test('slot-specific mods', () => {
  assert.equal(modWeight('#% increased Movement Speed', [30], ctx('boots')), 3);
  assert.equal(modWeight('#% increased Movement Speed', [30], ctx('helmet')), 0);
  assert.equal(modWeight('#% increased Spell Damage', [100], ctx('weapon')), 3);
  assert.equal(modWeight('#% increased Spell Damage', [10], ctx('ring')), 1);
  assert.equal(modWeight('+# to Level of all Skill Gems', [1], ctx('amulet')), 3);
  assert.equal(lifeWeight('ring', 65), 3);
  assert.equal(lifeWeight('chest', 65), 1);
});

test('slotOf and defencesOf from item json', () => {
  assert.equal(slotOf({ baseType: 'Two-Toned Boots', properties: [{ name: 'Armour' }, { name: 'Evasion Rating' }] }), 'boots');
  assert.equal(slotOf({ baseType: 'Opal Ring' }), 'ring');
  assert.equal(slotOf({ baseType: 'Vaal Axe', properties: [{ name: 'Attacks per Second' }] }), 'weapon');
  assert.equal(slotOf({ baseType: 'x' }, 'Body Armour'), 'chest');
  assert.equal(slotOf({ baseType: 'Murderous Eye Jewel' }), 'abyss');
  assert.deepEqual([...defencesOf({ properties: [{ name: 'Armour' }, { name: 'Energy Shield' }] })].sort(), ['int', 'str']);
});

test('verdicts', () => {
  assert.equal(verdictOf([3, 3, 0, 1]).verdict, 'check');
  assert.equal(verdictOf([3, 2]).verdict, 'maybe');
  assert.equal(verdictOf([2, 2, 1, 0]).verdict, 'skip');
});

test('themes: only the best offensive direction counts', () => {
  // life (defence) + spell damage + attack speed: attack and spell don't add up
  const v = verdictOf([{ w: 3 }, { w: 3, t: ['spell'] }, { w: 3, t: ['attack'] }]);
  assert.equal(v.score, 6);
  // crit multi serves both attack and spell
  assert.equal(verdictOf([{ w: 2, t: ['attack', 'spell'] }, { w: 3, t: ['attack'] }]).score, 5);
});

test('abyss and jewel families', () => {
  const abyss = ctx('abyss');
  assert.equal(modWeight('+# to maximum Life', [38], abyss), 3);
  assert.equal(modWeight('+# to maximum Life', [22], abyss), 1);
  assert.equal(modWeight('Minions deal # to # additional Chaos Damage', [25, 36], abyss), 2);
  assert.equal(modWeight('Minions have #% chance to Poison Enemies on Hit', [12], abyss), 2);
  assert.equal(modWeight('Adds # to # Cold Damage to Spells', [25, 35], abyss), 2);
  assert.equal(modWeight('#% chance to Blind Enemies on Hit with Attacks', [5], abyss), 0);
  const jewel = ctx('jewel');
  assert.equal(modWeight('#% increased maximum Life', [6], jewel), 3);
  assert.equal(modWeight('+#% to maximum Fire Resistance', [1], jewel), 3);
  assert.equal(modWeight('Damaging Ailments deal damage #% Faster', [5], jewel), 2);
  assert.equal(modWeight('#% increased Projectile Speed', [7], jewel), 0);
  assert.equal(modWeight('#% chance to Knock Enemies Back on hit', [5], jewel), 0);
});

test('slot premiums', () => {
  assert.equal(modWeight('Flasks applied to you have #% increased Effect', [10], ctx('belt')), 3);
  assert.equal(modWeight('Bow Attacks fire an additional Arrow', [], ctx('quiver')), 3);
  assert.equal(modWeight('+# to Level of all Minion Skill Gems', [2], ctx('helmet')), 3);
  assert.equal(modWeight('#% increased effect of Non-Curse Auras from your Skills', [22], ctx('chest')), 3);
  assert.equal(modWeight('+#% to Global Critical Strike Multiplier', [30], ctx('amulet')), 3);
  assert.equal(modWeight('+#% to Damage over Time Multiplier', [20], ctx('amulet')), 3);
});

test('end to end: dex boots with life, ms, suppress, res is worth checking; vendor trash is junk', () => {
  const stats = indexStats({
    result: [{ entries: [
      { id: 'explicit.ms', text: '#% increased Movement Speed', type: 'explicit' },
      { id: 'explicit.sup', text: '+#% chance to Suppress Spell Damage', type: 'explicit' },
      { id: 'explicit.light', text: '#% increased Light Radius', type: 'explicit' },
      { id: 'explicit.stun', text: '#% increased Stun and Block Recovery', type: 'explicit' },
    ] }],
  });
  const boots = { frameType: 2, baseType: 'Slink Boots', properties: [{ name: 'Evasion Rating', values: [['200', 1]] }], explicitMods: ['+88 to maximum Life', '30% increased Movement Speed', '+14% chance to Suppress Spell Damage', '+44% to Fire Resistance'] };
  const a = analyzeItem(boots, stats);
  assert.equal(a.slot, 'boots');
  assert.equal(a.verdict, 'check');

  // same boots without movement speed: capped at "maybe"
  const slow = { ...boots, explicitMods: ['+88 to maximum Life', '+14% chance to Suppress Spell Damage', '+44% to Fire Resistance', '+40% to Cold Resistance'] };
  assert.equal(analyzeItem(slow, stats).verdict, 'maybe');

  const trash = { frameType: 2, baseType: 'Slink Boots', properties: [{ name: 'Evasion Rating', values: [['200', 1]] }], explicitMods: ['10% increased Light Radius', '12% increased Stun and Block Recovery', '+20% to Fire Resistance'] };
  const b = analyzeItem(trash, stats);
  assert.equal(b.verdict, 'skip');
  assert.ok(b.mods.every((m) => !m.enabled));
});

const statsRaw = {
  result: [{ entries: [
    { id: 'implicit.stat_1633157811', text: '#% increased Armour from Equipped Helmet', type: 'implicit' },
    { id: 'implicit.stat_1618589784', text: '#% chance to Avoid Bleeding', type: 'implicit' },
    { id: 'implicit.stat_3277537093', text: '+# Physical Damage taken from Hits by Animals', type: 'implicit' },
    { id: 'explicit.stat_2342448236', text: '1 Added Passive Skill is Prismatic Heart', type: 'explicit' },
    { id: 'explicit.stat_1152182658', text: '1 Added Passive Skill is Martial Prowess', type: 'explicit' },
    { id: 'enchant.stat_3086156145', text: 'Adds # Passive Skills', type: 'enchant' },
    { id: 'enchant.stat_4079888060', text: '# Added Passive Skills are Jewel Sockets', type: 'enchant' },
    { id: 'enchant.stat_3948993189|8', text: 'Added Small Passive Skills grant: 12% increased Attack Damage while holding a Shield', type: 'enchant' },
    { id: 'explicit.stat_1586440250', text: 'Added Small Passive Skills also grant: +# to Maximum Mana', type: 'explicit' },
  ] }],
};

const WICKER = 'Take this to the Wickerman in a town or hideout to attach it.';
const viscera = (typeLine: string, mod: string, prop = 'Head') => ({ frameType: 15, frameTypeId: 'Viscera', rarity: 'Normal', typeLine, baseType: typeLine, properties: [{ name: prop, values: [] }], implicitMods: [{ description: mod }], descrText: WICKER });

test('Wickerman head: its implicit is searched on, by type, "Greater" dropped for trade', () => {
  const item = viscera("Greater Soldier's Head", '113% increased Armour from Equipped Helmet');
  assert.equal(slotOf(item), 'viscera');
  const a = analyzeItem(item, indexStats(statsRaw));
  assert.equal(a.slot, 'viscera');
  const m = a.mods[0];
  assert.equal(m.statId, 'implicit.stat_1633157811');
  assert.equal(m.enabled, true);
  assert.equal(a.verdict, 'check');
  assert.equal(a.searchBy, 'type');
  assert.equal(a.baseType, "Greater Soldier's Head");
  const q = buildQuery(item, a, describeSelection(a)).query;
  assert.equal(q.type, "Soldier's Head");
  assert.deepEqual(q.stats[0].filters[0], { id: 'implicit.stat_1633157811', value: { min: 101 }, disabled: false });
});

test('Wickerman limbs: any implicit is the item, so it is searched (not only "from Equipped" heads)', () => {
  const leg = viscera('Skeletal Beast Leg', '40% chance to Avoid Bleeding', 'Lower Limb');
  const a = analyzeItem(leg, indexStats(statsRaw));
  assert.equal(a.slot, 'viscera');
  assert.equal(a.mods[0].enabled, true);
  assert.equal(a.verdict, 'maybe');
  assert.ok(describeSelection(a).mods.some((m) => m.enabled));
});

test('a "-#" roll listed on trade as "+#" is searched with the value negated, as a ceiling', () => {
  const leg = viscera("Poacher's Leg", '-49 Physical Damage taken from Hits by Animals', 'Lower Limb');
  const a = analyzeItem(leg, indexStats(statsRaw));
  const m = a.mods[0];
  assert.equal(m.statId, 'implicit.stat_3277537093');
  assert.equal(m.min, null);
  assert.equal(m.max, -44);
  const q = buildQuery(leg, a, describeSelection(a)).query;
  assert.deepEqual(q.stats[0].filters[0].value, { max: -44 });
});

test('cluster jewel: notables are searched on, a third may miss, ilvl band applies', () => {
  const item = {
    frameType: 2, typeLine: 'Large Cluster Jewel', baseType: 'Large Cluster Jewel', ilvl: 84,
    enchantMods: ['Adds 8 Passive Skills'],
    explicitMods: ['1 Added Passive Skill is Prismatic Heart', '1 Added Passive Skill is Martial Prowess', '1 Added Passive Skill is Unknown Thing'],
  };
  assert.equal(slotOf(item), 'cluster');
  const a = analyzeItem(item, indexStats(statsRaw));
  const on = a.mods.filter((m) => m.enabled);
  assert.deepEqual(on.map((m) => m.statId), ['enchant.stat_3086156145', 'explicit.stat_2342448236', 'explicit.stat_1152182658']); // unknown notable has no trade stat
  assert.equal(a.verdict, 'check');
  assert.equal(a.filters.ilvlMin, 84);
});

test('cluster jewel: passive count and enchant are always searched, the count exactly', () => {
  // magic Beryl Large Cluster Jewel: a crafting base with one junk suffix
  const item = {
    frameType: 1, typeLine: 'Beryl Large Cluster Jewel', baseType: 'Large Cluster Jewel', ilvl: 80,
    enchantMods: ['Adds 8 Passive Skills', '2 Added Passive Skills are Jewel Sockets', 'Added Small Passive Skills grant: 12% increased Attack Damage while holding a Shield'],
    explicitMods: ['Added Small Passive Skills also grant: +4 to Maximum Mana'],
  };
  const a = analyzeItem(item, indexStats(statsRaw));
  const by = (re: RegExp) => a.mods.find((m) => re.test(m.text))!;
  const count = by(/^Adds 8/), enchant = by(/holding a Shield/), mana = by(/Maximum Mana/);
  assert.deepEqual([count.required, count.min, count.max], [true, 8, 8]);
  assert.deepEqual([enchant.required, enchant.statId, enchant.min], [true, 'enchant.stat_3948993189|8', null]);
  assert.equal(a.verdict, 'maybe'); // fewest passives a large can have: a base worth a look
  // the ladder gives up the sockets line and the junk suffix, never the count or the enchant
  const order = dropOrder(a, describeSelection(a));
  assert.ok(order.includes(mana.key) && !order.includes(count.key) && !order.includes(enchant.key));
  const q = buildQuery(item, a, describeSelection(a)).query;
  assert.equal(q.type, 'Large Cluster Jewel');
  assert.deepEqual(q.stats[0].filters, [
    { id: 'enchant.stat_3086156145', value: { min: 8, max: 8 }, disabled: false },
    { id: 'enchant.stat_3948993189', value: { option: 8 }, disabled: false },
  ]);
});
