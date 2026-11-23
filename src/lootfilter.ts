// Online item filters on pathofexile.com, pulled to filters/ and pushed back with the session cookie.
// The site has no item-filter API for session users, so this drives the same pages a browser does:
// - list:  /my-account/item-filters (owned and followed filters)
// - pull:  /item-filter/<id>: an owned filter's edit form (textarea "filter"), or a followed
//          filter's read-only view (<pre>)
// - push:  POST that edit form back with the new text and its fresh CSRF hash. Owned filters only.
//
// filters/<id>.filter is the text exactly as the site stores it (CRLF). filters/<id>.json records the
// text we last pulled or pushed, so a push refuses to overwrite edits made on the website meanwhile.
//
// CLI: node --env-file=.env src/lootfilter.ts list | pull <id> | push <id> [--force]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { poeFetch } from './poeClient.ts';

const SITE = 'https://www.pathofexile.com';
export const filtersDir = join(import.meta.dirname, '..', 'filters');

export type FilterInfo = { id: string; name: string; owned: boolean; author: string; updated: string; valid: string };
export type Meta = { id: string; name: string; owned: boolean; author: string; pulledAt: number; sha: string; version?: string };

const sha = (s: string) => createHash('sha256').update(lf(s)).digest('hex').slice(0, 16);
// the site stores CRLF; edits may come back with LF. Compare text, not line endings.
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const crlf = (s: string) => lf(s).replace(/\n/g, '\r\n');

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const tagText = (s: string) => unescapeHtml(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function page(path: string, init: RequestInit = {}): Promise<string> {
  if (!config.poesessid) throw new Error('POESESSID missing in .env');
  const res = await poeFetch('filter', `${SITE}${path}`, { ...init, headers: { Accept: 'text/html', ...(init.headers as Record<string, string>) } }, { cookie: true });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
  if (/<title>Just a moment/.test(text)) throw new Error(`${path}: blocked by Cloudflare`);
  if (/name="login_email"|\/login"/.test(text) && !/logout_button/.test(text)) throw new Error('POESESSID rejected: not logged in');
  return text;
}

export function parseList(html: string): FilterInfo[] {
  return html.split('<div class="item-filter">').slice(1).map((b) => {
    const m = b.match(/href="\/item-filter\/([A-Za-z0-9]+)">([^<]*)</);
    const t = tagText(b);
    return {
      id: m?.[1] ?? '',
      name: unescapeHtml(m?.[2] ?? ''),
      // followed filters carry an Unfollow button; our own carry Edit
      owned: !/unfollow-button/.test(b),
      author: t.match(/Created by : (\S+)/)?.[1] ?? '',
      updated: t.match(/Last updated : (.*?(?:AM|PM))/)?.[1] ?? '',
      valid: t.match(/Last Valid Version: ([^)]*)/)?.[1] ?? '',
    };
  }).filter((f) => f.id);
}

export async function listFilters(): Promise<FilterInfo[]> {
  return parseList(await page('/my-account/item-filters'));
}

type Form = { fields: [string, string][]; filter: string };

// The edit form's fields as a browser would submit them (checked boxes only, selected options).
export function parseEditForm(html: string): Form | null {
  const start = html.indexOf('<form method="POST" class="t1">');
  if (start < 0) return null;
  const form = html.slice(start, html.indexOf('</form>', start));
  const fields: [string, string][] = [];
  const attr = (tag: string, a: string) => tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];
  const re = /<input\b[^>]*>|<textarea\b[^>]*>([\s\S]*?)<\/textarea>|<select\b[^>]*>([\s\S]*?)<\/select>/g;
  let filter: string | null = null;
  for (const m of form.matchAll(re)) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const name = attr(tag, 'name');
    if (!name) continue;
    if (tag.startsWith('<textarea')) {
      const v = unescapeHtml(m[1]).replace(/^\r?\n/, ''); // a newline right after <textarea> isn't content
      if (name === 'filter') filter = v;
      fields.push([name, v]);
    } else if (tag.startsWith('<select')) {
      const opts = [...m[2].matchAll(/<option\b[^>]*>/g)].map((o) => o[0]);
      const sel = opts.find((o) => /\sselected/.test(o)) ?? opts[0];
      fields.push([name, unescapeHtml(attr(sel ?? '', 'value') ?? '')]);
    } else {
      const type = attr(tag, 'type') ?? 'text';
      if ((type === 'checkbox' || type === 'radio') && !/\schecked/.test(tag)) continue;
      fields.push([name, unescapeHtml(attr(tag, 'value') ?? '')]);
    }
  }
  return filter === null ? null : { fields, filter };
}

