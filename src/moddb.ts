// Mod database built from RePoE (https://repoe-fork.github.io): which explicit line is a prefix or
// suffix, its tier on this base, and which bench crafts fit. The stash API gives neither.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cached } from './cache.ts';

export type Affix = 'prefix' | 'suffix';
type Line = { norm: string; ranges: [number, number][] };
export type ModDef = { id: string; name: string; gen: Affix; type: string; domain: string; lvl: number; lines: Line[]; spawn: [string, number][]; crafted: boolean };
export type Bench = { mod: ModDef; classes: string[]; cost: string };
export type ModDb = { bases: Record<string, { cls: string; tags: string[]; domain: string }>; mods: ModDef[]; bench: Bench[] };

const REPOE = 'https://repoe-fork.github.io';
const CURRENCY: Record<string, string> = {
  CurrencyRerollMagic: 'alt', CurrencyUpgradeToMagic: 'transmute', CurrencyAddModToMagic: 'aug', CurrencyUpgradeToRare: 'alch',
  CurrencyRerollRare: 'chaos', CurrencyAddModToRare: 'exalt', CurrencyUpgradeMagicToRare: 'regal', CurrencyModValues: 'divine',
  CurrencyRerollSocketColours: 'chrom', CurrencyRerollSocketLinks: 'fusing', CurrencyRerollSocketNumbers: 'jeweller',
  CurrencyPassiveSkillRefund: 'regret', CurrencyConvertToNormal: 'scour', CurrencyRerollImplicit: 'blessed', CurrencyCorrupt: 'vaal',
  CurrencyRerollDefences: 'sacred', CurrencyDuplicate: 'mirror', CurrencyArmourQuality: 'scrap', CurrencyWeaponQuality: 'whetstone',
};

// "+(70-79) to maximum Life" -> norm "+# to maximum Life", ranges [[70,79]]
const stripMarkup = (s: string) => s.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1');

export function parseDefLine(text: string): Line {
  const ranges: [number, number][] = [];
  const norm = stripMarkup(text).replace(/\((-?[\d.]+)-(-?[\d.]+)\)|(-?[\d.]+)/g, (_m, a, b, n) => {
    ranges.push(n !== undefined ? [+n, +n] : [+a, +b]);
    return '#';
  });
  return { norm: norm.replace(/#(?=-)/, '#'), ranges };
}

// Stash text: strip "[Tag|Shown]" markup, numbers -> '#'.
export function parseItemLine(text: string): { norm: string; values: number[] } {
  const values: number[] = [];
  const norm = stripMarkup(text).replace(/\d+(\.\d+)?/g, (m) => {
    values.push(parseFloat(m));
    return '#';
  });
  return { norm, values };
}

// Raw files are kept in .cache/repoe so a flaky connection only has to fetch them once.
async function getJson(file: string) {
  const local = join(import.meta.dirname, '..', '.cache', 'repoe', file);
  try {
    return JSON.parse(await readFile(local, 'utf8'));
  } catch {}
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${REPOE}/${file}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`RePoE ${file}: ${res.status}`);
      const text = await res.text();
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, text);
      return JSON.parse(text);
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}

