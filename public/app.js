const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

// trade site links open on our search page (same query, through the rate limiter)
const searchHref = (link) => `search.html#${link.slice(link.lastIndexOf('/') + 1)}`;
const strip = (s) => (s ?? '').replace(/<<.*?>>/g, '');
const clean = (s) => strip(s).replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1');
const rarityClass = (it) => ['', 'magic', 'rare', 'unique'][it.frameType] ?? '';
const itemName = (it) => strip(it.name) || strip(it.typeLine);
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const cfg = { divine: null, trashChaos: 3 };
const fmtC = (c) => (c >= 1000 ? `${Math.round(c / 100) / 10}k` : c >= 10 ? `${Math.round(c)}` : `${Math.round(c * 10) / 10}`);
// chaos, with divines for anything worth at least one
function money(c) {
  if (cfg.divine && c >= cfg.divine) return { main: `${Math.round((c / cfg.divine) * 10) / 10} div`, sub: `${fmtC(c)}c` };
  return { main: `${fmtC(c)}c`, sub: '' };
}

let items = [];
let filter = 'all';
let selected = null;
let status = null; // last /api/scan/status
let queued = new Map(); // item id -> place in the scan's queue
const searching = (it) => status?.current?.id === it.id;

// --- where an item stands ------------------------------------------------------------------------

// todo: no trade search yet · model: priced as trash by the model alone · none: nothing comparable listed
// beaten: a stored listing at least as good on every line that matters asks under the trash line
// cheap: trade-confirmed cheap · priced: a real price from instant-buyout listings
function standing(it) {
  const p = it._p;
  if (!p) return 'todo';
  if (p.source === 'model') return 'model';
  if (p.source === 'beaten') return 'beaten';
  if (p.chaos == null) return 'none';
  return p.cheap ? 'cheap' : 'priced';
}
const dropped = (p) => p.dropped ?? (p.relaxed ? 1 : 0);
// trade prices from before the cheapest-ask rule (they carry no asks); the next scan re-prices them
const oldMethod = (p) => p?.source === 'trade' && !p.asks;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function badge(it) {
  const p = it._p;
  if (searching(it)) return el('span', { className: 'badge now', textContent: 'searching' });
  switch (standing(it)) {
    case 'todo': {
      const star = it._v?.verdict === 'check' ? '★ ' : '';
      return el('span', { className: `badge ${star ? 'check' : 'todo'}`, textContent: `${star}${queued.has(it.id) ? 'queued' : 'not searched yet'}` });
    }
    case 'model':
      return el('span', { className: 'badge model', textContent: 'model guess', title: `priced by the model alone: it is confident this sells under ${cfg.trashChaos}c` });
    case 'beaten':
      return el('span', { className: 'badge cheap', textContent: 'a better one is cheaper', title: `${p.beatenBy.name} is at least as good on every line that matters and asks ${fmtC(p.beatenBy.chaos)}c` });
    case 'none':
      return el('span', { className: 'badge none', textContent: 'nothing comparable listed' });
    case 'cheap':
      return el('span', { className: 'badge cheap', textContent: `confirmed cheap · ${p.total} listed` });
  }
  if (oldMethod(p)) return el('span', { className: 'badge todo', textContent: 'old estimate · re-price pending', title: 'priced with the earlier method (median of asks); the next scan prices it from the cheapest buyout listing' });
  const d = dropped(p);
  const few = p.total < 10;
  const text = `${d ? `${plural(d, 'line')} dropped` : 'whole item'} · ${few ? 'only ' : ''}${p.total} listed`;
  return el('span', { className: `badge ${few ? 'few' : p.lost >= 2 ? 'lost' : d ? 'dropped' : 'whole'}`, textContent: text, title: few ? 'few listings: rare combos attract hopeful asks that may never sell' : p.lost >= 2 ? 'a good line was dropped: comparables may lack it, so yours may be worth more' : '' });
}

// list order: real prices high to low, then the unsearched (rules' favourites first), then the rest
const GROUP = { priced: 0, todo: 1, model: 2, none: 3, cheap: 4, beaten: 4 };
const VERDICT = { check: 0, maybe: 1, skip: 2 };
function order(a, b) {
  const ga = GROUP[standing(a)], gb = GROUP[standing(b)];
  if (ga !== gb) return ga - gb;
  if (ga === 1) return (VERDICT[a._v?.verdict] ?? 3) - (VERDICT[b._v?.verdict] ?? 3) || (b._v?.score ?? 0) - (a._v?.score ?? 0);
  return (b._p?.chaos ?? 0) - (a._p?.chaos ?? 0);
}

