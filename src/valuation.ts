// Rule-based "is this mod worth searching on?" model for rares, per slot.
// Weight 0 = junk, 1 = minor, 2 = good, 3 = key. Only weight >= 2 is ticked by default.
// A rule is (regex on normalised text, weight by slot/defence/roll, offensive themes). First match wins.
// Tier (from RePoE, 1 = best) then nudges: T1 bumps a useful mod up, bottom tiers cap it at minor.
// Life and elemental/chaos resistances are valued as pseudo totals in query.ts.
//
// Themes: a buyer wants defence plus ONE offensive direction. An item with spell damage and attack
// speed is worth one of the two, so the verdict counts defence + the best single theme.
// Families come from RePoE per slot (what can actually roll); weights are hand-tuned for 3.30 trade.

export type Slot = 'helmet' | 'chest' | 'gloves' | 'boots' | 'shield' | 'belt' | 'ring' | 'amulet' | 'quiver' | 'weapon' | 'jewel' | 'abyss' | 'cluster' | 'viscera' | 'other';
export type Defence = 'str' | 'dex' | 'int';
export type Ctx = { slot: Slot; defences: Set<Defence>; caster?: boolean };
export type Verdict = 'check' | 'maybe' | 'skip' | 'n/a';
export type Theme = 'attack' | 'spell' | 'minion' | 'dot';

type Weight = number | ((c: Ctx, v: number) => number);
type Rule = { re: RegExp; w: Weight; t?: Theme[] };

export const ARMOUR_SLOTS: Slot[] = ['helmet', 'chest', 'gloves', 'boots', 'shield'];
export const JEWELLERY: Slot[] = ['ring', 'amulet', 'belt'];
const isJewel = (c: Ctx) => c.slot === 'jewel' || c.slot === 'abyss';
const at = (...steps: [number, number][]) => (v: number) => steps.find(([min]) => v >= min)?.[1] ?? 0;
// weight by slot; a slot entry may itself be roll-aware
const slot = (map: Partial<Record<Slot | 'jewels', number | ((v: number) => number)>>, def = 0): Weight => (c, v) => {
  const e = map[c.slot] ?? (isJewel(c) ? map.jewels : undefined) ?? def;
  return typeof e === 'function' ? e(v) : e;
};

const ATK: Theme[] = ['attack'];
const SPELL: Theme[] = ['spell'];
const HIT: Theme[] = ['attack', 'spell'];
const MINION: Theme[] = ['minion'];
const DOT: Theme[] = ['dot'];

