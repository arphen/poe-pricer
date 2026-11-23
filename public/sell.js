// Sell list: price groups, each with stash searches that light up exactly its items.
// Flow in game: "Copy next" (or N), alt-tab, paste into the stash search, move everything lit to the
// merchant tab at the group's price, come back, N again.
// trade site links open on our search page (same query, through the rate limiter)
const searchHref = (link) => `search.html#${link.slice(link.lastIndexOf('/') + 1)}`;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
};
async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// per-browser conveniences: settings and which strings were already copied. Strings are their own
// key, so a changed stash (new strings) starts fresh by itself.
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`sell.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`sell.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const STEPS = {
  fine: 'many price levels: little value left on the table, more rounds',
  normal: 'about a quarter between levels',
  coarse: 'few price levels: fewest rounds, lists more items a bit under their price',
};
let min = store.get('min', 20);
let step = store.get('step', 'normal');
let copied = new Set(store.get('copied', []));
let data = null;

const fmtC = (c) => (c >= 1000 ? `${Math.round(c / 100) / 10}k` : c >= 10 ? `${Math.round(c)}` : `${Math.round(c * 10) / 10}`);
const label = (lv) => (lv.currency === 'divine' ? `${lv.amount} div` : `${lv.amount}c`);
const money = (c) => (data?.divine && c >= data.divine ? `${Math.round((c / data.divine) * 10) / 10} div` : `${fmtC(c)}c`);
const rarity = (f) => ['', 'magic', 'rare', 'unique'][f] ?? '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

function saveCopied() {
  store.set('copied', [...copied].slice(-400));
}

// the next string to paste: groups from the dearest down, strings in order
function nextUp() {
  for (const g of data?.groups ?? []) {
    const i = g.strings.findIndex((s) => !copied.has(s));
    if (i >= 0) return { g, i, s: g.strings[i] };
  }
  return null;
}

async function copy(s, button) {
  try {
    await navigator.clipboard.writeText(s);
  } catch (e) {
    $('status').textContent = `copy failed (${e.message}): click the page first`;
    return false;
  }
  copied.add(s);
  saveCopied();
  render();
  // re-find the button after render to flash it
  for (const b of document.querySelectorAll('.rx')) if (b.dataset.s === s) b.classList.add('flash');
  return true;
}

async function load(fresh = false) {
  $('status').textContent = fresh ? 're-reading stash…' : 'reading stash…';
  try {
    data = await api(`/api/sell?min=${min}&step=${step}${fresh ? '&fresh=1' : ''}`);
    $('status').textContent = `${data.stashItems} items in the stash checked`;
  } catch (e) {
    $('status').replaceChildren(el('span', { className: 'err', textContent: e.message }));
    data = null;
  }
  render();
}

function render() {
  const root = $('sell');
  root.replaceChildren();
  if (!data) return;
  const items = data.groups.reduce((a, g) => a + g.items.length, 0);
  const strings = data.groups.reduce((a, g) => a + g.strings.length, 0);
  const left = data.groups.reduce((a, g) => a + g.strings.filter((s) => !copied.has(s)).length, 0);
  const total = data.groups.reduce((a, g) => a + g.sum, 0);

  if (data.unread.length) root.append(el('div', { className: 'warnbox', textContent: `Could not read ${data.unread.join(', ')}. The searches were checked against the rest of the stash only, so they might also light up something there.` }));

  if (!data.groups.length) {
    root.append(el('p', { className: 'muted', textContent: `Nothing trade-priced at ${min}c or more in the stash. Price your dump tabs on the Stash page first.` }));
  } else {
    const nu = nextUp();
    const next = el('button', { id: 'next', className: 'primary', textContent: nu ? 'Copy next search' : 'All copied', disabled: !nu });
    next.onclick = () => nu && copy(nu.s);
    const reset = el('button', { className: 'link', textContent: 'start over', title: 'forget which searches were copied' });
    reset.onclick = () => {
      for (const g of data.groups) for (const s of g.strings) copied.delete(s);
      saveCopied();
      render();
    };
    root.append(
      el('div', { className: 'muted' },
        el('b', { textContent: `${items}` }), ` items worth ${min}c or more · ${plural(data.groups.length, 'price')} · ≈ ${money(total)} listed · `,
        el('b', { textContent: `${strings}` }), ` ${strings === 1 ? 'search' : 'searches'} to paste`),
      el('div', { className: 'bar' }, next,
        el('span', { id: 'nextInfo', className: 'muted' },
          ...(nu
            ? ['list at ', el('b', { textContent: label(nu.g.level) }), nu.g.strings.length > 1 ? ` · search ${nu.i + 1} of ${nu.g.strings.length}` : '', ` · in ${nu.g.tabs.map((t) => t.name).join(', ')} · `, el('kbd', { textContent: 'N' }), ' copies the next one']
            : ['every search copied · ', reset])),
        nu && left < strings ? reset : null),
    );
  }

  for (const g of data.groups) root.append(groupCard(g, nextUp()?.g === g));

  if (data.byHand.length) {
    root.append(el('h2', { textContent: 'Look at these by hand' }),
      el('p', { className: 'muted', textContent: 'Kept out of the searches: the price may be off in the direction of underselling.' }),
      itemTable(data.byHand, true));
  }
}

