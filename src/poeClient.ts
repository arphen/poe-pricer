import { config } from './config.ts';

// Client-side limiter that lets us use the full GGG budget without tripping it.
// Each bucket (stash, search, fetch, data) is a serial queue with a sliding-window log of our own
// request times. Rules ("max:period:penalty") are learned from X-Rate-Limit-{Ip,Account} headers and
// the server's "-State" ("hits:period:restricted") is merged in, so hits from the browser trade site
// on the same IP/account are respected too. Urgent requests (the user waiting on the search page)
// jump ahead of queued background work.
type Rule = { max: number; period: number; penalty: number };
type Job = { url: string; init: RequestInit; urgent: boolean; attempt: number; resolve: (r: Response) => void; reject: (e: unknown) => void };
type Bucket = { rules: Rule[]; log: number[]; blockedUntil: number; queue: Job[]; draining: boolean };

const SAFETY = 1; // keep one request of headroom per window
const buckets = new Map<string, Bucket>();

function bucketOf(name: string): Bucket {
  let b = buckets.get(name);
  if (!b) buckets.set(name, (b = { rules: [], log: [], blockedUntil: 0, queue: [], draining: false }));
  return b;
}

function parse(v: string | null): Rule[] {
  if (!v) return [];
  return v.split(',').map((r) => {
    const [max, period, penalty] = r.split(':').map(Number);
    return { max, period, penalty };
  });
}

// Time to wait before one more request fits under every rule.
export function waitMs(b: Pick<Bucket, 'rules' | 'log' | 'blockedUntil'>, now: number): number {
  let wait = Math.max(0, b.blockedUntil - now);
  for (const r of b.rules) {
    const inWindow = b.log.filter((t) => t > now - r.period * 1000);
    const allowed = Math.max(1, r.max - SAFETY);
    if (inWindow.length >= allowed) {
      // the request that must expire for us to fit
      const oldest = inWindow[inWindow.length - allowed];
      wait = Math.max(wait, oldest + r.period * 1000 - now + 50);
    }
  }
  return wait;
}

// Returns how many hits the server counted in its shortest window beyond ours: someone else (the
// user on the trade site) is using the same budget right now.
export function learn(b: Pick<Bucket, 'rules' | 'log' | 'blockedUntil'>, h: Headers, now: number): number {
  const rules: Rule[] = [];
  const states: { r: Rule; s: Rule }[] = [];
  for (const scope of ['ip', 'account']) {
    const rs = parse(h.get(`x-rate-limit-${scope}`));
    const st = parse(h.get(`x-rate-limit-${scope}-state`));
    rs.forEach((r, i) => {
      rules.push(r);
      const s = st[i];
      if (!s) return;
      if (s.penalty > 0) b.blockedUntil = Math.max(b.blockedUntil, now + s.penalty * 1000);
      states.push({ r, s });
    });
  }
  // server saw more hits than we sent (other clients): pad our log so the window stays honest. The
  // padding sits just outside every shorter window, shortest rule first: hits the server counts over
  // six hours may all be old, and stamping them "now" would fill the five-minute window too.
  states.sort((x, y) => x.r.period - y.r.period);
  let foreign = 0;
  if (states.length) {
    const { r, s } = states[0];
    foreign = Math.max(0, s.max - b.log.filter((t) => t > now - r.period * 1000).length);
  }
  for (const { r, s } of states) {
    const shorter = Math.max(0, ...rules.filter((o) => o.period < r.period).map((o) => o.period));
    const at = shorter ? now - shorter * 1000 - 1 : now;
    const ours = b.log.filter((t) => t > now - r.period * 1000).length;
    for (let k = ours; k < s.max; k++) b.log.push(at);
  }
  if (rules.length) b.rules = rules;
  const longest = Math.max(60, ...b.rules.map((r) => r.period)) * 1000;
  b.log = b.log.filter((t) => t > now - longest).sort((x, y) => x - y);
  return foreign;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// bucket -> when its current rate-limit sleep ends
const sleeping = new Map<string, number>();
// bucket -> when the user last traded: the server counted requests that weren't ours (the browser),
// or the user searched through our own search page
const userAt = new Map<string, number>();
export const lastUserTrade = (bucket: string) => userAt.get(bucket) ?? 0;

// One request at a time per bucket. The wait is per bucket, not per request, and the next request is
// picked only once the window has room, so an urgent one arriving during a sleep still goes first.
async function drain(name: string) {
  const b = bucketOf(name);
  if (b.draining) return;
  b.draining = true;
  try {
    while (b.queue.length) {
      const now = Date.now();
      // before rules are known, space requests out
      const wait = b.rules.length ? waitMs(b, now) : Math.max(0, (b.log.at(-1) ?? 0) + 1500 - now);
      if (wait > 0) {
        if (wait > 2000) console.log(`[rate] ${name}: waiting ${(wait / 1000).toFixed(1)}s`);
        sleeping.set(name, now + wait);
        await sleep(wait).finally(() => sleeping.delete(name));
        continue;
      }
      const urgent = b.queue.findIndex((j) => j.urgent);
      const [job] = b.queue.splice(Math.max(0, urgent), 1);
      b.log.push(Date.now());
      let res: Response;
      try {
        res = await fetch(job.url, job.init);
      } catch (e) {
        job.reject(e);
        continue;
      }
      // 2+: one stray hit can be a request of ours racing the count
      if (learn(b, res.headers, Date.now()) >= 2) userAt.set(name, Date.now());
      if (res.status === 429 && job.attempt < 3) {
        const retry = Number(res.headers.get('retry-after') ?? 60);
        console.log(`[rate] ${name}: 429, retry in ${retry}s`);
        b.blockedUntil = Math.max(b.blockedUntil, Date.now() + retry * 1000 + 500);
        await res.body?.cancel().catch(() => undefined);
        job.attempt++;
        b.queue.unshift(job);
        continue;
      }
      job.resolve(res);
    }
  } finally {
    b.draining = false;
  }
}

// urgent: the user is waiting on it (search page, manual price check): goes before background work,
// and counts as the user trading, so the idle explorer backs off.
export function poeFetch(bucket: string, url: string, init: RequestInit = {}, opts: { cookie?: boolean; urgent?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': config.userAgent,
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (opts.cookie) headers.Cookie = `POESESSID=${config.poesessid}`;
  if (opts.urgent) userAt.set(bucket, Date.now());
  const b = bucketOf(bucket);
  return new Promise<Response>((resolve, reject) => {
    b.queue.push({ url, init: { ...init, headers }, urgent: !!opts.urgent, attempt: 0, resolve, reject });
    void drain(bucket);
  });
}

// For UI/progress: the longest rate-limit sleep in progress, if any.
export function rateWait(): { bucket: string; until: number } | null {
  let best: { bucket: string; until: number } | null = null;
  for (const [bucket, until] of sleeping) if (!best || until > best.until) best = { bucket, until };
  return best;
}

// For the search page: what's left in each window of a bucket (headroom already taken off).
export function budget(name: string) {
  const b = buckets.get(name);
  const now = Date.now();
  if (!b) return { rules: [], queued: 0, waitMs: 0 };
  return {
    rules: b.rules.map((r) => {
      const used = b.log.filter((t) => t > now - r.period * 1000).length;
      return { period: r.period, max: Math.max(1, r.max - SAFETY), left: Math.max(0, Math.max(1, r.max - SAFETY) - used) };
    }),
    queued: b.queue.length,
    waitMs: Math.max(0, (sleeping.get(name) ?? 0) - now, b.blockedUntil - now),
  };
}