const RULES: Rule[] = [
  // --- gem levels ---------------------------------------------------------------------------------
  { re: /^\+# to Level of all Skill Gems$/, w: 3, t: HIT },
  { re: /^\+# to Level of all Minion Skill Gems$|^\+# to Level of all Raise (?:Spectre|Zombie) Gems$/, w: 3, t: MINION },
  { re: /^\+# to Level of all (?:Fire|Cold|Lightning|Chaos|Physical) (?:Spell )?Skill Gems$|^\+# to Level of all Spell Skill Gems$/, w: 3, t: SPELL },
  { re: /^\+# to Level of all .*Gems$/, w: 2 },
  { re: /^\+# to Level of Socketed (?:Fire|Cold|Lightning|Chaos) Gems$/, w: slot({ boots: 1, weapon: 1, helmet: 1 }) }, // only for a specific self-cast skill
  { re: /^\+# to Level of Socketed /, w: 0 },

  // --- defence (life/res are pseudo totals) ---------------------------------------------------------
  { re: /^#% increased maximum Life$/, w: slot({ jewels: at([5, 3], [0, 2]) }, 3) },
  { re: /^\+# to maximum Life$/, w: slot({ abyss: at([36, 3], [30, 2], [0, 1]) }, 1) }, // abyss life isn't in the pseudo weighting
  { re: /^#% increased maximum Energy Shield$/, w: slot({ amulet: at([16, 3], [0, 2]), jewels: at([6, 2], [0, 1]) }, 1) },
  { re: /^\+# to maximum Energy Shield$/, w: slot({ ring: at([35, 2], [0, 1]), amulet: at([40, 2], [0, 1]), belt: at([40, 2], [0, 1]), abyss: at([36, 2], [0, 1]) }, 1) },
  { re: /^#% increased Energy Shield from Equipped Body Armour$/, w: 2 },
  { re: /^#% faster start of Energy Shield Recharge$/, w: slot({ chest: at([40, 2], [0, 1]), shield: at([40, 2], [0, 1]) }, 1) },
  { re: /^#% increased (?:Armour|Evasion Rating|Energy Shield)(?:,? (?:and )?(?:Armour|Evasion Rating|Energy Shield))*$/, w: 1 }, // local: judged via the defence property row
  { re: /^\+# to (?:Armour|Evasion Rating)$/, w: slot({ belt: at([300, 2], [0, 1]) }, 1) },
  {
    re: /^\+#% chance to Suppress Spell Damage$/,
    w: (c, v) => {
      if (isJewel(c)) return 2;
      const base = c.defences.has('dex') ? 3 : c.defences.has('int') ? 2 : 1; // evasion bases: the premium use
      return Math.min(base, at([13, 3], [9, 2], [0, 1])(v));
    },
  },
  { re: /^\+#% to all maximum Resistances$/, w: 3 },
  { re: /^\+#% to maximum (?:Fire|Cold|Lightning|Chaos) Resistance$/, w: 3 },
  { re: /^#% Chance to Block Spell Damage$/, w: slot({ shield: at([10, 3], [0, 2]) }, 1) },
  { re: /^#% increased Chance to Block$/, w: slot({ shield: at([60, 2], [0, 1]) }, 1) },
  { re: /^\+#% Chance to Block/, w: slot({ jewels: 1 }, 1) },
  { re: /^#% additional Physical Damage Reduction$/, w: 2 },
  { re: /^#% of Damage taken Recouped as Life$/, w: slot({ ring: at([10, 2], [0, 1]), jewels: 1 }, 1) },
  { re: /^#% increased Movement Speed$/, w: slot({ boots: at([30, 3], [25, 3], [20, 2], [0, 1]) }, 0) },
  { re: /^#% increased Mana Reservation Efficiency of Skills$/, w: slot({ jewels: 2 }, 3) },
  { re: /^#% increased effect of Non-Curse Auras from your Skills$/, w: 3 },
  { re: /^Flasks applied to you have #% increased Effect$/, w: 3 },
  { re: /^#% reduced Flask Charges used$|^#% increased Flask Effect Duration$/, w: slot({ belt: at([20, 2], [0, 1]) }, 1) },
  { re: /^#% increased Flask Charges gained$|^#% increased Flask Life Recovery rate$|^#% increased Life Recovery from Flasks$/, w: 1 },
  { re: /^-# Physical Damage taken from Hits$/, w: 1 },

  // --- minions -------------------------------------------------------------------------------------
  { re: /^Minions deal # to # additional (?:Physical|Fire|Cold|Lightning|Chaos) Damage$/, w: 2, t: MINION },
  { re: /^Minions have #% increased Attack Speed$|^Minions have #% increased Cast Speed$/, w: 2, t: MINION },
  { re: /^Minions have #% chance to (?:Poison Enemies on Hit|cause Bleeding with Attacks|Ignite)$/, w: 2, t: MINION },
  { re: /^Minions deal #% increased Damage(?: if you've used a Minion Skill Recently)?$/, w: slot({ weapon: at([40, 3], [0, 2]), gloves: 2, amulet: 2, jewels: 2 }, 1), t: MINION },
  { re: /^Minions have #% increased maximum Life$/, w: slot({ jewels: 2, weapon: 2 }, 1), t: MINION },
  { re: /^Minions have \+#% to (?:all Elemental|Chaos) Resistances?$|^Minions have #% increased Movement Speed$|^Minions Regenerate|^Minions Leech/, w: 1, t: MINION },

  // --- damage over time ----------------------------------------------------------------------------
  { re: /Damage over Time Multiplier/, w: slot({ amulet: at([18, 3], [0, 2]), weapon: at([25, 3], [0, 2]), quiver: at([18, 3], [0, 2]), jewels: 2 }, 2), t: DOT },
  { re: /^Damaging Ailments deal damage #% Faster$/, w: 2, t: DOT },
  { re: /^#% increased Damage with Ailments$|^#% increased Damage over Time$|^#% increased (?:Burning Damage|Damage with Poison|Damage with Bleeding)$/, w: slot({ belt: 1 }, 1), t: DOT },

  // --- crit ----------------------------------------------------------------------------------------
  { re: /^\+#% to Global Critical Strike Multiplier$/, w: slot({ amulet: at([25, 3], [15, 2], [0, 1]), jewels: at([9, 2], [0, 1]) }, 2), t: HIT },
  { re: /^\+#% to Critical Strike Multiplier (?:for Spell Damage|with Elemental Skills|with (?:Fire|Cold|Lightning) Skills)$/, w: slot({ jewels: at([12, 2], [0, 1]) }, 2), t: HIT },
  { re: /^\+#% to Critical Strike Multiplier with Bows$/, w: slot({ quiver: at([25, 3], [0, 2]) }, 2), t: ATK },
  { re: /Critical Strike Multiplier/, w: slot({ weapon: at([25, 3], [0, 2]) }, 1), t: HIT },
  { re: /^#% increased (?:Global )?Critical Strike Chance$/, w: slot({ amulet: at([25, 2], [0, 1]), weapon: 2, jewels: 1 }, 1), t: HIT },
  { re: /^#% increased Critical Strike Chance with Bows$/, w: slot({ quiver: at([30, 2], [0, 1]) }, 1), t: ATK },
  { re: /^#% increased Spell Critical Strike Chance$/, w: slot({ shield: at([60, 2], [0, 1]), weapon: at([60, 2], [0, 1]) }, 1), t: SPELL },

  // --- attacks -------------------------------------------------------------------------------------
  { re: /^Bow Attacks fire an additional Arrow$|^Bow Attacks fire # additional Arrows$/, w: 3, t: ATK },
  { re: /^#% increased Attack Speed$/, w: slot({ gloves: at([11, 3], [7, 2], [0, 1]), quiver: at([10, 3], [0, 2]), ring: 2, weapon: 2, jewels: 2 }, 1), t: ATK },
  { re: /^#% increased Attack and Cast Speed$/, w: slot({ jewels: 2 }, 2), t: HIT },
  { re: /^Adds # to # (?:Physical|Fire|Cold|Lightning|Chaos) Damage to Attacks$/, w: slot({ quiver: 3, gloves: 2, ring: 2, amulet: 2, abyss: 2 }, 1), t: ATK },
  { re: /^# to # Added (?:Physical|Fire|Cold|Lightning|Chaos) Damage with .* Attacks$/, w: 1, t: ATK }, // weapon-type restricted abyss mods
  { re: /^#% increased Damage with Bow Skills$/, w: slot({ quiver: at([30, 2], [0, 1]) }, 1), t: ATK },
  { re: /^#% increased Elemental Damage with Attack Skills$/, w: slot({ belt: at([30, 2], [0, 1]), amulet: at([30, 2], [0, 1]), ring: at([30, 2], [0, 1]) }, 1), t: ATK },
  { re: /^#% increased Physical Damage$/, w: slot({ weapon: 2 }, 1), t: ATK },
  { re: /^Adds # to # (?:Physical|Fire|Cold|Lightning|Chaos) Damage$/, w: slot({ weapon: 2, gloves: 1 }, 1), t: ATK },
  { re: /^#% increased (?:Attack|Cast) Speed if you've dealt a Critical Strike Recently$/, w: 1, t: HIT },

  // --- spells --------------------------------------------------------------------------------------
  { re: /^#% increased Cast Speed$/, w: slot({ weapon: at([15, 3], [0, 2]), amulet: at([10, 2], [0, 1]), ring: at([8, 2], [0, 1]), shield: 2, gloves: 2, jewels: 2 }, 1), t: SPELL },
  { re: /^#% increased Spell Damage$/, w: slot({ weapon: at([60, 3], [0, 2]), shield: at([60, 3], [0, 2]), amulet: at([18, 2], [0, 1]) }, 1), t: SPELL },
  { re: /^#% increased (?:Fire|Cold|Lightning|Chaos) Damage$/, w: (c, v) => (c.slot === 'weapon' || c.slot === 'shield' ? (c.caster || c.slot === 'shield' ? at([60, 3], [0, 2])(v) : 1) : 1), t: HIT },
  { re: /^Adds # to # (?:Physical|Fire|Cold|Lightning|Chaos) Damage to Spells$/, w: slot({ weapon: 3, abyss: 2 }, 1), t: SPELL },
  { re: /^Gain #% of .* Damage as Extra .* Damage$/, w: slot({ weapon: 3 }, 2), t: HIT },
  { re: /^Damage Penetrates #% (?:Elemental|Fire|Cold|Lightning) Resistances?(?: if you haven't Killed Recently)?$/, w: slot({ jewels: 1 }, 2), t: HIT },
  { re: /^Enemies within # metres have #% to (?:Fire|Cold|Lightning|Chaos) Resistance/, w: 2, t: HIT },

  // --- minor ---------------------------------------------------------------------------------------
  { re: /^\+# to all Attributes$/, w: slot({ amulet: at([25, 2], [0, 1]), ring: at([13, 2], [0, 1]) }, 1) },
  { re: /^\+# to (?:Strength|Dexterity|Intelligence)$/, w: slot({ amulet: at([40, 2], [0, 1]) }, 1) }, // str on belts/etc. already feeds pseudo life
  { re: /^\+# to (?:Strength|Dexterity|Intelligence) and (?:Strength|Dexterity|Intelligence)$/, w: 1 },
  { re: /^#% increased (?:Damage|Global Physical Damage|Elemental Damage|Area Damage|Projectile Damage)$/, w: 1, t: HIT },
  { re: /^#% increased (?:Totem|Trap|Mine) Damage$|^#% increased (?:Trap|Mine) Throwing Speed$/, w: 1, t: HIT },
  { re: /^\+# to maximum Mana$|^#% increased maximum Mana$/, w: 1 },
  { re: /Leeched as Life|Life per Enemy Hit|Regenerate # Life per second$|Regenerate #% of Life per second$/, w: 1 },
  { re: /^\+# to Accuracy Rating$|increased Global Accuracy Rating/, w: slot({ gloves: 1, helmet: 1, quiver: 1, ring: 1, amulet: 1, abyss: 1 }, 0), t: ATK },
  { re: /Item Rarity|Rarity of Items/, w: 1 },
  // everything else (stun, light radius, knockback, projectile speed, avoid ailments, reflect,
  // mana-on-kill, chance to freeze/shock/ignite, ...) -> 0
];

function match(norm: string): Rule | null {
  for (const r of RULES) if (r.re.test(norm)) return r;
  return null;
}

export function modThemes(norm: string): Theme[] {
  return match(norm)?.t ?? [];
}

// Cluster jewels are priced first by what they are: how many passives they add and what the small
// passives grant (the enchant). Both are always searched. Notables come next; their value is left to
// the learned model (overview page), which shows which ones actually move the price.
const NOTABLE = /^# Added Passive Skill is /;
export const CLUSTER_IDENTITY = /^Adds # Passive Skills$|^Added Small Passive Skills grant: /;
function clusterWeight(norm: string): number {
  if (CLUSTER_IDENTITY.test(norm)) return 3;
  if (NOTABLE.test(norm)) return 2;
  if (/^Added Small Passive Skills also grant/.test(norm)) return 1;
  return 0;
}

// Viscera (Wickerman parts: heads, limbs, torsos, ...) attach to the Wickerman; their implicit(s) are
// the whole item, so every one of them is searched on. Heads that boost equipped gear ("#% increased
// Armour from Equipped Helmet") are the sought-after kind, the bigger rolls especially.
const EQUIPPED_LINE = /^#% increased .* from Equipped|^#% increased bonuses gained from Equipped/;
function visceraWeight(norm: string, v: number): number {
  return EQUIPPED_LINE.test(norm) && v >= 100 ? 3 : 2;
}

// Weights learned from the market (explore.ts probes), per "slot|trade stat id": a floor or a cap on
// the hand-written rule's weight, applied before the tier nudge (the probe measured a good roll).
export type Learned = { min?: number; max?: number; why: string };
let learned = new Map<string, Learned>();
export function setLearned(m: Map<string, Learned>) {
  learned = m;
}
export function learnedFor(slot: Slot, statId: string | null | undefined): Learned | undefined {
  return statId ? learned.get(`${slot}|${statId.replace(/^fractured\./, 'explicit.')}`) : undefined;
}

export function modWeight(norm: string, values: number[], ctx: Ctx, tier: { tier: number | null; tiers: number | null } = { tier: null, tiers: null }, statId?: string | null): number {
  if (ctx.slot === 'cluster') return clusterWeight(norm);
  if (ctx.slot === 'viscera') return visceraWeight(norm, values.length ? values[0] : 0);
  const v = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const rule = match(norm);
  let w = rule ? (typeof rule.w === 'function' ? rule.w(ctx, v) : rule.w) : 0;
  const l = learnedFor(ctx.slot, statId);
  if (l?.min != null) w = Math.max(w, l.min);
  if (l?.max != null) w = Math.min(w, l.max);
  if (w > 0 && tier.tier && tier.tiers && tier.tiers >= 3) {
    if (tier.tier === 1) w = Math.min(3, w + 1);
    else if (tier.tier >= Math.ceil(tier.tiers * 0.6)) w = Math.min(w, 1);
  }
  return w;
}

// --- pseudo totals -----------------------------------------------------------------------------

export function lifeWeight(slot: Slot, v: number): number {
  if (slot === 'chest' || slot === 'shield') return at([100, 3], [70, 2], [40, 1])(v);
  if (ARMOUR_SLOTS.includes(slot) || slot === 'belt') return at([80, 3], [55, 2], [30, 1])(v);
  if (slot === 'ring' || slot === 'amulet' || slot === 'quiver') return at([60, 3], [45, 2], [25, 1])(v);
  if (slot === 'abyss') return 0; // abyss flat life is weighted on its own line (36-40 is T1)
  return at([60, 2], [30, 1])(v);
}

export function eleResWeight(slot: Slot, v: number): number {
  if (slot === 'jewel' || slot === 'abyss') return at([30, 2], [12, 1])(v);
  if (slot === 'weapon') return at([60, 1])(v);
  return at([90, 3], [60, 2], [35, 1])(v);
}

export function chaosResWeight(slot: Slot, v: number): number {
  if (slot === 'jewel' || slot === 'abyss') return at([13, 2], [7, 1])(v);
  return at([30, 3], [20, 2], [10, 1])(v);
}

// --- slot / defence ----------------------------------------------------------------------------

const SLOT_BY_CLASS: Record<string, Slot> = {
  Helmet: 'helmet', 'Body Armour': 'chest', Gloves: 'gloves', Boots: 'boots', Shield: 'shield', Belt: 'belt', Ring: 'ring', Amulet: 'amulet',
  Quiver: 'quiver', Jewel: 'jewel', AbyssJewel: 'abyss',
};
const WEAPON_CLASSES = /Axe|Mace|Sword|Bow|Claw|Dagger|Wand|Staff|Warstaff|Sceptre|Foil|Rune Dagger|Fishing Rod/;
const SLOT_BY_SUBCATEGORY: Record<string, Slot> = { chest: 'chest', helmet: 'helmet', gloves: 'gloves', boots: 'boots', shield: 'shield', quiver: 'quiver', ring: 'ring', amulet: 'amulet', belt: 'belt' };
const SLOT_BY_BASE: [RegExp, Slot][] = [
  [/Ring$/, 'ring'],
  [/(?:Amulet|Talisman)$/, 'amulet'],
  [/(?:Belt|Sash|Stygian Vise)$/, 'belt'],
  [/Quiver$/, 'quiver'],
  [/Eye Jewel$/, 'abyss'],
  [/Jewel$/, 'jewel'],
  [/(?:Shield|Buckler)$/, 'shield'],
  [/(?:Boots|Greaves|Slippers)$/, 'boots'],
  [/(?:Gloves|Gauntlets|Mitts)$/, 'gloves'],
  [/(?:Helmet|Helm|Hat|Circlet|Crown|Cap|Coif|Mask|Burgonet|Bascinet|Sallet|Pelt|Casque|Hood|Cage|Tricorne|Cowl)$/, 'helmet'],
];

export function defencesOf(item: any): Set<Defence> {
  const names = new Set<string>((item.properties ?? []).map((p: any) => p.name));
  const out = new Set<Defence>();
  if (names.has('Armour')) out.add('str');
  if (names.has('Evasion Rating')) out.add('dex');
  if (names.has('Energy Shield')) out.add('int');
  return out;
}

export const isViscera = (item: any): boolean => item?.frameTypeId === 'Viscera' || /Wickerman/.test(String(item?.descrText ?? ''));
export const isCluster = (item: any): boolean => /Cluster Jewel$/.test(String(item?.baseType ?? item?.typeLine ?? ''));
// rares/magics, plus viscera (normal rarity, but each roll prices like any other item)
export const priceable = (item: any): boolean => item?.frameType === 1 || item?.frameType === 2 || isViscera(item);

export function slotOf(item: any, cls: string | null = null): Slot {
  if (isViscera(item)) return 'viscera';
  if (isCluster(item)) return 'cluster';
  if (cls) {
    if (SLOT_BY_CLASS[cls]) return SLOT_BY_CLASS[cls];
    if (WEAPON_CLASSES.test(cls)) return 'weapon';
  }
  if (item.abyssJewel) return 'abyss';
  for (const s of item.extended?.subcategories ?? []) if (SLOT_BY_SUBCATEGORY[s]) return SLOT_BY_SUBCATEGORY[s];
  if (item.extended?.category === 'weapons') return 'weapon';
  if (item.extended?.category === 'jewels') return 'jewel';
  const names = new Set<string>((item.properties ?? []).map((p: any) => p.name));
  if (names.has('Attacks per Second')) return 'weapon';
  const base = String(item.baseType ?? item.typeLine ?? '');
  for (const [re, slot] of SLOT_BY_BASE) if (re.test(base)) return slot;
  return defencesOf(item).size ? 'chest' : 'other';
}

// --- verdict -----------------------------------------------------------------------------------

// Tunable thresholds on the summed points of good rows (weight >= 2 at full value, minor at half).
export const CHECK_SCORE = 10;
export const MAYBE_SCORE = 6;

export type Scored = number | { w: number; t?: Theme[] };

// Defence (untagged) counts fully; of the offensive themes only the best one counts. Minor (weight 1)
// rows add half a point each: several decent lines together are what a budget buyer pays for.
// One key mod alone is enough for "maybe": a single great line can carry an item.
const points = (w: number) => (w >= 2 ? w : w === 1 ? 0.5 : 0);
export function verdictOf(entries: Scored[]): { score: number; verdict: Verdict; theme: Theme | null } {
  const rows = entries.map((e) => (typeof e === 'number' ? { w: e, t: [] as Theme[] } : { w: e.w, t: e.t ?? [] })).filter((r) => r.w >= 1);
  const base = rows.filter((r) => !r.t.length);
  let best: { theme: Theme | null; rows: typeof rows } = { theme: null, rows: [] };
  for (const theme of ['attack', 'spell', 'minion', 'dot'] as Theme[]) {
    const rs = rows.filter((r) => r.t.includes(theme));
    const sum = rs.reduce((a, r) => a + points(r.w), 0);
    if (sum > best.rows.reduce((a, r) => a + points(r.w), 0)) best = { theme, rows: rs };
  }
  const counted = [...base, ...best.rows];
  const score = counted.reduce((a, r) => a + points(r.w), 0);
  const keys = counted.filter((r) => r.w >= 3).length;
  const verdict: Verdict = score >= CHECK_SCORE || keys >= 2 ? 'check' : score >= MAYBE_SCORE || keys >= 1 ? 'maybe' : 'skip';
  return { score, verdict, theme: best.theme };
}
