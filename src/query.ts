// Pure logic: stash item JSON -> analysis (search rows with trade stat ids + defaults) -> trade query.
//
// A "row" is one thing we could filter on: an item mod, a pseudo total (life, elemental/chaos res),
// a property (armour/evasion/ES, weapon pDPS/eDPS), or open affix counts. Rows carry a weight
// (0-3); only the valuable ones are ticked by default so we don't demand that comparable items
// share our trash mods. Individual life/res/defence/damage lines are "covered" by their total row.
import { analyzeAffixes, benchOptions, parseItemLine, type AffixReport, type IndexedDb } from './moddb.ts';
import {
  ARMOUR_SLOTS, CLUSTER_IDENTITY, chaosResWeight, defencesOf, eleResWeight, isViscera, learnedFor, lifeWeight, modThemes, modWeight, priceable, slotOf, verdictOf,
  type Ctx, type Scored, type Slot, type Theme, type Verdict,
} from './valuation.ts';

export type StatEntry = { id: string; local: boolean };
// type ('explicit' | 'implicit' | ...) -> normalised text -> candidate stat ids
export type StatsIndex = Map<string, Map<string, StatEntry[]>>;

export type RowType = 'implicit' | 'explicit' | 'crafted' | 'fractured' | 'enchant' | 'pseudo' | 'prop';

export type ModAnalysis = {
  key: string;
  type: RowType;
  text: string;
  statId: string | null; // trade stat id, or "prop:<group>.<filter>" for property filters
  values: number[];
  weight: number;
  enabled: boolean;
  min: number | null;
  max: number | null;
  minCrafted?: number | null; // min to use when pricing "as if the suggested craft was done"
  themes?: Theme[]; // offensive direction (attack/spell/minion/dot); untagged = defence/utility
  required?: boolean; // must-have (e.g. movement speed on boots): kept out of the "match at least" group
  negate?: boolean; // comparables must NOT match this (a ceiling): goes in the search's "not" group
  affix?: 'prefix' | 'suffix' | null;
  tier?: number | null;
  tiers?: number | null;
  covered?: string; // key of the total row this line is folded into
  learned?: string; // why the market data moved this line's weight off the hand-written rule
};

export type Craft = { text: string; affix: 'prefix' | 'suffix'; cost: string; gain: string; replacesCrafted: boolean };

export type Analysis = {
  kind: 'unique' | 'type' | 'base';
  name: string;
  baseType: string;
  tradeType: string; // base type as the trade site names it
  category: string | null; // trade category when the exact base doesn't matter (jewellery, jewels)
  searchBy: 'type' | 'category';
  mods: ModAnalysis[];
  ilvl: number | null;
  links: number;
  corrupted: boolean;
  slot: Slot;
  affixes: { prefixes: number; suffixes: number; openPrefix: number; openSuffix: number; uncertain: boolean } | null;
  dps: { pdps: number; edps: number; cdps: number; total: number } | null;
  craft: Craft | null;
  useCraft: boolean;
  score: number;
  verdict: Verdict;
  craftedScore: number;
  craftedVerdict: Verdict;
  filters: { ilvlMin: number | null; linksMin: number | null; corrupted: 'any' | 'true' | 'false'; matchAtLeast: number | null };
};

export type Selection = {
  mods: { key: string; enabled: boolean; min: number | null; max: number | null }[];
  ilvlMin: number | null;
  linksMin: number | null;
  corrupted: 'any' | 'true' | 'false';
  matchAtLeast: number | null;
  searchBy?: 'type' | 'category';
};

const LOCAL_PROPS = new Set(['Physical Damage', 'Armour', 'Evasion Rating', 'Energy Shield', 'Ward', 'Critical Strike Chance', 'Attacks per Second']);
const CATEGORY: Partial<Record<Slot, string>> = { ring: 'accessory.ring', amulet: 'accessory.amulet', belt: 'accessory.belt', quiver: 'armour.quiver', jewel: 'jewel.base', abyss: 'jewel.abyss' };
// slots where buyers expect life: an item without it (and without room to craft it) is another market
const LIFE_SLOTS: Slot[] = [...ARMOUR_SLOTS, 'belt', 'ring', 'amulet', 'quiver'];
// the least total life that counts at all on a slot
const lifeFloor = (slot: Slot) => {
  let v = 1;
  while (v < 200 && lifeWeight(slot, v) === 0) v++;
  return v;
};
const GEAR: Slot[] = ['helmet', 'chest', 'gloves', 'boots', 'shield', 'belt', 'ring', 'amulet', 'quiver', 'weapon', 'jewel', 'abyss', 'cluster', 'viscera'];

export function normalizeMod(text: string): { norm: string; values: number[] } {
  return parseItemLine(text.replace(/\n/g, ' '));
}

