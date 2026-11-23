// Trade search page: the trade site's search form, but every request goes through the pricer's
// rate limiter (ahead of background scans), and searches are cached server-side for a few minutes.
// Trade site search ids are the query itself (gzip + base64url), so links open here with no request.
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

const strip = (s) => (s ?? '').replace(/<<.*?>>/g, '');
const clean = (s) => strip(s).replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1');
const FRAME = ['normal', 'magic', 'rare', 'unique', 'gem', 'currency', 'card'];
const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const fmtC = (c) => (c >= 1000 ? `${Math.round(c / 100) / 10}k` : c >= 10 ? `${Math.round(c)}` : `${Math.round(c * 10) / 10}`);
const opt = (v) => (v && typeof v === 'object' ? v.option : v) ?? '';
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

const cfg = { divine: null, league: '' };
let FILTERS = []; // trade site filter groups (drive the filter sections)
let STATS = []; // { id, text, lc, group, rank, option }
const STAT_BY_ID = new Map();
let ITEMS = []; // { label, lc, name, type, disc, unique, group }

// --- query state ---------------------------------------------------------------------------------

const defaultQuery = () => ({ status: { option: 'securable' }, stats: [{ type: 'and', filters: [] }], filters: {} });
let q = defaultQuery();
let current = null; // last search: { handle, id, total, count, link, at, cached, rows }
const openSections = new Set();

function normalize(query) {
  const n = structuredClone(query ?? {});
  n.status ??= { option: 'securable' };
  n.stats = n.stats?.length ? n.stats : [{ type: 'and', filters: [] }];
  for (const g of n.stats) {
    g.filters ??= [];
    for (const f of g.filters) f.value ??= {};
  }
  n.filters ??= {};
  return n;
}

const fget = (g, id) => q.filters?.[g]?.filters?.[id] ?? {};
function fset(g, id, key, value) {
  q.filters ??= {};
  const grp = (q.filters[g] ??= { filters: {} });
  grp.filters ??= {};
  const f = (grp.filters[id] ??= {});
  if (value === '' || value == null) delete f[key];
  else f[key] = value;
  if (!Object.keys(f).length) delete grp.filters[id];
}

// What gets sent: empty values, empty filters and empty groups dropped.
function cleanQuery(src) {
  const out = structuredClone(src);
  for (const [g, grp] of Object.entries(out.filters ?? {})) {
    for (const [id, v] of Object.entries(grp.filters ?? {})) {
      for (const k of Object.keys(v)) if (v[k] === '' || v[k] == null) delete v[k];
      if (!Object.keys(v).length) delete grp.filters[id];
    }
    if (!Object.keys(grp.filters ?? {}).length) delete out.filters[g];
  }
  out.stats = (out.stats ?? []).map((g) => ({ ...g, filters: g.filters.filter((f) => f.id) })).filter((g) => g.filters.length);
  if (!out.stats.length) out.stats = [{ type: 'and', filters: [] }];
  return out;
}

const itemText = () => q.term ?? [opt(q.name), opt(q.type)].filter(Boolean).join(' ');

function applyItem(e) {
  delete q.name;
  delete q.type;
  delete q.term;
  if (!e) return;
  if (e.name) q.name = e.disc ? { option: e.name, discriminator: e.disc } : e.name;
  q.type = e.disc ? { option: e.type, discriminator: e.disc } : e.type;
}

// Typed text that wasn't picked from the list: an exact name, or a free-text search term.
function commitItem(text) {
  text = text.trim();
  if (text === itemText()) return;
  applyItem(null);
  if (!text) return;
  const exact = ITEMS.find((e) => e.lc === text.toLowerCase());
  if (exact) applyItem(exact);
  else q.term = text;
}

// --- autocomplete --------------------------------------------------------------------------------

