// trade site links open on our search page (same query, through the rate limiter)
const searchHref = (link) => `search.html#${link.slice(link.lastIndexOf('/') + 1)}`;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
};
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const ago = (t) => {
  if (!t) return '–';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const fmt = (c) => (c == null ? '–' : c >= 1000 ? `${Math.round(c / 100) / 10}k` : `${c}`);
const kpi = (label, value, hint) => el('div', { className: 'kpi', title: hint ?? '' }, el('b', { textContent: value }), el('span', { className: 'muted', textContent: label }));
const card = (title, ...kids) => el('section', { className: 'card' }, el('h2', { textContent: title }), ...kids);
const table = (head, rows) =>
  el('table', {}, el('tr', {}, ...head.map((h, i) => el('th', { textContent: h, className: i ? 'num' : '' }))), ...rows.map((r) => el('tr', {}, ...r.map((c, i) => (c instanceof Node ? c : el('td', { textContent: c, className: i ? 'num' : '' }))))));

let data;
let explore = null;
let slot = 'all';

function affixTable(list, up) {
  if (!list.length) return el('p', { className: 'muted', textContent: up ? 'nothing clearly valuable yet' : 'nothing clearly cheap yet' });
  return table(['affix', 'n', 'price ×'], list.map((a) => [a.label, a.n, el('td', { className: `num ${up ? 'up' : 'down'}`, textContent: `×${a.factor.toFixed(2)}` })]));
}

function render() {
  const { data: d, model: m, thresholds: t, affixes, stash } = data;
  const root = $('ov');
  root.replaceChildren();

  // data stored
  const maxBucket = Math.max(1, ...Object.values(d.buckets));
  root.append(
    card('Stored data', el('div', { className: 'kpis' },
      kpi('listings', d.listings), kpi('searches', d.queries), kpi('on disk', `${d.fileMB} MB`),
      kpi('oldest', ago(d.oldest)), kpi('newest', ago(d.newest))),
      el('p', { className: 'muted', textContent: Object.entries(d.rarity).map(([k, v]) => `${v} ${k}`).join(' · ') }),
      table(['price', 'listings', ''], Object.entries(d.buckets).map(([k, v]) => [k, v, el('td', {}, el('span', { className: 'bar', style: `width:${Math.round((v / maxBucket) * 120)}px` }))]))),
  );

  // model health
  root.append(card('Model',
    m
      ? el('div', {},
          el('div', { className: 'kpis' },
            m.vsTrade ? kpi('vs trade price', `×${m.vsTrade.error}`, `model guess for ${m.vsTrade.n} of our own items it never saw, against the trade price our pricer found; ${m.vsTrade.within2}% within ×2; on average ×${m.vsTrade.bias} ${m.vsTrade.bias >= 1 ? 'high' : 'low'}`) : null,
            kpi('vs any listing', `×${m.error}`, 'held-out listings, asks included: how far off in price factor'), kpi('guessing mean', `×${m.baseline}`), kpi('trained on', m.trainedOn), kpi('features', m.features), kpi('trees', m.trees)),
          el('p', { className: 'muted', textContent: `trained ${ago(m.at)} · ${m.pendingListings} new listings since (retrains at ${t.retrainEvery})` }))
      : el('p', { className: 'muted', textContent: `not trained yet: needs ${t.minTrain} rare listings (have ${d.listings}). Every price check adds ~10.` })));

  // stash
  root.append(card('Priced stash',
    el('div', { className: 'kpis' }, kpi('items', stash.items), kpi('by trade', stash.byTrade), kpi('by model', stash.byModel), kpi('no comps', stash.noComparables), kpi('total', `${fmt(stash.totalChaos)}c`)),
    stash.top.length ? table(['most valuable', 'chaos'], stash.top.map((p) => [el('td', {}, (p.link ? el('a', { href: searchHref(p.link), target: 'poe-search', textContent: p.name || '?' }) : el('span', { textContent: p.name || '?' })), el('span', { className: 'muted', textContent: ` tab ${p.tab}${p.source === 'model' ? ' · model' : ''}` })), fmt(p.chaos)])) : ''));

  // per-slot coverage
  const slots = Object.entries(d.slots).sort((a, b) => b[1].n - a[1].n);
  root.append(card('Coverage by slot',
    table(['slot', 'listings', 'median', 'p90', 'error', 'ready'], slots.map(([s, v]) => [
      el('td', {}, el('a', { href: '#', textContent: s, onclick: (e) => (e.preventDefault(), ($('slot').value = s), (slot = s), render()) })),
      v.n, fmt(v.median), fmt(v.p90), v.error ? `×${v.error}` : '–',
      el('td', { className: `num ${v.ready ? 'ok' : 'warn'}`, textContent: v.ready ? 'skips trash' : `${t.minSupport - v.n} more` }),
    ])),
    el('p', { className: 'muted', textContent: 'ready = enough listings for the model to skip trade searches in that slot. Click a slot to filter affixes.' })));

  // affix values
  const a = affixes?.[slot] ?? affixes?.all;
  const wide = el('section', { className: 'card wide' }, el('h2', { textContent: `Affix values · ${slot}` }));
  if (!a) wide.append(el('p', { className: 'muted', textContent: 'train the model first' }));
  else {
    wide.append(
      el('p', { className: 'muted', textContent: `${a.count} affixes seen ≥3 times · ${a.neutral} roughly neutral. × is the average price effect the model learned for the affix, from listings alone.` }),
      el('div', { className: 'two' }, el('div', {}, el('h3', { textContent: 'valued highly' }), affixTable(a.high, true)), el('div', {}, el('h3', { textContent: 'valued low' }), affixTable(a.low, false))));
  }
  root.append(wide);
  if (explore) root.append(probeCard());
}

// What one good roll of an affix is worth on its own: the cheapest instant buyouts of any rare of the
// slot with it. Most read ~0 (plenty listed, floor at trash); the ones with a real floor are the
// valuable affixes. Gathered by the idle explorer, one search at a time.
function probeCard() {
  const e = explore;
  const box = el('section', { className: 'card wide' }, el('h2', { textContent: `Affix floors · ${slot}` }));
  const toggle = el('button', { textContent: e.enabled ? 'Pause exploring' : 'Explore when idle', disabled: !e.configured });
  toggle.onclick = async () => {
    toggle.disabled = true;
    explore = await api('/api/explore', { on: !e.enabled });
    render();
  };
  const status = !e.configured ? 'off (PROBE_SECONDS=0)'
    : !e.enabled ? 'paused by you'
    : e.current ? `probing ${e.current}`
    : e.paused ?? `next probe within ${e.everySeconds}s`;
  box.append(el('p', { className: 'muted' }, toggle, `  ${status} · ${e.probes.length} probed · ${e.due} of ${e.candidates} affixes due`,
    e.errors.length ? el('span', { className: 'warn', textContent: ` · last error: ${e.errors.at(-1)}` }) : ''));
  const list = e.probes.filter((p) => !p.error && (slot === 'all' || p.slot === slot));
  if (!list.length) return box.append(el('p', { className: 'muted', textContent: 'nothing probed in this slot yet' })), box;
  const tag = (a) => ({ prefix: 'P', suffix: 'S', total: 'Σ', implicit: 'impl', enchant: 'ench' })[a] ?? '';
  const part = (x) => [el('span', { className: 'muted', textContent: `${tag(x.affix)} ` }), `${x.text.replace('#', '…')} ≥ ${x.min}`];
  // weight changes the floors made, in this slot
  const text = new Map(e.probes.flatMap((p) => p.parts.map((x) => [x.statId, x.text])));
  const moved = Object.entries(e.learned ?? {}).map(([k, l]) => [k.split('|'), l]).filter(([[s]]) => slot === 'all' || s === slot);
  box.append(
    el('p', { className: 'muted', textContent: 'Any rare of the slot with the affix (or pair) rolled well (upper quarter of the rolls seen), cheapest instant buyouts. A high floor means it carries value; a pair far above its parts alone is a combination buyers pay for.' }),
    moved.length ? el('details', {}, el('summary', { textContent: `${moved.length} rule weight${moved.length === 1 ? '' : 's'} moved by these floors` }),
      table(['affix', 'weight', 'because'], moved.map(([[s, statId], l]) => [
        `${(text.get(statId) ?? statId).replace('#', '…')}${slot === 'all' ? ` · ${s}` : ''}`,
        el('td', { className: `num ${l.min ? 'up' : 'down'}`, textContent: l.min ? `≥ ${l.min}` : `≤ ${l.max}` }),
        el('td', { className: 'muted', textContent: l.why }),
      ]))) : null,
    table(['affix', 'listed', 'cheapest', 'median of 10', ''], list.slice(0, 80).map((p) => [
      el('td', {}, ...p.parts.flatMap((x, i) => [i ? ' + ' : '', ...part(x)]), slot === 'all' ? el('span', { className: 'muted', textContent: ` · ${p.slot}${p.type ? ` ${p.type}` : ''}` }) : ''),
      p.total >= 10000 ? '10k+' : p.total,
      el('td', { className: `num ${p.floor >= 5 ? 'up' : ''}`, textContent: p.floor == null ? '–' : `${fmt(p.floor)}c` }),
      p.median == null ? '–' : `${fmt(p.median)}c`,
      el('td', { className: 'num' }, p.link ? el('a', { href: searchHref(p.link), target: 'poe-search', textContent: ago(p.at) }) : ago(p.at)),
    ])));
  return box;
}

async function load() {
  $('status').textContent = 'loading…';
  [data, explore] = await Promise.all([api('/api/overview'), api('/api/explore').catch(() => null)]);
  const slots = ['all', ...Object.keys(data.data.slots).sort((x, y) => data.data.slots[y].n - data.data.slots[x].n)];
  $('slot').replaceChildren(...slots.map((s) => el('option', { value: s, textContent: s })));
  $('slot').value = slots.includes(slot) ? slot : 'all';
  $('status').textContent = '';
  render();
}

$('slot').onchange = () => ((slot = $('slot').value), render());
$('retrain').onclick = async () => {
  $('retrain').disabled = true;
  $('status').textContent = 'training…';
  try {
    await api('/api/model/train', {});
    await load();
  } catch (e) {
    $('status').textContent = e.message;
  } finally {
    $('retrain').disabled = false;
  }
};
load().catch((e) => ($('status').textContent = e.message));