async function build(): Promise<ModDb> {
  const [rawBases, rawMods, rawBench] = await Promise.all([getJson('base_items.min.json'), getJson('mods.min.json'), getJson('crafting_bench_options.min.json')]);
  const bases: ModDb['bases'] = {};
  for (const b of Object.values<any>(rawBases)) {
    if (b.release_state !== 'released' || bases[b.name]) continue;
    bases[b.name] = { cls: b.item_class, tags: b.tags, domain: b.domain };
  }
  const toDef = (id: string, m: any): ModDef => ({
    id, name: m.name, gen: m.generation_type, type: m.type, domain: m.domain, lvl: m.required_level,
    lines: String(m.text ?? '').split('\n').filter(Boolean).map(parseDefLine),
    spawn: (m.spawn_weights ?? []).map((s: any) => [s.tag, s.weight]),
    crafted: m.domain === 'crafted' || m.domain === 'unveiled',
  });
  const mods: ModDef[] = [];
  const byId = new Map<string, ModDef>();
  for (const [id, m] of Object.entries<any>(rawMods)) {
    if (!['item', 'crafted', 'unveiled', 'delve', 'jewel', 'abyss_jewel'].includes(m.domain) || !['prefix', 'suffix'].includes(m.generation_type) || !m.text) continue;
    const d = toDef(id, m);
    byId.set(id, d);
    mods.push(d);
  }
  const bench: Bench[] = [];
  for (const o of rawBench) {
    const mod = byId.get(o.actions?.add_explicit_mod);
    if (!mod) continue;
    const cost = Object.entries<number>(o.cost ?? {}).map(([k, n]) => `${n} ${CURRENCY[k.split('/').pop()!] ?? k.split('/').pop()}`).join(' + ');
    bench.push({ mod, classes: o.item_classes, cost });
  }
  return { bases, mods, bench };
}

export type IndexedDb = ModDb & { byNorm: Map<string, ModDef[]> };
let db: Promise<IndexedDb> | null = null;

export function loadModDb(): Promise<IndexedDb> {
  db ??= cached('moddb-v3', 7 * 24 * 3600 * 1000, build).then((d) => {
    const byNorm = new Map<string, ModDef[]>();
    for (const m of d.mods) for (const l of m.lines) {
      if (!byNorm.has(l.norm)) byNorm.set(l.norm, []);
      byNorm.get(l.norm)!.push(m);
    }
    return { ...d, byNorm };
  }).catch((e) => {
    db = null; // retry on next call (flaky connections)
    throw e;
  });
  return db;
}

// --- per-item analysis -------------------------------------------------------------------------

export type ItemLine = { idx: number; text: string; norm: string; values: number[]; crafted: boolean; fractured: boolean };
// decent: for a low-tier roll (bottom 40% of its tiers), the trade value where the tiers above that
// band start (avg of the low ends, as trade averages "# to #"); null otherwise
export type LineInfo = { affix: Affix | null; tier: number | null; tiers: number | null; mod: string | null; hybrid: boolean; decent?: number | null };
export type AffixReport = {
  lines: LineInfo[];
  prefixes: number;
  suffixes: number;
  openPrefix: number;
  openSuffix: number;
  craftedAffix: Affix | null; // a bench mod that can be swapped out
  uncertain: boolean;
  cls: string | null;
};

export function itemTags(item: any, d: ModDb): { cls: string | null; tags: Set<string>; domain: string } {
  const base = d.bases[item.baseType];
  const tags = new Set<string>(base?.tags ?? []);
  // influence mods spawn on e.g. "boots_shaper", "ring_elder"
  for (const inf of Object.keys(item.influences ?? {})) for (const t of [...tags]) tags.add(`${t}_${inf}`);
  return { cls: base?.cls ?? null, tags, domain: base?.domain ?? 'item' };
}

// Mods only roll on bases of their own domain (item / jewel / abyss_jewel); bench and veiled
// crafts are item-domain.
export function sameDomain(m: ModDef, domain: string): boolean {
  return m.crafted || m.domain === 'delve' ? domain === 'item' : m.domain === domain;
}

export function spawnWeight(m: ModDef, tags: Set<string>, domain?: string): number {
  if (domain && !sameDomain(m, domain)) return 0;
  for (const [t, w] of m.spawn) if (tags.has(t)) return w;
  return 0;
}

const inRange = (vals: number[], ranges: [number, number][]) =>
  vals.length === ranges.length && vals.every((v, i) => v >= Math.min(...ranges[i]) - 0.01 && v <= Math.max(...ranges[i]) + 0.01);

export function explicitLines(item: any): ItemLine[] {
  return (item.explicitMods ?? []).map((m: any, idx: number) => {
    const text = typeof m === 'string' ? m : m.description;
    const { norm, values } = parseItemLine(text);
    return { idx, text, norm, values, crafted: !!m.flags?.crafted || (item.craftedMods ?? []).includes(m), fractured: !!m.flags?.fractured };
  });
}