function autocomplete(input, source, onPick) {
  const list = el('ul', { className: 'ac', hidden: true });
  let items = [];
  let active = -1;
  const mark = () => [...list.children].forEach((li, i) => li.classList.toggle('on', i === active));
  const close = () => ((list.hidden = true), (active = -1));
  const pick = (i) => {
    const it = items[i];
    close();
    if (it) onPick(it);
  };
  const show = () => {
    items = source(input.value);
    list.replaceChildren(...items.map((it, i) => {
      const li = el('li', { className: it.cls ?? '' }, el('span', { textContent: it.label }), it.sub ? el('small', { textContent: it.sub }) : null);
      li.onmousedown = (e) => (e.preventDefault(), pick(i));
      return li;
    }));
    active = items.length ? 0 : -1;
    mark();
    list.hidden = !items.length;
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', () => input.value.trim() && show());
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      mark();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') close();
  });
  return el('span', { className: 'acwrap' }, input, list);
}

function rankBy(list, text, limit) {
  const ws = words(text);
  if (!ws.length) return [];
  const phrase = text.trim().toLowerCase();
  const hits = [];
  for (const e of list) {
    if (!ws.every((w) => e.lc.includes(w))) continue;
    hits.push({ e, s: e.lc.startsWith(phrase) ? 0 : e.lc.includes(phrase) ? 1 : 2 });
  }
  return hits.sort((a, b) => a.s - b.s || (a.e.rank ?? 0) - (b.e.rank ?? 0) || a.e.lc.length - b.e.lc.length).slice(0, limit).map((h) => h.e);
}

const statSource = (text) => rankBy(STATS, text, 60).map((s) => ({ label: s.text, sub: s.group, stat: s }));
const itemSource = (text) => rankBy(ITEMS, text, 40).map((e) => ({ label: e.label, sub: e.group, cls: e.unique ? 'unique' : '', entry: e }));

// --- form ----------------------------------------------------------------------------------------

function select(options, value, onChange, props = {}) {
  const key = (id) => (id == null ? '' : String(id));
  const s = el('select', props, ...options.map((o) => el('option', { value: key(o.id), textContent: o.text })));
  s.value = key(value);
  s.onchange = () => onChange(options.find((o) => key(o.id) === s.value)?.id ?? null);
  return s;
}

function num(get, set, placeholder, className = '') {
  const i = el('input', { type: 'number', step: 'any', placeholder, className });
  if (get() != null) i.value = get();
  i.oninput = () => set(i.value === '' ? null : Number(i.value));
  return i;
}
const bound = (obj, key) => [() => obj[key], (v) => (v == null ? delete obj[key] : (obj[key] = v))];

function render() {
  const groups = Object.fromEntries(FILTERS.map((g) => [g.id, g]));
  const typeF = Object.fromEntries((groups.type_filters?.filters ?? []).map((f) => [f.id, f]));
  const status = groups.status_filters?.filters?.[0]?.option?.options ?? [{ id: 'securable', text: 'Instant Buyout' }];

  const item = el('input', { type: 'text', id: 'item', className: 'wide', placeholder: 'item name or base type (blank: any)', value: itemText() });
  item.onchange = () => commitItem(item.value);
  const itemBox = autocomplete(item, itemSource, (it) => {
    applyItem(it.entry);
    item.value = itemText();
  });

  const trio = el('div', { className: 'trio' },
    select(typeF.category?.option?.options ?? [{ id: null, text: 'Any category' }], fget('type_filters', 'category').option, (v) => fset('type_filters', 'category', 'option', v), { title: 'item category' }),
    select(typeF.rarity?.option?.options ?? [{ id: null, text: 'Any rarity' }], fget('type_filters', 'rarity').option, (v) => fset('type_filters', 'rarity', 'option', v), { title: 'rarity' }),
    select(status, q.status?.option, (v) => (q.status = { option: v ?? 'any' }), { title: 'listing status' }),
  );

  $('fbody').replaceChildren(itemBox, trio, statsBox(), ...sections().filter(Boolean));
}

const GROUP_TYPES = [
  { id: 'and', text: 'And' }, { id: 'not', text: 'Not' }, { id: 'if', text: 'If' },
  { id: 'count', text: 'Count' }, { id: 'weight', text: 'Weighted sum' },
];

function statsBox() {
  const box = el('div', { style: 'display:grid; gap:8px' });
  q.stats.forEach((g, gi) => box.append(groupBox(g, gi)));
  box.append(el('div', {}, el('button', { type: 'button', className: 'link', textContent: '+ stat group', onclick: () => (q.stats.push({ type: 'and', filters: [] }), render()) })));
  return box;
}