const minC = () => Number($('minC').value || 0);
const FILTERS = {
  all: { label: 'All', test: () => true },
  sell: { label: 'Worth selling', test: (it) => standing(it) === 'priced' && it._p.chaos >= minC() },
  todo: { label: 'Not searched', test: (it) => standing(it) === 'todo' || standing(it) === 'model' },
  cheap: { label: 'Cheap', test: (it) => ['cheap', 'none', 'beaten'].includes(standing(it)) },
};

// --- list ----------------------------------------------------------------------------------------

async function loadTab(index) {
  $('summary').textContent = 'loading tab…';
  try {
    items = await api(`/api/stash/tab/${index}`);
  } catch (e) {
    $('summary').replaceChildren(el('span', { className: 'err', textContent: e.message }));
    items = [];
  }
  render();
}

function render() {
  const priced = items.filter((it) => it._v?.priced);
  const others = items.length - priced.length;
  const sell = priced.filter(FILTERS.sell.test);
  const sum = sell.reduce((a, it) => a + it._p.chaos, 0);
  const todo = priced.filter(FILTERS.todo.test).length;
  $('summary').replaceChildren(
    el('b', { textContent: `${priced.length}` }), ' rares and magic items · ',
    el('b', { textContent: `${sell.length}` }), ` worth ${minC()}c or more`, sell.length ? ` (≈ ${money(sum).main} together)` : '', ' · ',
    el('b', { textContent: `${todo}` }), ' not searched yet',
  );
  $('others').textContent = others ? `${plural(others, 'other item')} here (currency, uniques, gems, …) are not priced by this tool.` : '';

  $('filters').replaceChildren(...Object.entries(FILTERS).map(([key, f]) => {
    const b = el('button', { className: filter === key ? 'on' : '', textContent: `${f.label} ${priced.filter(f.test).length}` });
    b.onclick = () => ((filter = key), render());
    return b;
  }));

  const rows = priced.filter(FILTERS[filter].test).toSorted(order).map((it) => {
    const p = it._p;
    const s = standing(it);
    let price = el('td', { className: 'num' }, el('span', { className: 'muted', textContent: '—' }));
    if (p?.chaos != null) {
      const m = money(p.chaos);
      price = el('td', { className: 'num' }, el('div', { className: `price ${s === 'model' ? 'guess' : ''}` }, (s === 'model' ? '~' : '') + m.main, m.sub ? el('small', { textContent: m.sub }) : null));
    }
    const link = p?.link ? el('a', { href: searchHref(p.link), target: 'poe-search', textContent: 'search ↗', title: 'open this search on the search page', onclick: (e) => e.stopPropagation() }) : '';
    const tr = el('tr', { className: `${s === 'cheap' ? 'cheap' : ''} ${selected === it.id ? 'sel' : ''} ${searching(it) ? 'now' : ''}` },
      el('td', {}, el('img', { className: 'icon', src: it.icon, loading: 'lazy', alt: '' })),
      el('td', {},
        el('div', { className: `name ${rarityClass(it)}`, textContent: itemName(it) }),
        el('div', { className: 'base' }, [strip(it.baseType) !== itemName(it) ? strip(it.baseType) : '', it.ilvl ? `ilvl ${it.ilvl}` : ''].filter(Boolean).join(' · '), it.corrupted ? el('span', { className: 'corrupt', textContent: ' · corrupted' }) : null),
        it._v?.lines?.length ? el('div', { className: 'keys' }, ...it._v.lines.map((l) => el('span', { textContent: l }))) : null,
      ),
      price,
      el('td', {}, badge(it)),
      el('td', {}, link),
    );
    tr.onclick = () => {
      selected = it.id;
      for (const r of $('items').tBodies[0].rows) r.classList.remove('sel');
      tr.classList.add('sel');
      openItem(it);
    };
    return tr;
  });
  $('items').tBodies[0].replaceChildren(...rows);
  if (!rows.length) $('items').tBodies[0].append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: priced.length ? 'nothing in this view' : 'no rares or magic items in this tab' })));
}

// --- detail panel --------------------------------------------------------------------------------