export function indexStats(raw: any): StatsIndex {
  const index: StatsIndex = new Map();
  for (const group of raw.result) {
    for (const e of group.entries) {
      const type = e.type as string;
      const local = / \(Local\)$/.test(e.text);
      const norm = String(e.text).replace(/ \(Local\)$/, '').replace(/\n/g, ' ');
      if (!index.has(type)) index.set(type, new Map());
      const m = index.get(type)!;
      if (!m.has(norm)) m.set(norm, []);
      m.get(norm)!.push({ id: e.id, local });
    }
  }
  return index;
}

const clean = (s: string | undefined) => (s ?? '').replace(/<<.*?>>/g, '').replace(/<[^>]*>/g, '').trim();
const textOf = (m: any): string => (typeof m === 'string' ? m : m?.description ?? '');

export function frameKind(item: any): Analysis['kind'] {
  if (isViscera(item)) return 'base';
  const f = item.frameType;
  if (f === 3 || f === 9 || f === 10) return 'unique';
  if (f === 4 || f === 5 || f === 6 || f === 7) return 'type';
  const hasMods = ['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods'].some((field) => (item[field] ?? []).length > 0);
  return hasMods ? 'base' : 'type';
}

function roundDown(v: number): number {
  const x = v * 0.9;
  return x >= 10 ? Math.floor(x) : Math.floor(x * 10) / 10;
}
function safely<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

// Item lines in a uniform shape. Since 3.2x the stash API puts crafted/fractured mods in explicitMods
// with flags; older payloads use craftedMods/fracturedMods.
type RawLine = { key: string; type: RowType; text: string; norm: string; values: number[]; explicitIdx: number | null };
function rawLines(item: any): RawLine[] {
  const out: RawLine[] = [];
  const push = (type: RowType, m: any, i: number, explicitIdx: number | null) => {
    const text = textOf(m);
    const { norm, values } = normalizeMod(text);
    out.push({ key: `${type}:${i}`, type, text, norm, values, explicitIdx });
  };
  (item.enchantMods ?? []).forEach((m: any, i: number) => push('enchant', m, i, null));
  (item.implicitMods ?? []).forEach((m: any, i: number) => push('implicit', m, i, null));
  (item.fracturedMods ?? []).forEach((m: any, i: number) => push('fractured', m, i, null));
  (item.explicitMods ?? []).forEach((m: any, i: number) => push(m?.flags?.crafted ? 'crafted' : m?.flags?.fractured ? 'fractured' : 'explicit', m, i, i));
  (item.craftedMods ?? []).forEach((m: any, i: number) => push('crafted', m, i, null));
  return out;
}

// --- pseudo totals -------------------------------------------------------------------------------

const ELE = ['Fire', 'Cold', 'Lightning'];
type Contribution = { life: number; ele: number; chaos: number };