function groupBox(g, gi) {
  const head = el('div', { className: 'ghead' },
    select(GROUP_TYPES, g.type, (v) => {
      g.type = v;
      if (v !== 'count' && v !== 'weight') delete g.value;
      render();
    }, { title: 'and: all must match · not: none may match · count: at least min of them · weighted sum: sum of value × weight' }));
  if (g.type === 'count' || g.type === 'weight') {
    g.value ??= {};
    head.append(num(...bound(g.value, 'min'), 'min'), num(...bound(g.value, 'max'), 'max'));
  }
  head.append(el('span', { className: 'grow' }));
  if (q.stats.length > 1 || g.filters.length) head.append(el('button', { type: 'button', className: 'x', textContent: '×', title: 'remove this group', onclick: () => (q.stats.splice(gi, 1), q.stats.length || q.stats.push({ type: 'and', filters: [] }), render()) }));

  const add = el('input', { type: 'text', className: 'wide', placeholder: '+ add stat filter…' });
  const addBox = autocomplete(add, statSource, (it) => {
    g.filters.push({ id: it.stat.id, value: {}, disabled: false });
    render();
    document.querySelector(`.srow[data-stat="${CSS.escape(it.stat.id)}"] input[type=number], .srow[data-stat="${CSS.escape(it.stat.id)}"] select`)?.focus();
  });
  return el('div', { className: 'g' }, head, ...g.filters.map((f, fi) => statRow(g, f, fi)), addBox);
}

function statRow(g, f, fi) {
  const st = STAT_BY_ID.get(f.id);
  f.value ??= {};
  const row = el('div', { className: `srow${st?.option ? ' opt' : g.type === 'weight' ? ' w' : ''}${f.disabled ? ' off' : ''}` });
  row.dataset.stat = f.id;
  const on = el('input', { type: 'checkbox', checked: !f.disabled, title: 'use this filter' });
  on.onchange = () => ((f.disabled = !on.checked), row.classList.toggle('off', f.disabled));
  row.append(on, el('span', { className: 'stext', title: f.id }, st?.text ?? f.id, el('small', { textContent: st?.group ?? '' })));
  if (st?.option) row.append(select([{ id: null, text: 'any' }, ...st.option.options], f.value.option, (v) => (v == null ? delete f.value.option : (f.value.option = v))));
  else row.append(num(...bound(f.value, 'min'), 'min'), num(...bound(f.value, 'max'), 'max'));
  if (g.type === 'weight' && !st?.option) row.append(num(...bound(f.value, 'weight'), 'weight'));
  row.append(el('button', { type: 'button', className: 'x', textContent: '×', title: 'remove', onclick: () => (g.filters.splice(fi, 1), render()) }));
  return row;
}

function sections() {
  return FILTERS.filter((g) => g.id !== 'status_filters').map((g) => {
    const fs = g.id === 'type_filters' ? g.filters.filter((f) => f.id !== 'category' && f.id !== 'rarity') : g.filters;
    if (!fs.length) return null;
    const set = fs.filter((f) => Object.keys(fget(g.id, f.id)).length).length;
    if (set) openSections.add(g.id);
    const d = el('details', { className: 'fsec', open: openSections.has(g.id) },
      el('summary', {}, g.title ?? g.id.replace('_', ' '), set ? el('b', { textContent: ` · ${set} set` }) : null),
      el('div', { className: 'fgrid' }, ...fs.map((f) => filterRow(g.id, f))));
    d.ontoggle = () => (d.open ? openSections.add(g.id) : openSections.delete(g.id));
    return d;
  });
}

function filterRow(gid, f) {
  const v = () => fget(gid, f.id);
  const row = el('div', { className: `frow${f.fullSpan || f.sockets ? ' full' : ''}` }, el('label', { textContent: f.text ?? f.id, title: f.tip ?? f.text ?? '' }));
  const n = (key, ph, cls) => num(() => v()[key], (x) => fset(gid, f.id, key, x), ph, cls);
  if (f.sockets) for (const c of ['r', 'g', 'b', 'w']) row.append(n(c, c.toUpperCase(), 'sock'));
  if (f.minMax) row.append(n('min', 'min'), n('max', 'max'));
  if (f.option?.options) row.append(select(f.option.options, v().option, (x) => fset(gid, f.id, 'option', x)));
  else if (f.option?.knownItem || f.input) {
    const key = f.input ? 'input' : 'option';
    const t = el('input', { type: 'text', placeholder: f.input?.placeholder ?? 'item name', value: v()[key] ?? '' });
    t.oninput = () => fset(gid, f.id, key, t.value.trim() || null);
    row.append(t);
  }
  return row;
}