function parseView(html: string): string | null {
  const m = html.match(/<pre id="editor" class="item-filter-view-filter">([\s\S]*?)<\/pre>/);
  return m ? unescapeHtml(m[1]) : null;
}

const files = (id: string) => ({ text: join(filtersDir, `${id}.filter`), meta: join(filtersDir, `${id}.json`) });

export async function readMeta(id: string): Promise<Meta | null> {
  try {
    return JSON.parse(await readFile(files(id).meta, 'utf8'));
  } catch {
    return null;
  }
}

async function remote(id: string) {
  const html = await page(`/item-filter/${id}`);
  const form = parseEditForm(html);
  const text = form?.filter ?? parseView(html);
  if (text == null) throw new Error(`item filter ${id}: no filter text on the page`);
  return { html, form, text };
}

export async function pull(id: string, info?: FilterInfo): Promise<Meta & { path: string; lines: number }> {
  const { form, text } = await remote(id);
  const f = info ?? (await listFilters()).find((x) => x.id === id);
  const meta: Meta = {
    id,
    name: form?.fields.find(([k]) => k === 'filter_name')?.[1] ?? f?.name ?? id,
    owned: !!form,
    author: f?.author ?? '',
    pulledAt: Date.now(),
    sha: sha(text),
    version: form?.fields.find(([k]) => k === 'version')?.[1],
  };
  await mkdir(filtersDir, { recursive: true });
  await writeFile(files(id).text, text);
  await writeFile(files(id).meta, JSON.stringify(meta, null, 2) + '\n');
  return { ...meta, path: files(id).text, lines: lf(text).split('\n').length };
}

// Push filters/<id>.filter. Refuses if the site's copy changed since our last pull/push (someone
// edited it on the website), unless force. Bumps a numeric version. Verifies by reading it back.
export async function push(id: string, opts: { force?: boolean; text?: string } = {}) {
  const meta = await readMeta(id);
  if (!meta) throw new Error(`no filters/${id}.json: pull it first`);
  const text = crlf(opts.text ?? (await readFile(files(id).text, 'utf8')));
  const { form, text: live } = await remote(id);
  if (!form) throw new Error(`${meta.name} (${id}) is a followed filter: it can't be edited, only copied`);
  if (sha(live) !== meta.sha && !opts.force) throw new Error(`${meta.name} changed on the website since the last pull: pull again (or force)`);
  if (sha(live) === sha(text)) return { ...meta, changed: false };

  const body = new URLSearchParams();
  let version = '';
  for (const [k, v] of form.fields) {
    if (k === 'filter') body.append(k, text);
    else if (k === 'version') body.append(k, (version = /^\d+$/.test(v) ? String(Number(v) + 1) : v));
    else body.append(k, v);
  }
  if (!body.has('submit')) body.append('submit', 'Submit');
  const res = await page(`/item-filter/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE, Referer: `${SITE}/item-filter/${id}` },
    body: body.toString(),
  });
  const errors = [...res.matchAll(/<(?:ul|div|p)[^>]*class="[^"]*\berrors?\b[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div|p)>/g)].map((m) => tagText(m[1])).filter(Boolean);
  const after = await remote(id);
  if (sha(after.text) !== sha(text)) throw new Error(`push didn't stick${errors.length ? `: ${errors.join('; ')}` : ''}`);
  const next: Meta = { ...meta, sha: sha(after.text), pulledAt: Date.now(), version };
  await writeFile(files(id).text, after.text);
  await writeFile(files(id).meta, JSON.stringify(next, null, 2) + '\n');
  return { ...next, changed: true, warnings: errors };
}

// --- CLI -------------------------------------------------------------------------------------------

if (import.meta.main) {
  const [cmd, id, ...rest] = process.argv.slice(2);
  const run = async () => {
    if (cmd === 'list') {
      for (const f of await listFilters()) console.log(`${f.id.padEnd(10)} ${f.owned ? 'own   ' : 'follow'} ${f.name.padEnd(42)} ${f.updated.padEnd(26)} ${f.valid}${f.owned ? '' : `  by ${f.author}`}`);
    } else if (cmd === 'pull' && id) {
      const r = await pull(id);
      console.log(`${r.name} (${r.owned ? 'own, editable' : `followed, read-only, by ${r.author}`}): ${r.lines} lines -> ${r.path}`);
    } else if (cmd === 'push' && id) {
      const r = await push(id, { force: rest.includes('--force') });
      console.log(r.changed ? `pushed ${r.name} (version ${r.version})` : `${r.name}: no changes to push`);
    } else {
      console.log('usage: node --env-file=.env src/lootfilter.ts list | pull <id> | push <id> [--force]');
      process.exitCode = 2;
    }
  };
  run().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
