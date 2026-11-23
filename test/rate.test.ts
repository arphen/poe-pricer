import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learn, waitMs } from '../src/poeClient.ts';

const H = (o: Record<string, string>) => new Headers(o);

test('waits until oldest request in window expires, keeping one of headroom', () => {
  const b = { rules: [{ max: 5, period: 10, penalty: 60 }], log: [0, 1000, 2000, 3000], blockedUntil: 0 };
  // 4 in window, allowed = 4 -> must wait for t=0 to expire at 10s
  assert.equal(waitMs(b, 3500), 10000 - 3500 + 50);
  assert.equal(waitMs({ ...b, log: [0, 1000, 2000] }, 3500), 0);
});

test('learns rules and pads log from server state (other clients)', () => {
  const b = { rules: [], log: [] as number[], blockedUntil: 0 };
  learn(b, H({ 'x-rate-limit-ip': '8:10:60,15:60:120', 'x-rate-limit-ip-state': '7:10:0,7:60:0' }), 1000);
  assert.equal(b.rules.length, 2);
  assert.equal(b.log.length, 7);
  assert.ok(waitMs(b, 1000) > 9000);
});

test('restricted state blocks for penalty', () => {
  const b = { rules: [], log: [] as number[], blockedUntil: 0 };
  learn(b, H({ 'x-rate-limit-account': '3:5:60', 'x-rate-limit-account-state': '4:5:60' }), 0);
  assert.equal(b.blockedUntil, 60000);
  assert.ok(waitMs(b, 1000) >= 59000);
});

test('hits the server counts over hours stay out of the short windows', () => {
  const b = { rules: [], log: [] as number[], blockedUntil: 0 };
  const now = 10_000_000;
  learn(b, H({ 'x-rate-limit-ip': '12:4:10,50:300:300,1000:21600:1800', 'x-rate-limit-ip-state': '1:4:0,1:300:0,145:21600:0' }), now);
  assert.equal(b.log.length, 145);
  assert.equal(waitMs(b, now), 0);
  // ...while a five-minute window the server reports as full still blocks
  learn(b, H({ 'x-rate-limit-ip': '12:4:10,50:300:300,1000:21600:1800', 'x-rate-limit-ip-state': '1:4:0,49:300:0,145:21600:0' }), now);
  assert.ok(waitMs(b, now) > 200_000);
});

test('reports hits in the shortest window that were not ours (the user trading in the browser)', () => {
  const b = { rules: [], log: [1000] as number[], blockedUntil: 0 };
  assert.equal(learn(b, H({ 'x-rate-limit-ip': '8:10:60,15:60:120', 'x-rate-limit-ip-state': '1:10:0,1:60:0' }), 1000), 0);
  assert.equal(learn(b, H({ 'x-rate-limit-ip': '8:10:60,15:60:120', 'x-rate-limit-ip-state': '4:10:0,4:60:0' }), 2000), 3);
});

test('urgent requests jump ahead of queued background work', async () => {
  const { poeFetch } = await import('../src/poeClient.ts');
  const order: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    order.push(String(url));
    await new Promise((r) => setTimeout(r, 5));
    return new Response('{}', { headers: { 'x-rate-limit-ip': '100:10:60', 'x-rate-limit-ip-state': `${order.length}:10:0` } });
  }) as typeof fetch;
  try {
    const first = poeFetch('prio-test', 'bg1');
    const rest = [poeFetch('prio-test', 'bg2'), poeFetch('prio-test', 'bg3'), poeFetch('prio-test', 'user', {}, { urgent: true })];
    await Promise.all([first, ...rest]);
    assert.deepEqual(order, ['bg1', 'user', 'bg2', 'bg3']);
  } finally {
    globalThis.fetch = real;
  }
});