// --- search --------------------------------------------------------------------------------------

async function doSearch(fresh = false) {
  const item = $('item');
  if (item) commitItem(item.value);
  const query = cleanQuery(q);
  showBusy();
  try {
    const r = await api('/api/search', { query, sort: { price: $('sort').value }, fresh });
    current = { ...r, rows: r.listings };
    if (location.hash.slice(1) !== r.id) history.pushState(null, '', `#${r.id}`);
    remember(r.id, query, r.total);
    renderResults();
  } catch (e) {
    showError(e.message, e.status === 429 ? 'The trade site is rate-limiting this IP right now (the browser trade site counts too). Wait for the countdown up top, then search again.' : '');
  } finally {
    $('go').disabled = false;
  }
}

async function loadMore() {
  if (!current) return;
  const btn = document.querySelector('.more');
  if (btn) (btn.disabled = true), (btn.textContent = 'fetching…');
  try {
    const r = await api('/api/search/page', { handle: current.handle, from: current.rows.length });
    current.rows.push(...r.listings);
    renderResults();
  } catch (e) {
    if (e.status === 410) return doSearch();
    showError(e.message);
  }
}

// --- results -------------------------------------------------------------------------------------

function money(c) {
  if (cfg.divine && c >= cfg.divine) return `${Math.round((c / cfg.divine) * 10) / 10} div`;
  return `${fmtC(c)}c`;
}

const filtered = () => new Set(q.stats.flatMap((g) => g.filters.filter((f) => !f.disabled).map((f) => f.id)));

// A mod line's value as the trade site filters it: the average for "Adds # to #", else the first number.
function modValue(text) {
  const t = clean(text);
  const nums = t.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!nums) return null;
  if (nums.length === 2 && /\d to \d/.test(t)) return Math.round(((nums[0] + nums[1]) / 2) * 10) / 10;
  return nums[0];
}

function addFromListing(id, text) {
  let row = null;
  for (const g of q.stats) {
    const f = g.filters.find((x) => x.id === id);
    if (f) (f.disabled = false), (row = f);
  }
  if (!row) {
    let g = q.stats.find((x) => x.type === 'and');
    if (!g) q.stats.unshift((g = { type: 'and', filters: [] }));
    const v = modValue(text);
    g.filters.push({ id, value: v == null ? {} : { min: v }, disabled: false });
  }
  render();
  const r = document.querySelector(`.srow[data-stat="${CSS.escape(id)}"]`);
  r?.scrollIntoView({ block: 'nearest' });
  r?.classList.add('flash');
  renderResults();
}

const MOD_KINDS = ['enchant', 'scourge', 'implicit', 'fractured', 'explicit', 'crafted', 'veiled', 'crucible', 'pseudo'];

// Trade listings carry mods as objects ({ description, hash, mods: [{ name, tier, magnitudes }] });
// crafted/fractured ones can sit in explicitMods with flags. Stash-style string lines still work.
const textOf = (m) => (typeof m === 'string' ? m : m?.description ?? '');
const tierOf = (m) => (m?.mods ?? []).filter((x) => x.tier);