export function contribution(norm: string, values: number[]): Contribution {
  const v = values[0] ?? 0;
  const c = { life: 0, ele: 0, chaos: 0 };
  if (norm === '+# to maximum Life') c.life = v;
  else if (norm === '+# to Strength' || norm === '+# to all Attributes') c.life = v / 2;
  else if (/^\+# to Strength and (?:Dexterity|Intelligence)$/.test(norm)) c.life = v / 2;
  else if (norm === '+#% to all Elemental Resistances') c.ele = 3 * v;
  else if (norm === '+#% to Chaos Resistance') c.chaos = v;
  else {
    const one = norm.match(/^\+#% to (Fire|Cold|Lightning) Resistance$/);
    const two = norm.match(/^\+#% to (Fire|Cold|Lightning|Chaos) and (Fire|Cold|Lightning|Chaos) Resistances$/);
    if (one) c.ele = v;
    else if (two) for (const r of [two[1], two[2]]) ELE.includes(r) ? (c.ele += v) : (c.chaos += v);
  }
  return c;
}

// --- weapons -------------------------------------------------------------------------------------

const prop = (item: any, name: string) => (item.properties ?? []).find((p: any) => p.name === name);
const rangeAvg = (s: string) => avg(String(s).split('-').map(Number));

export function weaponDps(item: any) {
  const aps = parseFloat(prop(item, 'Attacks per Second')?.values?.[0]?.[0] ?? '0');
  if (!aps) return null;
  const phys = rangeAvg(prop(item, 'Physical Damage')?.values?.[0]?.[0] ?? '0');
  const ele = (prop(item, 'Elemental Damage')?.values ?? []).reduce((a: number, v: any) => a + rangeAvg(v[0]), 0);
  const chaos = rangeAvg(prop(item, 'Chaos Damage')?.values?.[0]?.[0] ?? '0');
  const quality = parseFloat(String(prop(item, 'Quality')?.values?.[0]?.[0] ?? '0').replace(/[+%]/g, '')) || 0;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { aps, phys, ele, chaos, quality, pdps: r(phys * aps), edps: r(ele * aps), cdps: r(chaos * aps), total: r((phys + ele + chaos) * aps) };
}

type Dps = NonNullable<ReturnType<typeof weaponDps>>;

// DPS after adding one bench mod (lines with their max-tier ranges), given current local % mods.
export function dpsWithCraft(d: Dps, lines: { norm: string; ranges: [number, number][] }[], incPhys: number, incAps: number) {
  let { phys, ele, chaos, aps } = d;
  const q = d.quality / 100;
  for (const l of lines) {
    const mid = avg(l.ranges.map((r) => avg(r)));
    if (l.norm === '#% increased Physical Damage') phys = (phys * (1 + q + incPhys + mid / 100)) / (1 + q + incPhys);
    else if (l.norm === 'Adds # to # Physical Damage') phys += mid * (1 + q + incPhys);
    else if (/^Adds # to # (?:Fire|Cold|Lightning) Damage$/.test(l.norm)) ele += mid;
    else if (l.norm === 'Adds # to # Chaos Damage') chaos += mid;
    else if (l.norm === '#% increased Attack Speed') aps = (aps * (1 + incAps + mid / 100)) / (1 + incAps);
  }
  const r = (x: number) => Math.round(x * 10) / 10;
  return { pdps: r(phys * aps), edps: r(ele * aps), cdps: r(chaos * aps), total: r((phys + ele + chaos) * aps) };
}

const CASTER = /Spell|Cast Speed|Level of all .*(?:Spell|Fire|Cold|Lightning|Chaos|Physical) Skill Gems|Damage over Time Multiplier|Minion/;
const PHYS_DMG = /^(?:#% increased Physical Damage|Adds # to # Physical Damage)$/;
const ELE_DMG = /^Adds # to # (?:Fire|Cold|Lightning) Damage$/;
const ATK = /^(?:#% increased Attack Speed|#% increased Critical Strike Chance)$/;
const LOCAL_DEF = /^(?:#% increased (?:Armour|Evasion Rating|Energy Shield)(?:,? (?:and )?(?:Armour|Evasion Rating|Energy Shield))*|\+# to (?:Armour|Evasion Rating|maximum Energy Shield))$/;

// --- analysis ------------------------------------------------------------------------------------

// Lines that belong to this particular item (and so are worth searching on): explicit and fractured
// mods, plus the enchant notables of a cluster and the implicit(s) of a Wickerman part (viscera).
export const ownType = (slot: Slot, t: RowType) => t === 'explicit' || t === 'fractured' || (slot === 'cluster' && t === 'enchant') || (slot === 'viscera' && t === 'implicit');

export function analyzeItem(item: any, stats: StatsIndex, db: IndexedDb | null = null): Analysis {
  const kind = frameKind(item);
  const lines = rawLines(item);
  const rep: AffixReport | null = db && kind === 'base' && !isViscera(item) ? safely(() => analyzeAffixes(item, db)) : null;
  const slot = slotOf(item, rep?.cls ?? null);
  const own = (t: RowType) => ownType(slot, t);
  const preferLocal = (item.properties ?? []).some((p: any) => LOCAL_PROPS.has(p.name));
  const ctx: Ctx = { slot, defences: defencesOf(item), caster: slot === 'weapon' && lines.some((l) => CASTER.test(l.norm)) };
  // magic items too: two mods max, so they're cheap to judge and easy for the model to learn
  const valuable = kind === 'base' && priceable(item) && GEAR.includes(slot);

  const mods: ModAnalysis[] = lines.map((l) => {
    const statType = l.type === 'fractured' ? 'fractured' : l.type;
    // trade lists notables with the literal count ("1 Added Passive Skill is X")
    const text = l.norm.replace(/^# Added Passive Skill is /, '1 Added Passive Skill is ');
    // a cluster's enchant ("...grant: 12% increased Lightning Damage") is one trade option per kind,
    // listed with its literal numbers
    const direct = stats.get(statType)?.get(text) ?? (slot === 'cluster' && l.type === 'enchant' ? stats.get('enchant')?.get(l.text.trim()) : undefined) ?? (l.type === 'fractured' ? stats.get('explicit')?.get(text) : undefined) ?? (slot === 'cluster' ? stats.get('explicit')?.get(text) ?? stats.get('enchant')?.get(text) : undefined);
    // trade lists some signed stats once, as "+#" ("-49 Physical Damage taken from Hits by Animals"
    // is "+# ..." with -49): search those with the value negated, as a ceiling
    const negated = !direct && text.startsWith('-#') ? stats.get(statType)?.get(`+#${text.slice(2)}`) : undefined;
    const candidates = direct ?? negated ?? [];
    const pick = candidates.find((c) => c.local === preferLocal) ?? candidates[0];
    const aff = l.explicitIdx !== null && rep ? rep.lines[l.explicitIdx] : null;
    const tier = { tier: aff?.tier ?? null, tiers: aff?.tiers ?? null };
    const searchable = own(l.type);
    // implicits are shared by every item of the base (eldritch/influence implicits: TODO)
    const weight = searchable ? modWeight(l.norm, l.values, ctx, tier, pick?.id) : 0;
    const rule = searchable ? modWeight(l.norm, l.values, ctx, tier) : 0;
    return {
      key: l.key, type: l.type, text: l.text, statId: pick?.id ?? null, values: l.values, weight,
      ...(weight !== rule ? { learned: learnedFor(slot, pick?.id)?.why } : {}),
      enabled: false,
      ...(negated?.length && l.values.length ? { min: null, max: -roundDown(avg(l.values)) } : { min: l.values.length ? roundDown(avg(l.values)) : null, max: null }),
      affix: aff?.affix ?? null, tier: tier.tier, tiers: tier.tiers, themes: modThemes(l.norm),
    };
  });

  const hasMs = lines.some((l) => l.norm === '#% increased Movement Speed' && (l.values[0] ?? 0) >= 20);

  // pseudo totals over every line (implicit + explicit + crafted), like the trade site computes them
  const totals: Contribution = { life: 0, ele: 0, chaos: 0 };
  const uncrafted: Contribution = { life: 0, ele: 0, chaos: 0 };
  lines.forEach((l, i) => {
    const c = contribution(l.norm, l.values);
    for (const k of ['life', 'ele', 'chaos'] as const) {
      totals[k] += c[k];
      if (l.type !== 'crafted') uncrafted[k] += c[k];
    }
    const lifeOwnLine = slot === 'abyss' && c.life && !c.ele && !c.chaos;
    if (valuable && (c.life || c.ele || c.chaos) && l.type !== 'implicit' && !lifeOwnLine) {
      mods[i].covered = c.life ? 'pseudo:life' : c.ele ? 'pseudo:ele' : 'pseudo:chaos';
    }
  });

  const rows: ModAnalysis[] = [];
  const pseudo = (key: string, statId: string, text: string, value: number, weight: number): ModAnalysis => ({
    key, type: 'pseudo', text, statId, values: [value], weight, enabled: false, min: roundDown(value), max: null,
  });
  let dps: Analysis['dps'] = null;
  let craft: Craft | null = null;
  let craftedWeights: Scored[] | null = null;

  if (valuable) {
    if (totals.life >= 1 && slot !== 'abyss') rows.push(pseudo('pseudo:life', 'pseudo.pseudo_total_life', `+${Math.floor(totals.life)} total maximum Life`, Math.floor(totals.life), lifeWeight(slot, uncrafted.life)));
    if (totals.ele >= 1) rows.push(pseudo('pseudo:ele', 'pseudo.pseudo_total_elemental_resistance', `+${totals.ele}% total Elemental Resistance`, totals.ele, eleResWeight(slot, uncrafted.ele)));
    // Life too low to count and no free prefix to craft it (or corrupted): to a life build the item is
    // dead weight, and buyers of the same lines with real life are a different market. Those stay out
    // of every search, the ladder never gives this up: dropping our weak life line alone would price
    // the item like its well-rolled cousins (the cheapest of them, with 60 life, is not our price).
    // Energy-shield pieces are exempt, their buyers often run no life at all.
    const esPiece = (ARMOUR_SLOTS.includes(slot) && ctx.defences.size === 1 && ctx.defences.has('int')) || lines.some((l) => own(l.type) && /Energy Shield/.test(l.norm) && modWeight(l.norm, l.values, ctx) >= 2);
    const noRoom = !!item.corrupted || rep?.openPrefix === 0;
    if (LIFE_SLOTS.includes(slot) && lifeWeight(slot, totals.life) === 0 && noRoom && !esPiece) {
      const floor = lifeFloor(slot);
      rows.push({
        key: 'cap:life', type: 'pseudo', text: `total Life below ${floor} (${item.corrupted ? 'corrupted' : 'no free prefix to craft life'})`,
        statId: 'pseudo.pseudo_total_life', values: [Math.floor(totals.life)], weight: 0, enabled: true, required: true, negate: true, min: floor, max: null,
      });
    }
    // Same idea per line: a low-tier roll of a mod buyers pay for (T8 lightning to attacks) is not
    // comparable to the same mod rolled well. Items with a decent roll of it stay out of every search,
    // also once our line is given up, so the price never comes from the well-rolled cousins.
    lines.forEach((l, i) => {
      const m = mods[i];
      const decent = l.explicitIdx !== null ? rep?.lines[l.explicitIdx]?.decent : null;
      if (decent == null || !m.statId || m.covered || !own(l.type) || modWeight(l.norm, l.values, ctx, undefined, m.statId) < 2) return;
      const at = decent >= 10 ? Math.floor(decent) : Math.floor(decent * 10) / 10;
      rows.push({
        key: `cap:${m.key}`, type: 'pseudo', text: `${l.norm.replace(/#/g, '…')} below ${at} (yours is T${m.tier} of ${m.tiers})`,
        statId: m.statId, values: [avg(l.values)], weight: 0, enabled: true, required: true, negate: true, min: at, max: null,
      });
    });
    if (totals.chaos >= 1) rows.push(pseudo('pseudo:chaos', 'pseudo.pseudo_total_chaos_resistance', `+${totals.chaos}% total Chaos Resistance`, totals.chaos, chaosResWeight(slot, uncrafted.chaos)));

    // defences: one property row per defence type, weighted by the tiers of local defence mods
    if (ARMOUR_SLOTS.includes(slot)) {
      // % local defence carries the value; flat rolls (and hybrid flat+life/stun rolls) only add to it
      const defMods = mods.filter((m) => m.type === 'explicit' || m.type === 'fractured').filter((m) => LOCAL_DEF.test(normalizeMod(m.text).norm));
      const pct = defMods.filter((m) => normalizeMod(m.text).norm.startsWith('#% increased') && !(rep?.lines[Number(m.key.split(':')[1])]?.hybrid));
      const flat = defMods.filter((m) => !pct.includes(m) && !(rep?.lines[Number(m.key.split(':')[1])]?.hybrid));
      const tierOk = (m: ModAnalysis, t: number) => !!m.tier && m.tier <= t;
      const big = slot === 'chest' || slot === 'shield';
      let w = pct.some((m) => tierOk(m, 2)) ? (flat.some((m) => tierOk(m, 3)) || big ? 3 : 2) : pct.some((m) => tierOk(m, 3)) ? 2 : defMods.length ? 1 : 0;
      if (!big && !ctx.defences.has('int')) w = Math.min(w, 2); // armour/evasion on small slots: nice to have, rarely the reason to buy
      for (const [name, f, label] of [['Armour', 'ar', 'Armour'], ['Evasion Rating', 'ev', 'Evasion'], ['Energy Shield', 'es', 'Energy Shield']] as const) {
        const p = prop(item, name);
        if (!p) continue;
        const v = Number(p.values?.[0]?.[0] ?? 0);
        rows.push({ key: `prop:${f}`, type: 'prop', text: `${label} ≥ ${v}`, statId: `prop:armour_filters.${f}`, values: [v], weight: w, enabled: false, min: roundDown(v), max: null });
      }
      if (w) for (const m of defMods) m.covered = 'prop:def';
    }

    // weapons: DPS rows instead of individual damage lines (unless it's a caster weapon)
    const wd = slot === 'weapon' ? weaponDps(item) : null;
    if (wd && !ctx.caster && wd.total > 0) {
      dps = { pdps: wd.pdps, edps: wd.edps, cdps: wd.cdps, total: wd.total };
      const dmgMods = mods.filter((m) => m.type === 'explicit' || m.type === 'fractured');
      const tierScore = (re: RegExp) => dmgMods.filter((m) => re.test(normalizeMod(m.text).norm) && m.tier && m.tier <= 2).length;
      const physGood = tierScore(PHYS_DMG) + tierScore(ATK);
      const eleGood = tierScore(ELE_DMG) + tierScore(ATK);
      const physLead = wd.pdps >= wd.edps;
      const wP = physGood >= 2 ? 3 : physGood === 1 ? 2 : 1;
      const wE = eleGood >= 2 ? 3 : eleGood === 1 ? 2 : 1;
      if (wd.pdps > 0) rows.push({ key: 'prop:pdps', type: 'prop', text: `Physical DPS ≥ ${wd.pdps}`, statId: 'prop:weapon_filters.pdps', values: [wd.pdps], weight: physLead ? wP : 1, enabled: false, min: roundDown(wd.pdps), max: null });
      if (wd.edps > 0) rows.push({ key: 'prop:edps', type: 'prop', text: `Elemental DPS ≥ ${wd.edps}`, statId: 'prop:weapon_filters.edps', values: [wd.edps], weight: physLead ? 1 : wE, enabled: false, min: roundDown(wd.edps), max: null });
      rows.push({ key: 'prop:dps', type: 'prop', text: `Total DPS ≥ ${wd.total}`, statId: 'prop:weapon_filters.dps', values: [wd.total], weight: 0, enabled: false, min: roundDown(wd.total), max: null });
      for (const m of dmgMods) if (PHYS_DMG.test(normalizeMod(m.text).norm) || ELE_DMG.test(normalizeMod(m.text).norm) || normalizeMod(m.text).norm === '#% increased Attack Speed') m.covered = 'prop:dps';
    }

    // open affixes
    if (rep) {
      if (rep.openPrefix) rows.push({ key: 'pseudo:openp', type: 'pseudo', text: `${rep.openPrefix} open prefix`, statId: 'pseudo.pseudo_number_of_empty_prefix_mods', values: [rep.openPrefix], weight: 0, enabled: false, min: 1, max: null });
      if (rep.openSuffix) rows.push({ key: 'pseudo:opens', type: 'pseudo', text: `${rep.openSuffix} open suffix`, statId: 'pseudo.pseudo_number_of_empty_suffix_mods', values: [rep.openSuffix], weight: 0, enabled: false, min: 1, max: null });
    }

    // best bench craft: the one that adds most to the score (life/res totals, DPS, or a good mod)
    if (rep && db) {
      const opts = benchOptions(item, rep, db);
      const incPhys = mods.filter((m) => normalizeMod(m.text).norm === '#% increased Physical Damage' && m.type !== 'implicit').reduce((a, m) => a + (m.values[0] ?? 0), 0) / 100;
      const incAps = mods.filter((m) => normalizeMod(m.text).norm === '#% increased Attack Speed' && m.type !== 'implicit').reduce((a, m) => a + (m.values[0] ?? 0), 0) / 100;
      const baseWeights = new Map(rows.map((r) => [r.key, r.weight]));
      let best: { gain: number; craft: Craft; mins: Map<string, number>; weights: Map<string, Scored> } | null = null;
      for (const o of opts) {
        const top = o.lines.map((l) => ({ norm: l.norm, ranges: l.ranges }));
        const mins = new Map<string, number>();
        const weights = new Map<string, Scored>(baseWeights);
        let gain = 0;
        let gainText = '';
        const c = top.map((l) => contribution(l.norm, l.ranges.map((r) => Math.min(...r)))).reduce((a, b) => ({ life: a.life + b.life, ele: a.ele + b.ele, chaos: a.chaos + b.chaos }), { life: 0, ele: 0, chaos: 0 });
        // a craft replacing an existing bench mod loses that mod's contribution
        const lost = o.replacesCrafted ? lines.filter((l, i) => l.type === 'crafted' && mods[i].affix === o.affix).map((l) => contribution(l.norm, l.values)).reduce((a, b) => ({ life: a.life + b.life, ele: a.ele + b.ele, chaos: a.chaos + b.chaos }), { life: 0, ele: 0, chaos: 0 }) : { life: 0, ele: 0, chaos: 0 };
        const delta = (key: string, cur: number, add: number, wf: (s: Slot, v: number) => number, label: string) => {
          if (!add) return;
          const nv = Math.floor(cur + add);
          const nw = wf(slot, nv);
          gain += nw - (baseWeights.get(key) ?? 0) + add / 1000;
          weights.set(key, nw);
          mins.set(key, roundDown(nv));
          gainText = `${label} → ${nv}`;
        };
        delta('pseudo:life', totals.life - lost.life, c.life, lifeWeight, 'total life');
        delta('pseudo:ele', totals.ele - lost.ele, c.ele, eleResWeight, 'total ele res');
        delta('pseudo:chaos', totals.chaos - lost.chaos, c.chaos, chaosResWeight, 'total chaos res');
        if (wd && dps) {
          const after = dpsWithCraft(wd, top, incPhys, incAps);
          if (after.total > dps.total) {
            const physLead = after.pdps >= after.edps;
            mins.set('prop:pdps', roundDown(after.pdps));
            mins.set('prop:edps', roundDown(after.edps));
            mins.set('prop:dps', roundDown(after.total));
            gain += (after.total / dps.total - 1) * 10; // +10% dps ~ one weight point
            gainText = `${physLead ? 'pDPS' : 'eDPS'} ${physLead ? dps.pdps : dps.edps} → ${physLead ? after.pdps : after.edps}`;
          }
        }
        if (!gainText) {
          const w = modWeight(top[0].norm, top[0].ranges.map((r) => Math.max(...r)), ctx);
          if (w >= 2) {
            gain = w - 1;
            // boots without movement speed barely sell: a speed craft beats everything else
            if (slot === 'boots' && top[0].norm === '#% increased Movement Speed' && !hasMs) gain += 3;
            gainText = `+${o.affix} worth ${w}`;
            weights.set(`craft:${top[0].norm}`, { w, t: modThemes(top[0].norm) });
          }
        }
        if (gain > 0 && (!best || gain > best.gain)) {
          const shown = o.lines.map((l) => l.norm.replace(/#/g, () => '?')).join(' / ');
          const ranges = o.lines.flatMap((l) => l.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)));
          let k = 0;
          const text = shown.replace(/\?/g, () => `(${ranges[k++] ?? '?'})`);
          best = { gain, craft: { text, affix: o.affix, cost: o.cost, gain: gainText, replacesCrafted: o.replacesCrafted }, mins, weights };
        }
      }
      if (best) {
        craft = best.craft;
        for (const r of rows) r.minCrafted = best.mins.get(r.key) ?? r.min;
        craftedWeights = [...best.weights.values()];
      }
    }
  }

  // default selection: ticked = weight >= 2 and outside every total row
  for (const m of mods) m.enabled = valuable && !!m.statId && !m.covered && own(m.type) && m.weight >= 2;
  for (const r of rows) r.enabled = r.weight >= 2 || !!r.negate;
  for (const m of mods) if (slot === 'boots' && m.enabled && normalizeMod(m.text).norm === '#% increased Movement Speed') m.required = true;
  // clusters: passive count and enchant say what the jewel is, so no search goes without them. Fewer
  // passives make a dearer jewel, so the count is matched exactly.
  for (const m of mods) {
    if (slot !== 'cluster' || !m.enabled || !CLUSTER_IDENTITY.test(normalizeMod(m.text).norm)) continue;
    m.required = true;
    if (m.statId!.includes('|')) m.min = null;
    else m.min = m.max = m.values[0] ?? null;
  }
  const all = [...rows, ...mods];

  const scoreRows = all.filter((m) => !m.covered && (m.type === 'pseudo' || m.type === 'prop' || (own(m.type) && m.statId)));
  const scored = (m: ModAnalysis): Scored => ({ w: m.weight, t: m.themes });
  let { score, verdict } = kind === 'base' && valuable ? verdictOf(scoreRows.map(scored)) : { score: 0, verdict: 'n/a' as Verdict };
  if (valuable && (slot === 'cluster' || slot === 'viscera')) {
    // few lines carry the whole price: a notable or two (cluster), the roll(s) (viscera). A cluster
    // with the fewest passives its size allows is a crafting base, worth a look without notables.
    const good = scoreRows.filter((m) => m.weight >= 2 && !m.required);
    score = good.reduce((a, m) => a + m.weight, 0);
    const passives = mods.find((m) => /^Adds # Passive Skills$/.test(normalizeMod(m.text).norm))?.values[0];
    const fewest = { Large: 8, Medium: 4, Small: 2 }[String(clean(item.baseType)).split(' ')[0]];
    const base = passives != null && passives === fewest;
    verdict = slot === 'cluster' ? (good.length >= 2 ? 'check' : good.length === 1 || base ? 'maybe' : 'skip') : good.length ? (good.some((m) => m.weight >= 3) ? 'check' : 'maybe') : 'skip';
  }
  // magic items: one prefix and one suffix at most, so a single good line is the whole item
  if (valuable && item.frameType === 1 && slot !== 'cluster' && slot !== 'viscera') {
    verdict = scoreRows.some((m) => m.weight >= 3) ? 'check' : scoreRows.some((m) => m.weight >= 2) ? 'maybe' : 'skip';
  }
  // craft base: a top-tier useful mod with room left to craft on
  if (verdict === 'skip' && rep && rep.openPrefix + rep.openSuffix > 0 && mods.some((m) => own(m.type) && m.tier === 1 && m.weight >= 2)) verdict = 'maybe';
  let crafted = craftedWeights ? verdictOf([...craftedWeights, ...scoreRows.filter((m) => m.type !== 'pseudo' && m.type !== 'prop').map(scored)]) : { score, verdict };
  // boots without real movement speed: at best "maybe", whatever else they have
  const capBoots = (v: Verdict): Verdict => (slot === 'boots' && v === 'check' ? 'maybe' : v);
  if (!hasMs) verdict = capBoots(verdict);
  if (!hasMs && !(craft && /Movement Speed/.test(craft.text))) crafted = { ...crafted, verdict: capBoots(crafted.verdict) };
  const useCraft = !!craft && crafted.score > score && crafted.verdict !== 'skip';

  // With many rows ticked, requiring all of them returns nothing; allow one or two misses.
  const ticked = all.filter((m) => m.enabled && !m.required && !(m.statId ?? '').startsWith('prop:')).length;
  // clusters: price follows the best pair of notables, so a third one is allowed to miss
  const matchAtLeast = slot === 'cluster' && ticked >= 3 ? 2 : ticked >= 4 ? Math.max(3, Math.ceil(ticked * 0.75)) : null;
  const ilvlMin = slot === 'cluster' && item.ilvl ? ([84, 75, 68].find((n) => item.ilvl >= n) ?? null) : null;

  const sockets: any[] = item.sockets ?? [];
  const groups = new Map<number, number>();
  for (const s of sockets) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
  const links = groups.size ? Math.max(...groups.values()) : 0;
  const name = clean(item.name);
  const baseType = clean(item.baseType) || clean(item.typeLine);
  const category = CATEGORY[slot] ?? null;
  return {
    kind, name, baseType, category,
    // the trade site lists "Greater Soldier's Head" as "Soldier's Head" (rejects the former as an
    // unknown base type); the bigger roll is what sets the two apart, and the stat filter has it
    tradeType: slot === 'viscera' ? baseType.replace(/^Greater /, '') : baseType,
    searchBy: category && kind === 'base' ? 'category' : 'type',
    mods: all,
    ilvl: item.ilvl ?? null,
    links,
    corrupted: !!item.corrupted,
    slot,
    affixes: rep ? { prefixes: rep.prefixes, suffixes: rep.suffixes, openPrefix: rep.openPrefix, openSuffix: rep.openSuffix, uncertain: rep.uncertain } : null,
    dps,
    craft,
    useCraft,
    score, verdict,
    craftedScore: crafted.score, craftedVerdict: crafted.verdict,
    // corruption decides the market: a clean item can still be crafted on, a corrupted one is final
    // (and may carry a corruption implicit), so each is compared only with its own kind
    filters: { ilvlMin, linksMin: links >= 5 ? links : null, corrupted: kind === 'base' ? (item.corrupted ? 'true' : 'false') : 'any', matchAtLeast },
  };
}

// The selection the UI starts with (and the background scanner uses as-is).
export function defaultSelection(a: Analysis): Selection {
  return {
    mods: a.mods.map((m) => ({ key: m.key, enabled: m.enabled, min: a.useCraft && m.minCrafted != null ? m.minCrafted : m.min, max: m.max })),
    ilvlMin: a.filters.ilvlMin,
    linksMin: a.filters.linksMin,
    corrupted: a.filters.corrupted,
    matchAtLeast: a.filters.matchAtLeast,
    searchBy: a.searchBy,
  };
}

// What the background pricer searches first: the whole item. Every own line with a trade stat,
// ticked or not (weight 0 too, so a mod the rules don't know about still narrows the comparables),
// the life/res totals, and the defence/DPS rows that carry value. The tier ladder then gives lines up
// one at a time, least important first, until enough comparables are listed.
const NOT_DESCRIBED = new Set(['pseudo:openp', 'pseudo:opens', 'prop:dps']);
export function describeSelection(a: Analysis): Selection {
  const on = (m: ModAnalysis) =>
    !!m.statId && !m.covered && !NOT_DESCRIBED.has(m.key) && (m.type === 'pseudo' ? true : m.type === 'prop' ? m.weight >= 1 : ownType(a.slot, m.type));
  return {
    mods: a.mods.map((m) => ({ key: m.key, enabled: on(m), min: m.min, max: m.max })),
    ilvlMin: a.filters.ilvlMin,
    linksMin: a.filters.linksMin,
    corrupted: a.filters.corrupted,
    matchAtLeast: null,
    searchBy: a.searchBy,
  };
}

// Enabled lines in the order to give up on them when too few comparables are listed: lowest weight
// first, then the worse roll for its tier range, then later rows. Required lines never go.
export function dropOrder(a: Analysis, sel: Selection): string[] {
  const on = new Set(sel.mods.filter((m) => m.enabled).map((m) => m.key));
  const quality = (m: ModAnalysis) => (m.tier && m.tiers && m.tiers > 1 ? 1 - (m.tier - 1) / (m.tiers - 1) : 0.5);
  return a.mods
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => on.has(m.key) && !m.required && m.statId)
    .sort((x, y) => x.m.weight - y.m.weight || quality(x.m) - quality(y.m) || y.i - x.i)
    .map(({ m }) => m.key);
}

// Trade API status options: 'available'/'online' = normal listings, 'securable' = Merchant Only
// (instant buyout). Rares are priced from instant-buyout listings only: those are actual offers at
// the listed price, while in-person listings are often stale or used for price fixing.
const tradeStatus = (item: any) => (priceable(item) ? 'securable' : 'online');

export function buildQuery(item: any, analysis: Analysis, sel: Selection) {
  const query: any = { status: { option: tradeStatus(item) }, stats: [{ type: 'and', filters: [] }], filters: {} };
  if (analysis.kind === 'unique') {
    query.name = analysis.name;
    query.type = analysis.baseType;
  } else if ((sel.searchBy ?? analysis.searchBy) === 'category' && analysis.category) {
    query.filters.type_filters = { filters: { category: { option: analysis.category }, rarity: { option: 'nonunique' } } };
  } else {
    query.type = analysis.tradeType ?? analysis.baseType;
  }
  // a magic item competes with other magic items (a rare with the same two mods has more on it)
  if (item.frameType === 1 && analysis.kind !== 'unique') {
    query.filters.type_filters ??= { filters: {} };
    query.filters.type_filters.filters.rarity = { option: 'magic' };
  }

  const byKey = new Map(analysis.mods.map((m) => [m.key, m]));
  const filters: any[] = [];
  const required: any[] = [];
  const negated: any[] = [];
  for (const s of sel.mods) {
    const mod = byKey.get(s.key);
    if (!mod || !mod.statId || !s.enabled) continue;
    const value: any = {};
    if (s.min !== null) value.min = s.min;
    if (s.max !== null) value.max = s.max;
    if (mod.statId.startsWith('prop:')) {
      const [group, f] = mod.statId.slice(5).split('.');
      query.filters[group] ??= { filters: {} };
      query.filters[group].filters[f] = value;
    } else {
      // "stat|option": a stat with named options, like a cluster's enchant
      const [id, option] = mod.statId.split('|');
      (mod.negate ? negated : mod.required ? required : filters).push({ id, value: option ? { option: Number(option) } : value, disabled: false });
    }
  }
  const groups: any[] = [];
  if (required.length) groups.push({ type: 'and', filters: required });
  if (filters.length) {
    const n = sel.matchAtLeast;
    groups.push(n && n < filters.length ? { type: 'count', value: { min: n }, filters } : { type: 'and', filters });
  }
  if (negated.length) groups.push({ type: 'not', filters: negated });
  if (groups.length) query.stats = groups;

  const misc: any = {};
  if (sel.ilvlMin !== null) misc.ilvl = { min: sel.ilvlMin };
  if (sel.corrupted !== 'any') misc.corrupted = { option: sel.corrupted };
  if (Object.keys(misc).length) query.filters.misc_filters = { filters: misc };
  if (sel.linksMin !== null) query.filters.socket_filters = { filters: { links: { min: sel.linksMin } } };

  return { query, sort: { price: 'asc' } };
}
