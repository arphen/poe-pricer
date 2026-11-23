// Persistent training data. Every trade fetch returns full item JSON for each listing, so one price
// check yields ~10 labelled examples (item -> asking price in chaos). Raw items are kept, not
// features, so the feature code can change and the whole history is re-featurized on retrain.
// Lives in data/ (not .cache/): this is the long-term asset, never safe to wipe.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.ts';
import { toChaos } from './rates.ts';
import type { Listing } from './trade.ts';

// rank: position in the search's price-sorted results (absent on records from before spread fetches)
export type ListingObs = { k: 'listing'; id: string; at: number; chaos: number; amount: number; currency: string; indexed: string; item: any; query: string; rank?: number };
// one record per search we ran for our own item: lets us later study which filters gave good comps
export type QueryObs = { k: 'query'; at: number; query: string; own: string; item: any; body: any; total: number; ids: string[]; spread?: string[]; chaos: number | null; relaxed: boolean; dropped?: number };
// what a search was, for judging how informative its listings are
// own: the stash item it was run for ('probe:...' for explorer searches)
export type QueryInfo = { total: number; filters: number; status: string; own: string };
// the trade price our pricer settled on for one of our items (its last search that found one)
export type OwnPrice = { own: string; item: any; chaos: number; query: string; status: string };
export type Obs = ListingObs | QueryObs;

const dir = join(import.meta.dirname, '..', 'data');
export const obsFile = join(dir, `obs-${config.league}.jsonl`);

let listings: Map<string, ListingObs> | null = null;
let queries = 0;
const owned = new Map<string, OwnPrice>(); // own item id -> latest settled price
const info = new Map<string, QueryInfo>(); // search id -> what it was
const statFilters = (body: any) => (body?.query?.stats ?? []).reduce((a: number, g: any) => a + (g.filters?.length ?? 0), 0);
let loading: Promise<void> | null = null;

async function load() {
  listings = new Map();
  let text = '';
  try {
    text = await readFile(obsFile, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as Obs;
      // a re-seen listing (repriced or not) replaces the older record
      if (o.k === 'listing') listings.set(o.id, o);
      else noteQuery(o);
    } catch {
      // torn last line after a crash: skip
    }
  }
}

function noteQuery(o: QueryObs) {
  queries++;
  const status = o.body?.query?.status?.option ?? '';
  const own = String(o.own || o.item?.id || '');
  info.set(o.query, { total: o.total, filters: statFilters(o.body), status, own });
  if (own && !own.startsWith('probe:') && o.chaos != null && o.chaos > 0 && o.item) owned.set(own, { own, item: o.item, chaos: o.chaos, query: o.query, status });
}

const ready = () => (loading ??= load());

export async function ownPrices(): Promise<OwnPrice[]> {
  await ready();
  return [...owned.values()];
}

export async function allListings(): Promise<ListingObs[]> {
  await ready();
  return [...listings!.values()];
}

export async function queryInfo(): Promise<Map<string, QueryInfo>> {
  await ready();
  return info;
}

export async function datasetStats() {
  await ready();
  return { listings: listings!.size, queries };
}

function newListings(ls: Listing[], searchId: string, rates: Record<string, number>, at: number): ListingObs[] {
  const out: ListingObs[] = [];
  for (const l of ls) {
    const chaos = toChaos(l.amount, l.currency, rates);
    if (chaos == null || chaos <= 0 || !l.item || !l.id) continue;
    const prev = listings!.get(l.id);
    if (prev && prev.amount === l.amount && prev.currency === l.currency) continue;
    const o: ListingObs = { k: 'listing', id: l.id, at, chaos, amount: l.amount, currency: l.currency, indexed: l.indexed, item: l.item, query: searchId, rank: l.rank };
    listings!.set(l.id, o);
    out.push(o);
  }
  return out;
}

async function append(out: Obs[]) {
  if (!out.length) return;
  await mkdir(dir, { recursive: true });
  await appendFile(obsFile, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// Record a search and its listings. Listings already stored at the same price are not re-appended.
export async function recordSearch(
  own: any,
  body: unknown,
  r: { searchId: string; total: number; listings: Listing[]; spread?: Listing[] },
  rates: Record<string, number>,
  extra: { chaos: number | null; relaxed: boolean; dropped?: number },
): Promise<number> {
  await ready();
  const at = Date.now();
  const out: Obs[] = newListings([...r.listings, ...(r.spread ?? [])], r.searchId, rates, at);
  const q: QueryObs = { k: 'query', at, query: r.searchId, own: own?.id ?? '', item: own, body, total: r.total, ids: r.listings.map((l) => l.id), spread: (r.spread ?? []).map((l) => l.id), ...extra };
  out.push(q);
  noteQuery(q);
  await append(out);
  return out.length - 1;
}

// More listings of a search already recorded (a later page of it).
export async function recordListings(searchId: string, ls: Listing[], rates: Record<string, number>): Promise<number> {
  await ready();
  const out = newListings(ls, searchId, rates, Date.now());
  await append(out);
  return out.length;
}
