// Stash search strings. The in-game stash search takes a quoted regex (case-insensitive, at most 50
// characters) and lights up every item whose text it matches. For a group of items to sell together
// we want strings that between them light up every item of the group and nothing else in the stash.
//
// Safety runs one way on purpose:
// - "nothing else" is checked against everything the game might match on: names, mods, properties,
//   requirements, item level, flavour text, notes, socketed gems, plus the labels every item shows
//   (Item Class, Rarity, Requires, ...). Over-including only makes fragments a little longer.
// - a fragment only counts as hitting a target if it sits in the target's name or mod lines, text
//   the search certainly sees, so a string never silently misses an item it claims.
//
// Fragments are picked by greedy set cover (most targets per character) and packed into as few
// strings as fit, since every string is one paste-and-move round in game.
export const LIMIT = 50;
const MAXL = 12; // fragments up to this length are checked against an index; longer ones by scan

// literal text only: no regex metacharacters, and no apostrophes or commas, which the game may
// treat differently from the API text
const ALLOWED = /^[a-z0-9 %-]+$/;
const fine = (f: string) => f[0] !== ' ' && f.at(-1) !== ' ' && /[a-z%]/.test(f);

const strip = (s: unknown) =>
  String(s ?? '')
    .replace(/<<.*?>>/g, '')
    .replace(/<[^>]*>\{([^}]*)\}/g, '$1')
    .replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2')
    .replace(/\[([^\]]*)\]/g, '$1');
const textOf = (m: any): string => (typeof m === 'string' ? m : m?.description ?? '');
const lines = (parts: unknown[]) =>
  parts
    .flatMap((p) => strip(p).toLowerCase().split('\n'))
    .map((l) => l.trim())
    .filter(Boolean);

// Text every item carries in game whatever it is. A fragment found here would light up everything.
const BOILERPLATE = lines([
  'Item Class: Rarity: Normal Magic Rare Unique Gem Currency Divination Card Quest Item',
  'Requirements: Requires Level Str Dex Int Strength Dexterity Intelligence',
  'Sockets: Item Level: Quality: Stack Size: Corrupted Mirrored Unidentified Unmodifiable Split Fractured Item Synthesised Item',
  '(implicit) (crafted) (enchant) (fractured) (augmented) (unmet) (scourge) (veiled) (crucible) Mutated Foulborn',
  'Searing Exarch Item Eater of Worlds Item Shaper Item Elder Item Crusader Item Hunter Item Redeemer Item Warlord Item',
  'Note: ~price ~b/o chaos divine exalted',
  'Stackable Currency Amulets Rings Claws Daggers Rune Daggers Wands One Hand Swords Thrusting One Hand Swords One Hand Axes',
  'One Hand Maces Sceptres Bows Staves Warstaves Two Hand Swords Two Hand Axes Two Hand Maces Fishing Rods Quivers Belts',
  'Gloves Boots Body Armours Helmets Shields Jewels Abyss Jewels Life Flasks Mana Flasks Hybrid Flasks Utility Flasks Tinctures',
  'Maps Map Fragments Misc Map Items Active Skill Gems Support Skill Gems Divination Cards Heist Targets Contracts Blueprints',
  'Trinkets Heist Gear Heist Tools Heist Cloaks Heist Brooches Expedition Logbooks Sanctum Relics Memories Corpses Idols',
  'Grafts Wombgifts Viscera Incubators Delirium Orbs Essences Fossils Resonators Oils Catalysts Scarabs Breachstones',
]);

// Lines the stash search certainly sees: a fragment in these is a guaranteed hit.
function trustedLines(item: any): string[] {
  const parts: unknown[] = [item.name, item.typeLine];
  for (const f of ['implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods', 'enchantMods']) for (const m of item[f] ?? []) parts.push(textOf(m));
  return lines(parts);
}