function modList(it) {
  const hit = filtered();
  const kinds = [...MOD_KINDS, ...Object.keys(it).filter((k) => k.endsWith('Mods')).map((k) => k.slice(0, -4)).filter((k) => !MOD_KINDS.includes(k))];
  const ul = el('ul', { className: 'mods' });
  const inner = (k) => k === 'enchant' || k === 'implicit' || k === 'scourge';
  let prev = null;
  for (const kind of kinds) {
    const lines = it[`${kind}Mods`];
    if (!lines?.length) continue;
    const hashes = it.extended?.hashes?.[kind] ?? [];
    if ((prev && inner(prev) !== inner(kind)) || kind === 'pseudo') ul.append(el('li', { className: 'sep' }));
    lines.forEach((m, i) => {
      const line = textOf(m);
      const id = (typeof m === 'object' && m?.hash ? m.hash.replace(/^stat\./, '') : null) ?? hashes[i]?.[0];
      const k = m?.flags?.crafted ? 'crafted' : m?.flags?.fractured ? 'fractured' : kind;
      const tiers = tierOf(m);
      const li = el('li', { className: `k-${k}${id && hit.has(id) ? ' hit' : ''}` },
        tiers.length ? el('span', {
          className: 'tier',
          textContent: tiers.map((x) => x.tier).join('+'),
          title: tiers.map((x) => `${x.name} (${x.tier}, ilvl ${x.level}): ${(x.magnitudes ?? []).map((g) => (g.min === g.max ? g.min : `${g.min}–${g.max}`)).join(', ')}`).join('\n'),
        }) : null,
        clean(line));
      if (id && STAT_BY_ID.has(id)) {
        li.dataset.stat = id;
        li.title ||= 'add this line as a filter';
        li.onclick = () => addFromListing(id, line);
      }
      ul.append(li);
    });
    prev = kind;
  }
  return ul;
}

function socketText(it) {
  if (!it.sockets?.length) return '';
  let out = '';
  it.sockets.forEach((s, i) => (out += (i ? (s.group === it.sockets[i - 1].group ? '-' : ' ') : '') + s.sColour));
  return out;
}

function meta(it) {
  const prop = (name) => it.properties?.find((p) => p.name === name)?.values?.[0]?.[0];
  const x = it.extended ?? {};
  const r = (n) => Math.round(n);
  const bits = [
    strip(it.baseType) && strip(it.name) ? strip(it.baseType) : '',
    it.ilvl ? `ilvl ${it.ilvl}` : '',
    prop('Level') ? `level ${prop('Level')}` : '',
    prop('Quality') ? `Q ${prop('Quality')}` : '',
    prop('Map Tier') ? `tier ${prop('Map Tier')}` : '',
    it.stackSize > 1 ? `×${it.stackSize}` : '',
    socketText(it),
    x.pdps || x.edps ? `pDPS ${r(x.pdps ?? 0)} · eDPS ${r(x.edps ?? 0)}` : '',
    x.ar ? `AR ${r(x.ar)}` : '', x.ev ? `EV ${r(x.ev)}` : '', x.es ? `ES ${r(x.es)}` : '',
    ...Object.keys(it.influences ?? {}),
    it.fractured ? 'fractured' : '', it.synthesised ? 'synthesised' : '', it.mutated ? 'foulborn' : '',
    it.identified === false ? 'unidentified' : '', it.mirrored ? 'mirrored' : '',
  ].filter(Boolean);
  return el('div', { className: 'meta' }, bits.join(' · '), it.corrupted ? el('span', { className: 'corrupt', textContent: `${bits.length ? ' · ' : ''}corrupted` }) : null);
}

function listingCard(r) {
  const it = r.item ?? {};
  const l = r.listing ?? {};
  const p = l.price;
  const name = strip(it.name) || strip(it.typeLine);
  const price = p
    ? [el('div', { className: 'amt' }, `${p.amount}`, el('small', { textContent: p.currency })), r.chaos != null && p.currency !== 'chaos' ? el('div', { className: 'eq', textContent: `≈ ${money(r.chaos)}` }) : null]
    : [el('div', { className: 'eq', textContent: 'no price' })];
  const online = l.account?.online;
  const whisper = l.whisper
    ? el('button', { type: 'button', textContent: 'copy whisper', onclick: async (e) => {
        await navigator.clipboard.writeText(l.whisper);
        e.target.textContent = 'copied ✓';
      } })
    : p ? el('span', { className: 'tag', textContent: 'instant buyout', title: 'bought by visiting the hideout from the trade site' }) : null;
  return el('article', { className: 'lst' },
    el('img', { src: it.icon, loading: 'lazy', alt: '' }),
    el('div', {},
      el('div', { className: `nm ${FRAME[it.frameType] ?? ''}`, textContent: name || '?' }),
      meta(it),
      modList(it)),
    el('div', { className: 'px' },
      ...price,
      el('div', { className: 'seller' }, el('i', { className: `dot ${online ? 'on' : 'off'}`, title: online ? 'online' : 'offline' }), ` ${l.account?.name ?? '?'}`),
      el('div', { className: 'eq', textContent: l.indexed ? `listed ${ago(new Date(l.indexed))}` : '' }),
      whisper));
}