// One plain sentence on where the price came from.
function explain(it, lineText) {
  const p = it._p;
  if (searching(it)) return 'Searching trade now.';
  switch (standing(it)) {
    case 'todo': {
      const ahead = queued.get(it.id);
      if (ahead != null) return ahead ? `Queued for a trade search, ${plural(ahead, 'item')} ahead.` : 'Queued for a trade search, next up.';
      return 'Not searched yet. "Price this tab" searches every rare and magic item, best candidates first.';
    }
    case 'model':
      return `The model guesses ~${p.chaos}c, under the ${cfg.trashChaos}c line, so no trade search was spent on it.`;
    case 'none':
      return 'No instant-buyout listing matches, even with only one line left to search.';
    case 'beaten':
      return `${p.beatenBy.name} is at least as good on every line that matters (${plural(p.beatenBy.count, 'such listing')} stored) and asks ${fmtC(p.beatenBy.chaos)}c, so this is worth that at most. No search spent.`;
  }
  if (oldMethod(p)) return `Priced with the earlier method (median of ${p.n} asks, ${p.total} listed), which overstates thin markets. The next scan re-prices it from the cheapest buyout listing.`;
  const d = dropped(p);
  const which = p.droppedKeys?.length ? p.droppedKeys.map(lineText).join(', ') : plural(d, 'line');
  let s = `Cheapest of ${p.total} instant-buyout listings matching ${d ? `every line except ${which}` : 'the whole item'}.`;
  if (p.beatenBy) s += ` Capped at ${fmtC(p.beatenBy.chaos)}c: ${p.beatenBy.name}, at least as good on every line that matters, asks that.`;
  if (p.searched?.some((k) => k.startsWith('cap:'))) s += ' Versions with better rolls on its weak lines (or with real life) were kept out: they are another market.';
  if (p.total < 10) s += ' Few listed, so the asks may be hopeful.';
  if (p.lost >= 2) s += ' A good line had to be dropped, so yours may be worth more.';
  if (p.cheap) s += ' Confirmed cheap.';
  return s;
}

function priceBox(it, lineText) {
  const p = it._p;
  const box = el('div', { className: 'pricebox' });
  if (p?.chaos != null) {
    const m = money(p.chaos);
    box.append(el('div', {}, el('span', { className: 'big', textContent: (standing(it) === 'model' ? '~' : '') + m.main }), m.sub ? el('span', { className: 'muted', textContent: `${m.sub}  ` }) : null, badge(it)));
  }
  box.append(el('p', { textContent: explain(it, lineText) }));
  if (p?.asks?.length) box.append(el('div', { className: 'asks' }, 'asks: ', ...p.asks.flatMap((c, i) => [i ? ' · ' : '', i === 0 ? el('b', { textContent: fmtC(c) }) : fmtC(c)]), 'c'));
  if (p?.link || p?.at) box.append(el('div', { className: 'asks' }, p.link ? el('a', { href: searchHref(p.link), target: 'poe-search', textContent: 'open the search ↗' }) : '', p.at ? `  · priced ${ago(p.at)}` : ''));
  return box;
}