type Pick = { mod: ModDef; lines: number[]; cost: number };

export function analyzeAffixes(item: any, d: ModDb & { byNorm: Map<string, ModDef[]> }): AffixReport {
  const maxAffix = item.frameType === 1 ? 1 : 3; // magic: one prefix, one suffix
  const lines = explicitLines(item);
  const { cls, tags, domain } = itemTags(item, d);
  const ilvl = item.ilvl ?? 100;

  // candidate mods per line: a mod fits if every one of its lines is on the item with values in range
  const options: Pick[][] = lines.map((l) => {
    const out: Pick[] = [];
    for (const m of d.byNorm.get(l.norm) ?? []) {
      if (m.crafted !== l.crafted || !sameDomain(m, domain)) continue;
      const used: number[] = [];
      const ok = m.lines.every((ml) => {
        const hit = lines.find((x) => !used.includes(x.idx) && x.norm === ml.norm && x.crafted === l.crafted && inRange(x.values, ml.ranges));
        if (hit) used.push(hit.idx);
        return !!hit;
      });
      if (!ok || !used.includes(l.idx)) continue;
      const w = m.crafted ? 1 : spawnWeight(m, tags, domain);
      // unspawnable (essence/delve/influence we can't see) mods are allowed but discouraged
      const cost = 1 + (w > 0 && m.lvl <= ilvl ? 0 : 0.6) - (m.lines.length > 1 ? 0.1 : 0);
      out.push({ mod: m, lines: used, cost });
    }
    return out.sort((a, b) => a.cost - b.cost);
  });

  // backtracking: cover each line once, <=3 prefixes, <=3 suffixes, minimal cost
  let best: { picks: Pick[]; cost: number } | null = null;
  const covered = new Set<number>();
  const picks: Pick[] = [];
  let budget = 20000;
  const go = (cost: number, p: number, s: number) => {
    if (--budget < 0 || (best && cost >= best.cost)) return;
    const i = lines.findIndex((l) => !covered.has(l.idx));
    if (i < 0) return void (best = { picks: [...picks], cost });
    const seen = new Set<string>();
    for (const o of options[i]) {
      if (o.lines.some((x) => covered.has(x))) continue;
      const sig = `${o.mod.gen}|${o.lines.join(',')}|${o.cost}`;
      if (seen.has(sig)) continue; // same shape, different tier: first is enough for counting
      seen.add(sig);
      const np = p + (o.mod.gen === 'prefix' ? 1 : 0), ns = s + (o.mod.gen === 'suffix' ? 1 : 0);
      if (np > maxAffix || ns > maxAffix) continue;
      o.lines.forEach((x) => covered.add(x));
      picks.push(o);
      go(cost + o.cost, np, ns);
      picks.pop();
      o.lines.forEach((x) => covered.delete(x));
    }
    // unknown line (merged stats, unseen mod): skip it with a penalty
    covered.add(lines[i].idx);
    go(cost + 3, p, s);
    covered.delete(lines[i].idx);
  };
  go(0, 0, 0);

  const info: LineInfo[] = lines.map(() => ({ affix: null, tier: null, tiers: null, mod: null, hybrid: false }));
  let prefixes = 0, suffixes = 0, craftedAffix: Affix | null = null, uncertain = false;
  const chosen = (best as { picks: Pick[] } | null)?.picks ?? [];
  for (const pk of chosen) {
    if (pk.mod.gen === 'prefix') prefixes++;
    else suffixes++;
    if (pk.mod.crafted) craftedAffix = pk.mod.gen;
    const t = tierOf(pk, lines, d, tags, domain);
    for (const x of pk.lines) info[x] = { affix: pk.mod.gen, tier: t?.tier ?? null, tiers: t?.of ?? null, mod: pk.mod.id, hybrid: pk.lines.length > 1, decent: pk.lines.length > 1 ? null : t?.decent ?? null };
  }
  // lines nobody could explain: guess affix from the text alone so open-slot counts stay sane
  lines.forEach((l, i) => {
    if (info[i].affix) return;
    uncertain = true;
    const gens = new Set((d.byNorm.get(l.norm) ?? []).filter((m) => sameDomain(m, domain)).map((m) => m.gen));
    if (gens.size === 1) {
      const g = [...gens][0];
      info[i].affix = g;
      if (g === 'prefix') prefixes++;
      else suffixes++;
    }
  });
  const maxP = item.frameType === 1 ? 1 : 3;
  return {
    lines: info,
    prefixes, suffixes,
    openPrefix: Math.max(0, maxP - prefixes),
    openSuffix: Math.max(0, maxP - suffixes),
    craftedAffix, uncertain, cls,
  };
}