function renderResults() {
  const r = current;
  const head = el('div', { className: 'rhead' },
    el('span', { className: 'total', textContent: `${r.total.toLocaleString()} listed` }),
    r.count < r.total ? el('span', { className: 'muted', textContent: `the trade site returns the first ${r.count}` }) : null,
    el('span', { className: 'muted', textContent: r.cached ? `from ${ago(r.at)} (cached)` : `searched ${ago(r.at)}` }),
    el('button', { type: 'button', className: 'link', textContent: 'refresh', title: 'search again now (costs one search)', onclick: () => doSearch(true) }),
    el('a', { href: r.link, target: '_blank', rel: 'noreferrer', textContent: 'trade site ↗', title: 'open on pathofexile.com, e.g. to buy (the browser search counts against the same rate limit)' }));
  const left = r.count - r.rows.length;
  $('results').replaceChildren(head,
    ...(r.rows.length ? r.rows.map(listingCard) : [el('p', { className: 'muted', textContent: 'Nothing listed.' })]),
    left > 0 ? el('button', { type: 'button', className: 'more', textContent: `load ${Math.min(10, left)} more (${left} left)`, onclick: loadMore }) : null);
}

function showBusy() {
  $('go').disabled = true;
  const note = el('p', { className: 'muted', id: 'busy', textContent: 'searching…' });
  if (current) $('results').prepend(note);
  else $('results').replaceChildren(note);
}

function showError(msg, hint = '') {
  $('go').disabled = false;
  $('busy')?.remove();
  $('results').prepend(el('div', { id: 'errors', style: 'margin:0 0 10px', textContent: hint ? `${msg}\n${hint}` : msg }));
}

function intro() {
  $('results').replaceChildren(el('div', { className: 'intro' },
    el('p', {}, 'Search like on the trade site. Requests go through the pricer\'s rate limiter, ', el('b', { textContent: 'ahead of the background scan' }), ', and a search is kept for 5 minutes, so reloading or paging back is free.'),
    el('p', {}, 'Click a mod line on a result to add it as a filter. Trade site links open here: paste one above, or use the search links on the stash page.')));
}

// --- recent searches (the id is the query, so it's all we need to keep) ---------------------------

const RECENT = 'poe-search-recent';
function recent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT)) ?? [];
  } catch {
    return [];
  }
}

function describe(query) {
  const cat = query.filters?.type_filters?.filters?.category?.option;
  const head = query.term ?? ([opt(query.name), opt(query.type)].filter(Boolean).join(' ') || (cat ? cat.replace(/^\w+\./, '') : 'any item'));
  const stats = query.stats.flatMap((g) => g.filters.filter((f) => !f.disabled)).map((f) => {
    const t = STAT_BY_ID.get(f.id)?.text ?? f.id;
    return f.value?.min != null ? t.replace('#', f.value.min) : t;
  });
  return [head, ...stats].join(' · ').slice(0, 110);
}

function remember(id, query, total) {
  const list = [{ id, label: describe(query), total, at: Date.now() }, ...recent().filter((r) => r.id !== id)].slice(0, 30);
  try {
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    // private window: no history, nothing else breaks
  }
  renderRecent();
}

function renderRecent() {
  const list = recent();
  $('recent').replaceChildren(el('option', { value: '', textContent: list.length ? `recent searches (${list.length})` : 'no recent searches' }),
    ...list.map((r) => el('option', { value: r.id, textContent: `${r.label}  —  ${r.total} listed, ${ago(r.at)}` })));
}

// --- trade site ids ------------------------------------------------------------------------------

