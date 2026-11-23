import { cached } from './cache.ts';
import { config } from './config.ts';
import { poeFetch } from './poeClient.ts';

const TTL = 10 * 60 * 1000;

let accountName: Promise<string> | null = null;

// Accounts need the "#1234" discriminator; read it from the profile link if .env omits it.
function resolveAccount(): Promise<string> {
  accountName ??= (async () => {
    if (config.account.includes('#')) return config.account;
    const res = await poeFetch('stash', 'https://www.pathofexile.com/my-account', {}, { cookie: true });
    const m = (await res.text()).match(/view-profile\/([^/"'?]+)-(\d+)/);
    return m ? `${decodeURIComponent(m[1])}#${m[2]}` : config.account;
  })();
  return accountName;
}

async function getStash(tabIndex: number, withTabs: boolean) {
  const q = new URLSearchParams({
    accountName: await resolveAccount(),
    realm: config.realm,
    league: config.league,
    tabs: withTabs ? '1' : '0',
    tabIndex: String(tabIndex),
  });
  const res = await poeFetch('stash', `https://www.pathofexile.com/character-window/get-stash-items?${q}`, {}, { cookie: true });
  if (res.status === 403 || res.status === 401) {
    throw new Error('POESESSID rejected (expired or wrong ACCOUNT_NAME / private profile). Update .env.');
  }
  if (!res.ok) throw new Error(`stash request failed: ${res.status}`);
  return res.json();
}

export async function stashTabs(): Promise<{ n: string; i: number; type: string }[]> {
  const data = await cached(`tabs-${config.league}`, TTL, () => getStash(0, true));
  return data.tabs.map((t: any) => ({ n: t.n, i: t.i, type: t.type }));
}

export async function stashTab(index: number, fresh = false, ttl = TTL): Promise<any[]> {
  const data = await cached(`tab-${config.league}-${index}`, ttl, () => getStash(index, false), fresh);
  return data.items ?? [];
}
