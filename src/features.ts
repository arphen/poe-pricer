// Item -> sparse numeric features for the price model. Built from the same analysis the UI uses,
// so everything the heuristics know (tiers, open affixes, pseudo totals, DPS) is available to learn
// from, and the model can tell us which of it actually moves prices.
import { normalizeMod, type Analysis } from './query.ts';

export type Features = { slot: string; f: Record<string, number>; labels: Record<string, string> };

const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const clean = (s: string) => s.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1');

export function featuresOf(item: any, a: Analysis): Features {
  const f: Record<string, number> = {};
  const labels: Record<string, string> = {};
  const add = (k: string, v: number, label?: string) => {
    if (!Number.isFinite(v) || v === 0) return;
    f[k] = (f[k] ?? 0) + v;
    if (label) labels[k] = label;
  };

  add(`slot:${a.slot}`, 1, `slot ${a.slot}`);
  add('magic', item.frameType === 1 ? 1 : 0, 'magic rarity');
  add(`base:${a.baseType}`, 1, `base ${a.baseType}`);
  if (a.ilvl) add('ilvl', a.ilvl, 'item level');
  add('links', a.links, 'links');
  add('corrupted', a.corrupted ? 1 : 0, 'corrupted');
  add('influences', Object.keys(item.influences ?? {}).length, 'influences');
  add('synthesised', item.synthesised ? 1 : 0, 'synthesised');

  let t1 = 0, t2 = 0;
  for (const m of a.mods) {
    if (m.negate) continue; // search ceilings, not properties of the item
    // fractured lines are the same stat as explicit ones; the "fractured" count carries the rest
    const id = m.statId?.replace(/^fractured\./, 'explicit.') ?? `text:${normalizeMod(m.text).norm}`;
    const label = m.type === 'pseudo' || m.type === 'prop' ? m.text.replace(/[\d.]+/g, '#') : clean(normalizeMod(m.text).norm).replace(/^# Added Passive Skill is /, 'Notable: ');
    add(id, m.values.length ? avg(m.values) : 1, (m.type === 'implicit' ? 'implicit: ' : m.type === 'crafted' ? 'crafted: ' : '') + label);
    if (m.type === 'fractured') add('fractured', 1, 'fractured mods');
    if (m.type === 'crafted') add('crafted', 1, 'has bench craft');
    if (m.tier && m.tiers && m.tiers > 1) {
      // tier quality 1 = top tier, 0 = bottom
      add(`tq:${id}`, 1 - (m.tier - 1) / (m.tiers - 1), `tier of ${label}`);
      if (m.tier === 1) t1++;
      if (m.tier <= 2) t2++;
    }
  }
  add('t1', t1, 'T1 mods');
  add('t2', t2, 'T1-2 mods');

  if (a.affixes) {
    add('openPrefix', a.affixes.openPrefix, 'open prefixes');
    add('openSuffix', a.affixes.openSuffix, 'open suffixes');
  }
  if (a.dps) {
    add('pdps', a.dps.pdps, 'physical DPS');
    add('edps', a.dps.edps, 'elemental DPS');
    add('dps', a.dps.total, 'total DPS');
  }
  // the hand-written heuristic as a feature: the model learns how much to trust it per slot
  add('score', a.score, 'heuristic score');
  add('craftedScore', a.craftedScore, 'heuristic score after craft');
  return { slot: a.slot, f, labels };
}
