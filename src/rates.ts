// Currency -> chaos rates from poe.ninja's exchange overview (ids match the trade API's currency ids).
import { cached } from './cache.ts';
import { config } from './config.ts';

let rates: Promise<Record<string, number>> | null = null;

export function chaosRates(): Promise<Record<string, number>> {
  rates ??= cached(`rates-${config.league}`, 3600 * 1000, async () => {
    const out: Record<string, number> = { chaos: 1 };
    for (const type of ['Currency', 'Fragment']) {
      const url = `https://poe.ninja/poe1/api/economy/exchange/current/overview?league=${encodeURIComponent(config.league)}&type=${type}`;
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      for (const l of (await res.json()).lines ?? []) if (l.primaryValue) out[l.id] = l.primaryValue;
    }
    return out;
  }).catch((e) => {
    rates = null;
    throw e;
  });
  return rates;
}

export function toChaos(amount: number, currency: string, r: Record<string, number>): number | null {
  const rate = r[currency] ?? (currency === 'exa' ? r.exalted : currency === 'div' ? r.divine : undefined);
  return rate === undefined ? null : amount * rate;
}