const SKIP_KEYS = new Set(['icon', 'id', 'inventoryId', 'league', 'srcL', 'srcC', 'srcR', 'artFilename']);
// Everything the stash search could possibly match on.
function hayLines(item: any): string[] {
  const parts: unknown[] = [];
  const walk = (v: any, key = '') => {
    if (SKIP_KEYS.has(key)) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(item);
  // properties and requirements as the game prints them ("Quality: +20%", "Requires Level 68")
  for (const f of ['properties', 'additionalProperties', 'requirements', 'nextLevelRequirements', 'notableProperties']) {
    for (const p of item[f] ?? []) {
      const vals: string[] = (p.values ?? []).map((v: any) => String(v?.[0] ?? ''));
      let i = 0;
      const name = String(p.name ?? '').replace(/\{\d+\}/g, () => vals[i++] ?? '');
      parts.push(`${name}: ${vals.join(', ')}`, `${name} ${vals.join(' ')}`);
    }
  }
  // the game prints requirements on one line, attributes value first: "Requires Level 68, 100 Str"
  const req = (item.requirements ?? []).map((r: any) => [String(r.name ?? ''), String(r.values?.[0]?.[0] ?? '')]);
  if (req.length) parts.push(`Requires ${req.map(([n, v]: string[]) => (/^Level$/i.test(n) ? `${n} ${v}` : `${v} ${n}`)).join(', ')}`);
  const sockets: any[] = item.sockets ?? [];
  if (sockets.length) {
    const g = new Map<number, string[]>();
    for (const so of sockets) g.set(so.group, [...(g.get(so.group) ?? []), so.sColour ?? '']);
    parts.push(`Sockets: ${[...g.values()].map((c) => c.join('-')).join(' ')}`);
  }
  if (item.ilvl) parts.push(`Item Level: ${item.ilvl}`);
  if (item.stackSize) parts.push(`Stack Size: ${item.stackSize}/${item.maxStackSize ?? ''}`);
  parts.push(`Rarity: ${item.rarity ?? ''}`);
  return [...new Set(lines(parts))];
}

// distinct substrings of 2..MAXL characters of the given lines that pass `keep`. With `grow`, stop
// extending a substring once it fails `grow` (for a prefix-closed set: no longer one can pass either).
function substrings(ls: string[], keep: (f: string) => boolean, grow?: (f: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const l of ls) {
    for (let i = 0; i < l.length; i++) {
      for (let L = 2; L <= MAXL && i + L <= l.length; L++) {
        const f = l.slice(i, i + L);
        if (grow && !grow(f)) break;
        if (keep(f)) out.add(f);
      }
    }
  }
  return out;
}

const nameOf = (it: any) => strip(it.name || it.typeLine || it.baseType || '?').trim();

export type RegexResult = { strings: string[]; count: number; missing: string[] };

// `all`: every item in the stash. `groups`: ids of the items each set of strings must light up.
// Each group's strings light up only that group's items (other groups count as "else").
export function buildRegexes(all: any[], groups: string[][], limit = LIMIT): RegexResult[] {
  const byId = new Map(all.map((it) => [it.id, it]));
  const trusted = new Map<string, string[]>();
  for (const id of new Set(groups.flat())) if (byId.has(id)) trusted.set(id, trustedLines(byId.get(id)));

  // candidate fragments: pieces of the targets' trusted lines. For each, how many items hold it.
  // `pieces` (every allowed piece, fine or not) is prefix-closed, which lets the tally stop early.
  const pieces = new Set<string>();
  for (const ls of trusted.values()) for (const f of substrings(ls, (f) => ALLOWED.test(f), (f) => ALLOWED.test(f))) pieces.add(f);
  const cand = new Set([...pieces].filter(fine));
  const hay = new Map<string, string[]>();
  const count = new Map<string, number>();
  const tally = (ls: string[], into: Map<string, number>) => {
    for (const f of substrings(ls, (f) => cand.has(f), (f) => pieces.has(f))) into.set(f, (into.get(f) ?? 0) + 1);
  };
  tally(BOILERPLATE, count);
  for (const it of all) {
    const h = hayLines(it);
    // the trusted lines must be part of what is checked against, whatever the walk found
    const t = trusted.get(it.id);
    hay.set(it.id, t ? [...new Set([...h, ...t])] : h);
    tally(hay.get(it.id)!, count);
  }

  return groups.map((ids) => solve([...new Set(ids)].filter((id) => trusted.has(id))));

  function solve(members: string[]): RegexResult {
    const inGroup = new Set(members);
    const own = new Map<string, number>();
    for (const id of members) tally(hay.get(id)!, own);
    // every item holding f is in the group
    const valid = (f: string) => count.get(f) === own.get(f);
    const text = members.map((id) => trusted.get(id)!.join('\n'));

    // shortest valid fragment from each position of each member's trusted lines
    const options = new Set<string>();
    for (const id of members) {
      for (const l of trusted.get(id)!) {
        for (let i = 0; i < l.length; i++) {
          for (let L = 2; L <= MAXL && i + L <= l.length; L++) {
            const f = l.slice(i, i + L);
            if (!ALLOWED.test(f)) break;
            if (fine(f) && valid(f)) {
              options.add(f);
              break;
            }
          }
        }
      }
    }
    const hits = (f: string) => new Set(text.flatMap((t, k) => (t.includes(f) ? [k] : [])));
    const opts = [...options].map((f) => ({ f, hits: hits(f) }));

    // members nothing short isolates: try longer fragments, checked by scanning everything else
    const reached = new Set(opts.flatMap((o) => [...o.hits]));
    const lonely = members.map((_, k) => k).filter((k) => !reached.has(k));
    if (lonely.length) {
      const outside = [...BOILERPLATE, ...all.filter((it) => !inGroup.has(it.id)).flatMap((it) => hay.get(it.id)!)].join('\n');
      for (const k of lonely) {
        for (const l of trusted.get(members[k])!) {
          for (let i = 0; i < l.length; i++) {
            if (i && l[i - 1] !== ' ') continue; // word starts are enough here
            for (let L = MAXL + 1; L <= limit - 2 && i + L <= l.length; L++) {
              const f = l.slice(i, i + L);
              if (!ALLOWED.test(f)) break;
              if (fine(f) && !outside.includes(f)) {
                opts.push({ f, hits: hits(f) });
                break;
              }
            }
          }
        }
      }
    }

    // greedy set cover: most newly lit members per character (plus the "|" it costs)
    const left = new Set(members.map((_, k) => k));
    const picked: typeof opts = [];
    while (left.size) {
      let best: (typeof opts)[number] | null = null;
      let bestScore = 0;
      for (const o of opts) {
        if (o.f.length > limit - 2) continue;
        let n = 0;
        for (const k of o.hits) if (left.has(k)) n++;
        const score = n / (o.f.length + 1);
        if (score > bestScore || (score === bestScore && best && o.f.length < best.f.length)) (best = o), (bestScore = score);
      }
      if (!best || !bestScore) break;
      picked.push(best);
      for (const k of best.hits) left.delete(k);
    }
    // drop picks made redundant by later ones, longest first
    for (const o of picked.toSorted((a, b) => b.f.length - a.f.length)) {
      const rest = picked.filter((p) => p !== o);
      if ([...o.hits].every((k) => rest.some((p) => p.hits.has(k)))) picked.splice(picked.indexOf(o), 1);
    }

    // pack into strings: first fit, longest first
    const bins: string[][] = [];
    const size = (b: string[]) => b.reduce((a, f) => a + f.length, 0) + Math.max(0, b.length - 1);
    for (const { f } of picked.toSorted((a, b) => b.f.length - a.f.length)) {
      const bin = bins.find((b) => size(b) + 1 + f.length <= limit - 2);
      if (bin) bin.push(f);
      else bins.push([f]);
    }
    return {
      strings: bins.map((b) => `"${b.toSorted((x, y) => x.length - y.length).join('|')}"`),
      count: members.length - left.size,
      missing: [...left].map((k) => nameOf(byId.get(members[k]))),
    };
  }
}

// One group within a single tab: strings that light up `targetIds` and nothing else in `items`.
export function stashRegex(items: any[], targetIds: string[]): RegexResult {
  return buildRegexes(items, [targetIds])[0];
}
