// Manual trade searches for the search page. Same query format as the trade site, but every request
// goes through poeFetch's limiter, ahead of background work, so searching by hand no longer races the
// scanner for the budget (the browser trade site doesn't know about our requests and trips the limit).
// Results are kept a few minutes: re-running a search, reloading the page or paging back is free.
import { createHash } from 'node:crypto';
import { config } from './config.ts';
import { recordListings, recordSearch } from './dataset.ts';
import { budget, poeFetch } from './poeClient.ts';
import { chaosRates, toChaos } from './rates.ts';
import { scanStatus } from './scanner.ts';
import { fetchRaw, toListing, type Listing } from './trade.ts';
import { priceable } from './valuation.ts';

const KEEP_MS = 5 * 60_000;
const PAGE = 10;

type Row = { id: string; item: any; listing: any; chaos: number | null; rank: number };
type Search = { handle: string; id: string; body: { query: any; sort: any }; total: number; result: string[]; at: number; pages: Map<number, Promise<Row[]>> };
const searches = new Map<string, Search>();

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const league = () => encodeURIComponent(config.league);
const link = (id: string) => `https://www.pathofexile.com/trade/search/${league()}/${id}`;
// Price-sorted searches only: listing rank means "position in the price order" to the model.
const byPriceAsc = (s: Search) => s.body.sort?.price === 'asc' && Object.keys(s.body.sort).length === 1;

export async function runSearch(input: { query: any; sort?: any }, fresh = false) {
  if (!input?.query || typeof input.query !== 'object') throw new HttpError(400, 'query missing');
  const body = { query: input.query, sort: input.sort ?? { price: 'asc' } };
  const handle = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  for (const [k, s] of searches) if (Date.now() - s.at > KEEP_MS) searches.delete(k);
  let s = searches.get(handle);
  const cached = !!s && !fresh;
  if (!s || fresh) {
    const res = await poeFetch('search', `https://www.pathofexile.com/api/trade/search/${league()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { urgent: true });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 400, data?.error?.message ?? `trade search failed: ${res.status}`);
    s = { handle, id: data.id, body, total: data.total ?? 0, result: data.result ?? [], at: Date.now(), pages: new Map() };
    searches.set(handle, s);
  }
  const listings = await page(s, 0);
  return { handle, id: s.id, total: s.total, count: s.result.length, link: link(s.id), at: s.at, cached, from: 0, listings };
}

export async function searchPage(handle: string, from: number) {
  const s = searches.get(handle);
  if (!s) throw new HttpError(410, 'search expired, run it again');
  return { from, listings: await page(s, Math.max(0, Math.floor(from))) };
}

function page(s: Search, from: number): Promise<Row[]> {
  let p = s.pages.get(from);
  if (!p) {
    p = fetchPage(s, from);
    s.pages.set(from, p);
    p.catch(() => s.pages.delete(from));
  }
  return p;
}

async function fetchPage(s: Search, from: number): Promise<Row[]> {
  const raw = await fetchRaw(s.result.slice(from, from + PAGE), s.id, true);
  const rates = await chaosRates().catch(() => ({ chaos: 1 }) as Record<string, number>);
  const rows = raw.map((r) => {
    const price = r.listing?.price;
    return { id: r.id, item: r.item, listing: r.listing, chaos: price ? toChaos(price.amount, price.currency, rates) : null, rank: s.result.indexOf(r.id) };
  });
  // hand searches are training data too (rares/magic only: the model doesn't price anything else)
  if (byPriceAsc(s)) {
    const ls = raw.map((r) => toListing(r, s.result)).filter((l): l is Listing => l !== null && priceable(l.item));
    const rec = from === 0
      ? recordSearch({ id: `manual:${s.handle}` }, s.body, { searchId: s.id, total: s.total, listings: ls }, rates, { chaos: null, relaxed: false })
      : recordListings(s.id, ls, rates);
    await rec.catch((e) => console.warn('dataset:', e.message));
  }
  return rows;
}

export function searchBudget() {
  return { search: budget('search'), fetch: budget('fetch'), scanning: scanStatus().running };
}