async function decodeId(id) {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  const bin = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

async function loadId(id, run = true) {
  let query;
  try {
    query = await decodeId(id);
  } catch {
    return showError(`Can't read search "${id.slice(0, 24)}…".`, 'Only links from the current trade site (long ids starting with H4sI) open here.');
  }
  q = normalize(query);
  openSections.clear();
  render();
  if (run) await doSearch();
}

function openPasted(text) {
  const s = text.trim();
  if (!s) return;
  if (/\/trade\/exchange\//.test(s)) return showError('Bulk exchange links aren\'t supported here, only item searches.');
  const m = s.match(/trade\/search\/([^/]+)\/([^/?#\s]+)/);
  const id = m ? m[2] : s.replace(/^#/, '');
  if (m && decodeURIComponent(m[1]) !== cfg.league) showError(`That link was for ${decodeURIComponent(m[1])}; searching ${cfg.league}.`);
  $('paste').value = '';
  loadId(id);
}

// --- rate budget ---------------------------------------------------------------------------------

function bucketText(name, b) {
  if (b.waitMs > 0) return el('span', { className: 'wait', textContent: `${name}: wait ${Math.ceil(b.waitMs / 1000)}s` });
  if (!b.rules.length) return null;
  const tight = b.rules.reduce((a, r) => (r.left < a.left || (r.left === a.left && r.period < a.period) ? r : a));
  return el('span', { className: tight.left <= 1 ? 'low' : '', textContent: `${name} ${tight.left}/${tight.max} per ${tight.period}s` });
}

async function pollBudget() {
  if (document.hidden) return;
  try {
    const b = await api('/api/search/budget');
    const parts = [bucketText('search', b.search), bucketText('fetch', b.fetch), b.scanning ? el('span', { textContent: 'stash scan running: your searches go first' }) : null].filter(Boolean);
    const all = ['search', 'fetch'].flatMap((k) => b[k].rules.map((r) => `${k}: ${r.left} of ${r.max} left in ${r.period}s`)).join('\n');
    $('budget').title = all ? `requests left before the trade site's limit (one kept spare):\n${all}` : 'limits are learned from the first request';
    $('budget').replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
  } catch {
    // server restarting
  }
}

// --- boot ----------------------------------------------------------------------------------------

async function boot() {
  intro();
  renderRecent();
  try {
    const [c, f, s, i] = await Promise.all([api('/api/config'), api('/api/trade/data/filters'), api('/api/trade/data/stats'), api('/api/trade/data/items')]);
    Object.assign(cfg, c);
    $('league').textContent = c.league;
    FILTERS = f.result;
    const order = ['pseudo', 'explicit', 'implicit', 'fractured', 'crafted', 'enchant'];
    for (const g of s.result) {
      const rank = order.includes(g.id) ? order.indexOf(g.id) : order.length;
      for (const e of g.entries) {
        const st = { id: e.id, text: e.text, lc: e.text.toLowerCase(), group: g.label, rank, option: e.option };
        STATS.push(st);
        STAT_BY_ID.set(e.id, st);
      }
    }
    for (const g of i.result) {
      for (const e of g.entries) {
        const label = e.text ?? e.type;
        ITEMS.push({ label, lc: label.toLowerCase(), name: e.name, type: e.type, disc: e.disc, unique: !!e.flags?.unique, group: g.label, rank: e.flags?.unique ? 0 : 1 });
      }
    }
  } catch (e) {
    $('fbody').replaceChildren(el('p', { className: 'err', textContent: `Couldn't load the trade site's lists: ${e.message}` }));
    return;
  }
  render();
  renderRecent(); // labels need the stat list
  $('form').onsubmit = (e) => (e.preventDefault(), doSearch());
  $('clear').onclick = () => ((q = defaultQuery()), openSections.clear(), render());
  $('recent').onchange = () => {
    const id = $('recent').value;
    $('recent').value = '';
    if (id) loadId(id);
  };
  $('paste').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), openPasted($('paste').value)));
  $('paste').addEventListener('paste', () => setTimeout(() => openPasted($('paste').value)));
  const fromHash = () => {
    const id = location.hash.slice(1);
    if (id && id !== current?.id) loadId(id);
  };
  addEventListener('hashchange', fromHash);
  addEventListener('popstate', fromHash);
  fromHash();
  pollBudget();
  setInterval(pollBudget, 2000);
}

boot();