// Tier among mods of the same family that can roll on this base: 1 = best.
function tierOf(pk: Pick, lines: ItemLine[], d: ModDb & { byNorm: Map<string, ModDef[]> }, tags: Set<string>, domain: string) {
  if (pk.mod.crafted) return null;
  const key = pk.mod.lines.map((l) => l.norm).join('|');
  const fam = (d.byNorm.get(pk.mod.lines[0].norm) ?? []).filter(
    (m) => !m.crafted && m.gen === pk.mod.gen && m.type === pk.mod.type && m.lines.map((l) => l.norm).join('|') === key && spawnWeight(m, tags, domain) > 0,
  );
  if (!fam.length) return null;
  const top = (m: ModDef) => Math.max(...m.lines[0].ranges.map((r) => Math.max(...r.map(Math.abs))));
  fam.sort((a, b) => top(b) - top(a));
  // the matched mod may be one of several with identical ranges; locate by the line's actual value
  const v = lines[pk.lines[0]].values;
  const i = fam.findIndex((m) => inRange(v, m.lines[0].ranges));
  if (i < 0) return null;
  // low band as valuation.ts caps it: tier >= 60% of the tier count (3+ tiers)
  const lowFrom = Math.ceil(fam.length * 0.6);
  let decent: number | null = null;
  if (fam.length >= 3 && lowFrom >= 2 && i + 1 >= lowFrom) {
    const lows = fam[lowFrom - 2].lines[0].ranges.map((r) => Math.min(...r));
    if (lows.every((x) => x > 0)) decent = lows.reduce((a, b) => a + b, 0) / lows.length;
  }
  return { tier: i + 1, of: fam.length, decent };
}

// Bench crafts that fit this item now: right class, open slot (or swap the existing crafted mod),
// and not a family already on the item. Best tier per family.
export function benchOptions(item: any, rep: AffixReport, d: ModDb & { byNorm: Map<string, ModDef[]> }) {
  if (!rep.cls || item.frameType !== 2) return [];
  const present = new Set(rep.lines.map((l) => l.mod && d.mods.find((m) => m.id === l.mod)?.type).filter(Boolean));
  const best = new Map<string, Bench>();
  for (const b of d.bench) {
    if (!b.classes.includes(rep.cls) || present.has(b.mod.type)) continue;
    const slotFree = (b.mod.gen === 'prefix' ? rep.openPrefix : rep.openSuffix) > 0 || rep.craftedAffix === b.mod.gen;
    if (!slotFree) continue;
    const k = `${b.mod.gen}|${b.mod.lines.map((l) => l.norm).join('|')}`;
    const cur = best.get(k);
    if (!cur || b.mod.lvl > cur.mod.lvl) best.set(k, b);
  }
  return [...best.values()].map((b) => ({
    affix: b.mod.gen,
    text: b.mod.lines.map((l) => l.norm.replace(/#/g, () => '#')).join(' / '),
    lines: b.mod.lines,
    cost: b.cost,
    replacesCrafted: (b.mod.gen === 'prefix' ? rep.openPrefix : rep.openSuffix) === 0,
  }));
}