async function openItem(item) {
  const panel = $('panel');
  panel.replaceChildren(el('p', { className: 'muted', textContent: 'analysing…' }));
  let a;
  try {
    a = await api('/api/analyze', { item });
  } catch (e) {
    return panel.replaceChildren(el('p', { className: 'err', textContent: e.message }));
  }
  const p = item._p;
  const byKey = new Map(a.mods.map((m) => [m.key, m]));
  const lineText = (k) => clean(byKey.get(k)?.text ?? k);
  const searched = new Set(p?.searched ?? []);
  const droppedSet = new Set(p?.droppedKeys ?? []);

  const af = a.affixes;
  const sub = [
    a.name ? a.baseType : '',
    a.ilvl ? `ilvl ${a.ilvl}` : '',
    a.corrupted ? 'corrupted' : 'not corrupted',
    af ? `${af.prefixes} prefixes, ${af.suffixes} suffixes${af.openPrefix || af.openSuffix ? ` (open: ${[af.openPrefix ? `${af.openPrefix} prefix` : '', af.openSuffix ? `${af.openSuffix} suffix` : ''].filter(Boolean).join(', ')})` : ''}` : '',
    a.dps ? `${a.dps.total} DPS (${a.dps.pdps} phys, ${a.dps.edps} ele)` : '',
  ].filter(Boolean).join(' · ');

  // the item's lines, marked with what the background search did with each
  const lines = a.mods
    .filter((m) => m.key !== 'pseudo:openp' && m.key !== 'pseudo:opens')
    .map((m) => {
      const tag = [m.affix ? m.affix[0].toUpperCase() : '', m.tier && m.tiers > 1 ? `T${m.tier}` : '', m.type === 'implicit' ? 'impl' : m.type === 'crafted' ? 'craft' : ''].filter(Boolean).join(' ');
      const state = searched.has(m.key) ? el('span', { className: 'state on', textContent: '✓ searched' })
        : droppedSet.has(m.key) ? el('span', { className: 'state off', textContent: 'dropped' })
        : m.covered ? el('span', { className: 'state', textContent: 'in total' })
        : el('span', { className: 'state' });
      return el('div', { className: `line ${m.type} w${m.weight} ${m.covered ? 'covered' : ''} ${m.type === 'pseudo' || m.type === 'prop' ? 'total' : ''}`, title: `${m.statId ?? 'no trade stat'} · weight ${m.weight}${m.tiers ? ` · tier ${m.tier} of ${m.tiers}` : ''}${m.learned ? ` · market: ${m.learned}` : ''}` },
        el('span', { className: `tag t${m.tier ?? ''}`, textContent: tag }), el('span', { className: 'text', textContent: clean(m.text) }), state);
    });

  const craft = a.craft ? el('div', { className: 'craft' }, 'Bench craft worth doing: ', el('b', { textContent: a.craft.text }), el('div', { className: 'muted', textContent: `${a.craft.affix} · ${a.craft.cost} · ${a.craft.gain}${a.craft.replacesCrafted ? ' · replaces the current bench mod' : ''}` })) : null;

  panel.replaceChildren(...[
    el('h2', { className: rarityClass(item), textContent: a.name || a.baseType }),
    el('div', { className: 'sub', textContent: sub }),
    priceBox(item, lineText),
    el('h3', { textContent: 'Lines' }),
    ...lines,
    craft,
    a.model ? modelBox(a.model, a.slot) : null,
    manualSearch(item, a),
    el('div', { className: 'sub', textContent: a.verdict !== 'n/a' ? `rules rate it ${a.useCraft ? a.craftedVerdict : a.verdict} (${a.useCraft ? a.craftedScore : a.score}); that only decides search order` : '' }),
  ].filter((k) => k != null));
}

function modelBox(m, slot) {
  const fmt = (d) => `${d > 0 ? '+' : ''}${Math.round((Math.exp(d) - 1) * 100)}%`;
  return el('details', { className: 'model' },
    el('summary', {}, el('b', { textContent: `Model guess ~${m.chaos}c` }), el('span', { className: 'muted', textContent: ` (${m.lo}–${m.hi}c, from ${m.support} ${slot} listings)` })),
    el('div', { className: 'muted', textContent: 'what moves the guess:' }),
    ...m.drivers.map((d) => el('div', { className: `driver ${d.delta > 0 ? 'up' : 'down'}` }, el('span', { textContent: fmt(d.delta) }), ` ${d.label}`)),
  );
}