function groupCard(g, isNext) {
  const done = g.strings.every((s) => copied.has(s));
  const sub = g.level.currency === 'divine' ? el('small', { textContent: `≈ ${fmtC(g.level.chaos)}c` }) : null;
  const note = el('button', { className: 'link', textContent: g.note, title: 'copy the price note, for listing in a premium stash tab' });
  note.onclick = () => navigator.clipboard.writeText(g.note).then(() => (note.textContent = `${g.note} ✓`));
  const strings = g.strings.map((s) => {
    const b = el('button', { className: `rx ${copied.has(s) ? 'copied' : ''}`, textContent: s, title: 'copy, then paste into the stash search in game' });
    b.dataset.s = s;
    b.onclick = () => copy(s, b);
    return b;
  });
  const undo = done ? el('button', { className: 'link', textContent: 'not done', onclick: () => (g.strings.forEach((s) => copied.delete(s)), saveCopied(), render()) }) : null;
  return el('section', { className: `sg ${done ? 'done' : ''} ${isNext ? 'next' : ''}` },
    el('div', { className: 'sg-head' },
      el('div', { className: 'sg-price' }, label(g.level), sub),
      el('div', { className: 'muted grow' }, `${plural(g.items.length, 'item')} · ≈ ${money(g.sum)} · in ${g.tabs.map((t) => (t.n > 1 ? `${t.name} ×${t.n}` : t.name)).join(', ')}`),
      note, undo),
    el('div', { className: 'sg-strings' }, ...strings),
    g.missing.length ? el('div', { className: 'missing', textContent: `No search can single out ${g.missing.join(', ')} (an identical item sits elsewhere): move ${g.missing.length === 1 ? 'it' : 'them'} by hand.` }) : null,
    el('div', { className: 'icons' }, ...g.items.map((i) => el('img', { src: i.icon, loading: 'lazy', alt: '', title: `${i.name} · ${fmtC(i.chaos)}c · ${i.tabName}` }))),
    el('details', {}, el('summary', { className: 'muted', textContent: 'items' }), itemTable(g.items, false)),
  );
}

function itemTable(list, why) {
  return el('table', {}, ...list.map((i) => el('tr', {},
    el('td', {}, el('span', { className: rarity(i.frame), textContent: i.name }), i.base ? el('span', { className: 'muted', textContent: ` ${i.base}` }) : null,
      why ? el('div', { className: 'warn', textContent: i.why }) : i.warn.length ? el('div', { className: 'warn', textContent: i.warn.join(' · ') }) : null),
    el('td', { className: 'muted', textContent: i.tabName }),
    el('td', { className: 'num', textContent: `${fmtC(i.chaos)}c` }),
    el('td', { className: 'num muted', textContent: `${i.total} listed · ${ago(i.at)}` }),
    el('td', { className: 'num' }, i.link ? el('a', { href: searchHref(i.link), target: 'poe-search', textContent: 'search ↗' }) : ''),
  )));
}

function renderSteps() {
  $('step').replaceChildren(...Object.entries(STEPS).map(([k, title]) => {
    const b = el('button', { className: step === k ? 'on' : '', textContent: k, title });
    b.onclick = () => {
      step = k;
      store.set('step', step);
      renderSteps();
      load();
    };
    return b;
  }));
}

$('min').value = min;
let typing = null;
$('min').oninput = () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    const v = Number($('min').value);
    if (!(v > 0)) return;
    min = v;
    store.set('min', min);
    load();
  }, 400);
};
$('reload').onclick = () => load(true);
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') {
    const nu = nextUp();
    if (nu) copy(nu.s);
  }
});
renderSteps();
load();
