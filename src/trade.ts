import { cached } from './cache.ts';
import { config } from './config.ts';
import { poeFetch } from './poeClient.ts';
import { indexStats, type StatsIndex } from './query.ts';

// The trade site's own reference lists: stat ids, item names/bases, filter definitions, currency ids.
export type TradeDataKind = 'stats' | 'items' | 'filters' | 'static';
const dataPromises = new Map<TradeDataKind, Promise<any>>();

export function tradeData(kind: TradeDataKind): Promise<{ result: any[] }> {
  let p = dataPromises.get(kind);
  if (!p) {
    p = cached(`trade-${kind}`, 24 * 3600 * 1000, async () => {
      const res = await poeFetch('data', `https://www.pathofexile.com/api/trade/data/${kind}`);
      if (!res.ok) throw new Error(`trade ${kind} request failed: ${res.status}`);
      return res.json();
    });
    dataPromises.set(kind, p);
    p.catch(() => dataPromises.delete(kind));
  }
  return p;
}

let statsPromise: Promise<StatsIndex> | null = null;

export function getStats(): Promise<StatsIndex> {
  statsPromise ??= tradeData('stats').then(indexStats);
  statsPromise.catch(() => (statsPromise = null));
  return statsPromise;
}

// `item` is the listed item's full JSON: kept as training data for the price model.
// `rank`: position in the search's price-sorted result list (0 = cheapest).
export type Listing = { id: string; amount: number; currency: string; indexed: string; seller: string; whisper: string; item: any; rank: number };

// Up to `count` ids spread evenly over the result list past the first `from` (always incl. the last).
export function spreadIds(ids: string[], from: number, count: number): string[] {
  const rest = ids.slice(from);
  if (rest.length <= count) return rest;
  return Array.from({ length: count }, (_, k) => rest[Math.round((k * (rest.length - 1)) / (count - 1))]);
}

// Raw fetch results (item + listing), in the order asked.
export async function fetchRaw(ids: string[], searchId: string, urgent = false): Promise<any[]> {
  if (!ids.length) return [];
  const fetchRes = await poeFetch('fetch', `https://www.pathofexile.com/api/trade/fetch/${ids.join(',')}?query=${searchId}`, {}, { urgent });
  if (!fetchRes.ok) throw new Error(`trade fetch failed: ${fetchRes.status}`);
  return ((await fetchRes.json()) as { result: any[] }).result.filter(Boolean);
}

export function toListing(r: any, all: string[]): Listing | null {
  if (!r?.listing?.price) return null;
  return {
    id: r.id,
    item: r.item,
    amount: r.listing.price.amount,
    currency: r.listing.price.currency,
    indexed: r.listing.indexed,
    seller: r.listing.account?.name ?? '',
    whisper: r.listing.whisper ?? '',
    rank: all.indexOf(r.id),
  };
}

async function fetchListings(ids: string[], searchId: string, all: string[], urgent: boolean): Promise<Listing[]> {
  return (await fetchRaw(ids, searchId, urgent)).map((r) => toListing(r, all)).filter((l): l is Listing => l !== null);
}

// `listings`: the cheapest `limit`, used for the price. `spread`: up to `spread` more from further up
// the price list, training data only. Without them the model would only ever see the cheapest items
// of each search and learn that everything is cheap. `urgent`: the user is waiting on it.
export async function priceCheck(body: unknown, limit = 10, spread = 10, urgent = false) {
  const league = encodeURIComponent(config.league);
  const searchRes = await poeFetch('search', `https://www.pathofexile.com/api/trade/search/${league}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { urgent });
  if (!searchRes.ok) throw new Error(`trade search failed: ${searchRes.status} ${await searchRes.text()}`);
  const search = (await searchRes.json()) as { id: string; result: string[]; total: number };
  const listings = await fetchListings(search.result.slice(0, limit), search.id, search.result, urgent);
  // the spread is a bonus: a failed fetch there must not lose the price
  const extra = await fetchListings(spreadIds(search.result, limit, spread), search.id, search.result, urgent).catch((e) => (console.warn('spread fetch:', e.message), []));
  return {
    searchId: search.id,
    total: search.total,
    link: `https://www.pathofexile.com/trade/search/${league}/${search.id}`,
    listings,
    spread: extra,
  };
}