// The full search form, folded away: starts from the lines the background search ended up using.
function manualSearch(item, a) {
  const p = item._p;
  const used = p?.searched ? new Set(p.searched) : null;
  const rows = a.mods.map((m) => {
    const cb = el('input', { type: 'checkbox', checked: used ? used.has(m.key) : m.enabled, disabled: !m.statId });
    const min = el('input', { type: 'number', step: 'any', value: m.min ?? '', placeholder: 'min', disabled: !m.statId });
    const max = el('input', { type: 'number', step: 'any', value: m.max ?? '', placeholder: 'max', disabled: !m.statId });
    const row = el('label', { className: `mod ${m.statId ? '' : 'nostat'}` }, cb, el('span', { textContent: clean(m.text) }), min, max);
    row.read = () => ({ key: m.key, enabled: cb.checked, min: min.value === '' ? null : Number(min.value), max: max.value === '' ? null : Number(max.value) });
    row.applyCraft = (on) => {
      if (m.minCrafted != null && m.minCrafted !== m.min) min.value = on ? m.minCrafted : m.min ?? '';
    };
    return row;
  });
  let craftToggle = null;
  if (a.craft) {
    const cb = el('input', { type: 'checkbox', checked: false });
    cb.onchange = () => rows.forEach((r) => r.applyCraft(cb.checked));
    craftToggle = el('label', {}, cb, ' price as if the bench craft were done');
  }
  let searchBy = null;
  if (a.category) {
    searchBy = el('select', {}, el('option', { value: 'category', textContent: 'any base' }), el('option', { value: 'type', textContent: a.baseType }));
    searchBy.value = a.searchBy;
  }
  const num = (v) => (v === '' ? null : Number(v));
  const ilvl = el('input', { type: 'number', value: a.filters.ilvlMin ?? '', placeholder: a.ilvl ?? '' });
  const links = el('input', { type: 'number', value: a.filters.linksMin ?? '', placeholder: a.links || '' });
  const atLeast = el('input', { type: 'number', min: 1, value: '', placeholder: 'all' });
  const corrupted = el('select', {}, ...[['any', 'any'], ['true', 'corrupted only'], ['false', 'not corrupted']].map(([v, t]) => el('option', { value: v, textContent: t })));
  corrupted.value = a.filters.corrupted;
  const results = el('div');
  const go = el('button', { className: 'primary', textContent: 'Search trade' });
  go.onclick = async () => {
    go.disabled = true;
    results.replaceChildren(el('p', { className: 'muted', textContent: 'searching (rate limited, can take a few seconds)…' }));
    try {
      const selection = { mods: rows.map((r) => r.read()), ilvlMin: num(ilvl.value), linksMin: num(links.value), corrupted: corrupted.value, matchAtLeast: num(atLeast.value), searchBy: searchBy?.value };
      results.replaceChildren(renderResults(await api('/api/price', { item, selection })));
    } catch (e) {
      results.replaceChildren(el('p', { className: 'err', textContent: e.message }));
    } finally {
      go.disabled = false;
    }
  };
  const labeled = (text, input) => el('label', {}, `${text} `, input);
  return el('details', { className: 'manual' },
    el('summary', { textContent: 'Search manually' }),
    el('div', { className: 'row' }, labeled('ilvl ≥', ilvl), labeled('links ≥', links), corrupted, searchBy),
    ...rows,
    craftToggle,
    el('div', { className: 'row' }, labeled('match at least', atLeast), el('span', { className: 'muted', textContent: 'of the ticked lines' })),
    go,
    results,
  );
}

function renderResults(r) {
  const box = el('div');
  box.append(el('p', {}, `${r.total} listed. `, el('a', { href: searchHref(r.link), target: 'poe-search', textContent: 'open the search ↗' })));
  const t = el('table');
  for (const l of r.listings) {
    const age = Math.round((Date.now() - new Date(l.indexed)) / 3600000);
    t.append(el('tr', {}, el('td', { textContent: `${l.amount} ${l.currency}` }), el('td', { textContent: l.seller }), el('td', { className: 'muted', textContent: age < 48 ? `${age}h` : `${Math.round(age / 24)}d` })));
  }
  box.append(t);
  return box;
}

// What the model has learned: holdout error and, per slot, which attributes move prices most.
async function showModel() {
  const panel = $('panel');
  const { data, model, calls } = await api('/api/model');
  const head = el('div', {}, el('h2', { textContent: 'Price model' }), el('p', { className: 'muted', textContent: `${data.listings} listings from ${data.queries} searches stored` }));
  if (!model) return panel.replaceChildren(head, el('p', { className: 'muted', textContent: 'not trained yet: needs ~150 rare listings. Every price check adds ~10.' }));
  const train = el('button', { textContent: 'Retrain now' });
  train.onclick = async () => ((train.disabled = true), await api('/api/model/train', {}), showModel());
  const m = model.metrics;
  head.append(el('p', { className: 'muted', textContent: `trained on ${model.trainedOn} · ${model.features} features · typical error ×${Math.exp(m.rmse ?? 0).toFixed(1)} (guessing the mean: ×${Math.exp(m.baseline ?? 0).toFixed(1)}) · ${ago(model.at)}` }), train, callHistory(calls));
  const slots = Object.entries(model.importance).sort((x, y) => m.slots[y[0]].n - m.slots[x[0]].n);
  panel.replaceChildren(head, ...slots.map(([slot, list]) => {
    const sm = m.slots[slot];
    return el('details', {},
      el('summary', { textContent: `${slot} · ${sm.n} listings (${sm.informative ?? 0} beyond the market floor)${sm.rmse != null ? ` · error ×${Math.exp(sm.rmse).toFixed(1)}` : ''}` }),
      el('table', {}, ...list.map((f) => el('tr', {}, el('td', { textContent: f.label }), el('td', { className: 'muted', textContent: f.impact.toFixed(2) })))),
    );
  }));
}

// Each bar is ten searched items in the order they were priced; its height is how many of the ten
// the model had guessed within ×2 of the trade price. Rising bars: the model is learning.
function callHistory(calls) {
  const box = el('div', { className: 'history' }, el('h3', { textContent: 'Model guess vs trade price' }));
  if (calls.length < 10) return box.append(el('p', { className: 'muted', textContent: `${calls.length} of the first 10 searched items so far` })), box;
  const bars = el('div', { className: 'bars' });
  for (let i = 0; i + 10 <= calls.length; i += 10) {
    const batch = calls.slice(i, i + 10);
    const hit = batch.filter((c) => miss(c) === 1).length;
    const day = new Date(batch[9].at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    bars.append(el('span', { className: 'bar', style: `height:${Math.max(4, hit * 10)}%`, title: `items ${i + 1}–${i + 10}, up to ${day}: ${hit} of 10 within ×2` }));
  }
  const recent = calls.slice(-8).reverse();
  box.append(
    el('div', { className: 'chart' }, el('span', { className: 'axis muted' }, el('span', { textContent: '10' }), el('span', { textContent: '0' })), bars),
    el('p', { className: 'muted', textContent: 'within ×2, per 10 searched items, oldest left' }),
    el('table', { className: 'calls' }, el('tr', {}, el('th', { textContent: 'latest' }), el('th', { className: 'num', textContent: 'model' }), el('th', { className: 'num', textContent: 'trade' })),
      ...recent.map((c) => el('tr', {}, el('td', {}, el('i', { className: `dot m${miss(c)}` }), ` ${c.name}`), el('td', { className: 'num', textContent: `${fmtC(c.guess)}c` }), el('td', { className: 'num', textContent: `${fmtC(c.trade)}c` })))),
  );
  return box;
}

// --- background pricing --------------------------------------------------------------------------

async function scan(tabs) {
  try {
    await api('/api/scan', { tabs });
  } catch (e) {
    return showErrors([e.message]);
  }
  pollScan();
}

function showErrors(errors) {
  $('errors').hidden = !errors.length;
  $('errors').textContent = errors.join('\n');
}

// mm:ss until an absolute time
const clock = (until) => {
  const sec = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
// how far the model's guess was from the trade price: 1 within ×2, 2 within ×4, 3 further
const miss = (c) => {
  const r = Math.max(c.guess / c.trade, c.trade / c.guess);
  return r <= 2 ? 1 : r <= 4 ? 2 : 3;
};

// One cell per item this scan touches, left to right in the order they are handled.
const CELL = { trade: 'searched', model: 'model guess, no search', beaten: 'a better one is listed cheaper, no search', error: 'failed', now: 'searching', queued: 'queued' };
function renderStrip(s) {
  const cells = [
    ...s.seen.map((x) => [x.how, x.name]),
    ...(s.current ? [[s.wait ? 'now wait' : 'now', s.current.name]] : []),
    ...s.queue.map((q) => ['queued', q.name]),
  ];
  const strip = $('strip');
  strip.hidden = !cells.length;
  const gap = cells.length > 60 ? 1 : 2;
  strip.style.setProperty('--w', `${Math.max(2, Math.min(12, Math.floor((200 - gap * (cells.length - 1)) / cells.length)))}px`);
  strip.style.setProperty('--gap', `${gap}px`);
  strip.replaceChildren(...cells.map(([how, name]) => el('i', { className: how, title: `${name} · ${CELL[how.split(' ')[0]]}` })));
  const count = (how) => s.seen.filter((x) => x.how === how).length;
  strip.title = [`${count('trade')} searched`, count('model') && `${count('model')} by the model`, s.queue.length && `${s.queue.length} queued`, s.running && s.etaS && `~${Math.ceil(s.etaS / 60)} min left`].filter(Boolean).join(' · ');
}

// Beside the strip: the item being searched, or when the next look at the stash happens.
// Countdowns tick locally between polls.
function renderNow() {
  const box = $('scanNow');
  const s = status;
  if (!s) return;
  const kids = [];
  if (s.current) {
    kids.push(el('span', { className: 'cur', textContent: s.current.name }));
    if (s.wait && s.wait.until - Date.now() > 1500) kids.push(el('span', { className: 'wait', textContent: clock(s.wait.until), title: `trade site rate limit (${s.wait.bucket}): the next request may go out in ${clock(s.wait.until)}` }));
  } else if (!s.running && s.nextScanAt) {
    kids.push(el('span', { className: 'muted', textContent: `next look ${clock(s.nextScanAt)}`, title: 'the dump tabs are re-read every few minutes and new items priced' }));
  }
  if (s.errors.length) {
    const b = el('button', { className: 'link err', textContent: plural(s.errors.length, 'error') });
    b.onclick = () => showErrors($('errors').hidden ? s.errors : []);
    kids.push(b);
  }
  box.replaceChildren(...kids);
}
setInterval(renderNow, 1000);

function renderCalls(calls) {
  $('calls').replaceChildren(...calls.map((c) => el('i', { className: `m${miss(c)}`, title: `${c.name} · model ${fmtC(c.guess)}c · trade ${fmtC(c.trade)}c` })));
}

let lastDone = -1;
let lastSig = '';
let pollTimer = null;
async function pollScan() {
  clearTimeout(pollTimer);
  let s;
  try {
    s = await api('/api/scan/status');
  } catch {
    return;
  }
  status = s;
  queued = new Map(s.queue.map((q, i) => [q.id, i]));
  renderStrip(s);
  renderNow();
  renderCalls(s.calls);
  $('scanStop').hidden = !s.running;
  const sig = `${s.current?.id}|${s.queue.length}`;
  if (s.done !== lastDone && $('tabs').value !== '') {
    lastDone = s.done;
    items = await api(`/api/stash/tab/${$('tabs').value}`).catch(() => items);
    render();
  } else if (sig !== lastSig) render();
  lastSig = sig;
  pollTimer = setTimeout(pollScan, s.running ? 2000 : 15000);
}

// Stash-search strings that highlight the items worth selling (copy, paste into the stash search box).
async function showRegex() {
  const targets = items.filter(FILTERS.sell.test).map((it) => it.id);
  const box = $('regexOut');
  if (!targets.length) return box.replaceChildren(el('span', { className: 'muted', textContent: `nothing in this tab is priced at ${minC()}c or more` }));
  try {
    const r = await api('/api/regex', { items, targets });
    box.replaceChildren(
      el('span', { className: 'muted', textContent: `${r.count} items, click to copy: ` }),
      ...r.strings.map((s) => {
        const b = el('button', { className: 'rx', textContent: s });
        b.onclick = async () => {
          await navigator.clipboard.writeText(s);
          b.classList.add('copied');
        };
        return b;
      }),
      r.missing.length ? el('span', { className: 'muted', textContent: ` (no unique name: ${r.missing.join(', ')})` }) : '',
    );
  } catch (e) {
    box.replaceChildren(el('span', { className: 'err', textContent: e.message }));
  }
}

async function init() {
  Object.assign(cfg, await api('/api/config'));
  $('who').textContent = `${cfg.account || '(set ACCOUNT_NAME)'} · ${cfg.league}`;
  $('minC').oninput = () => ($('regexOut').replaceChildren(), render());
  $('regexBtn').onclick = showRegex;
  $('modelBtn').onclick = () => showModel().catch((e) => showErrors([e.message]));
  $('scanTab').onclick = () => scan([Number($('tabs').value)]);
  $('scanAll').onclick = () => scan(undefined);
  $('scanStop').onclick = () => api('/api/scan/stop', {}).then(pollScan);
  try {
    const tabs = await api('/api/stash/tabs');
    $('tabs').replaceChildren(...tabs.map((t) => el('option', { value: t.i, textContent: `${t.i}: ${t.n}` })));
    $('tabs').onchange = () => loadTab(Number($('tabs').value));
    $('reload').onclick = async () => {
      await api(`/api/stash/tab/${$('tabs').value}?fresh=1`).catch(() => {});
      loadTab(Number($('tabs').value));
    };
    if (tabs.length) await loadTab(tabs[0].i);
  } catch (e) {
    showErrors([e.message]);
  }
  pollScan();
}
init();
