import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { config } from './config.ts';
import { analyzeItem, buildQuery } from './query.ts';
import { loadModDb } from './moddb.ts';
import { stashRegex } from './regex.ts';
import { autoScan, getPrices, modelCalls, scanStatus, startScan, stopScan } from './scanner.ts';
import { stashTab, stashTabs } from './stash.ts';
import { datasetStats, recordSearch } from './dataset.ts';
import { estimate, modelInfo, retrain } from './model.ts';
import { chaosRates } from './rates.ts';
import { priceable } from './valuation.ts';
import { overview } from './overview.ts';
import { sellList, type Step } from './sell.ts';
import { exploreStatus, setExplorer, startExplorer } from './explore.ts';

// RePoE data is optional: without it we lose affix/tier/craft info but still score.
const modDb = () => loadModDb().catch((e) => (console.warn('mod db unavailable:', e.message), null));
import { getStats, priceCheck, tradeData, type TradeDataKind } from './trade.ts';
import { runSearch, searchBudget, searchPage } from './search.ts';

const publicDir = join(import.meta.dirname, '..', 'public');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
  if (path === '/api/config') {
    const rates = await chaosRates().catch(() => ({}) as Record<string, number>);
    return json(res, 200, { account: config.account, league: config.league, divine: rates.divine ?? null, trashChaos: config.trashChaos });
  }
  if (path === '/api/stash/tabs') return json(res, 200, await stashTabs());
  const data = path.match(/^\/api\/trade\/data\/(stats|items|filters|static)$/);
  if (data) {
    const body = await tradeData(data[1] as TradeDataKind);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' });
    return res.end(JSON.stringify(body));
  }
  if (path === '/api/search' && req.method === 'POST') {
    const { query: q, sort, fresh } = await readBody(req);
    return json(res, 200, await runSearch({ query: q, sort }, !!fresh));
  }
  if (path === '/api/search/page' && req.method === 'POST') {
    const { handle, from } = await readBody(req);
    return json(res, 200, await searchPage(String(handle), Number(from) || 0));
  }
  if (path === '/api/search/budget') return json(res, 200, searchBudget());
  const tab = path.match(/^\/api\/stash\/tab\/(\d+)$/);
  if (tab) {
    const items = await stashTab(Number(tab[1]), query.get('fresh') === '1');
    // Local scoring only (no trade calls). If the stat list is unavailable, show items unscored.
    try {
      const [stats, db] = await Promise.all([getStats(), modDb()]);
      for (const it of items) {
        const a = analyzeItem(it, stats, db);
        const v = a.useCraft ? a.craftedVerdict : a.verdict;
        // the lines that carry the item, for the list view
        const lines = a.mods
          .filter((m) => m.weight >= 2 && !m.covered)
          .sort((x, y) => y.weight - x.weight)
          .slice(0, 4)
          .map((m) => m.text.replace(/\[([^\]|]*)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]*)\]/g, '$1'));
        it._v = { verdict: v, score: a.useCraft ? a.craftedScore : a.score, slot: a.slot, craft: a.useCraft ? a.craft : null, priced: priceable(it) && a.kind === 'base' && a.slot !== 'other', lines };
      }
      const prices = await getPrices();
      for (const it of items) if (prices[it.id]) it._p = prices[it.id];
    } catch (e) {
      console.warn('scoring skipped:', e instanceof Error ? e.message : e);
    }
    return json(res, 200, items);
  }
  if (path === '/api/analyze' && req.method === 'POST') {
    const { item } = await readBody(req);
    const a = analyzeItem(item, await getStats(), await modDb());
    return json(res, 200, { ...a, model: await estimate(item, a).catch(() => null) });
  }
  if (path === '/api/scan' && req.method === 'POST') {
    const { tabs } = await readBody(req);
    return json(res, 200, await startScan(tabs));
  }
  if (path === '/api/scan/stop' && req.method === 'POST') {
    stopScan();
    return json(res, 200, scanStatus());
  }
  if (path === '/api/scan/status') return json(res, 200, scanStatus());
  if (path === '/api/prices') return json(res, 200, await getPrices());
  if (path === '/api/model') return json(res, 200, { data: await datasetStats(), model: await modelInfo(), calls: modelCalls() });
  if (path === '/api/overview') return json(res, 200, await overview());
  if (path === '/api/model/train' && req.method === 'POST') {
    await retrain(true);
    return json(res, 200, { data: await datasetStats(), model: await modelInfo() });
  }
  if (path === '/api/explore') {
    if (req.method === 'POST') return json(res, 200, await setExplorer(!!(await readBody(req)).on));
    return json(res, 200, await exploreStatus());
  }
  if (path === '/api/sell') {
    const min = Number(query.get('min') ?? 20);
    return json(res, 200, await sellList(Number.isFinite(min) && min > 0 ? min : 20, (query.get('step') ?? 'normal') as Step, query.get('fresh') === '1'));
  }
  if (path === '/api/regex' && req.method === 'POST') {
    const { items, targets } = await readBody(req);
    return json(res, 200, stashRegex(items, targets));
  }
  if (path === '/api/price' && req.method === 'POST') {
    const { item, selection } = await readBody(req);
    const analysis = analyzeItem(item, await getStats(), await modDb());
    const body = buildQuery(item, analysis, selection);
    const r = await priceCheck(body, 10, 10, true);
    // manual checks are training data too
    const rates = await chaosRates().catch(() => ({ chaos: 1 }) as Record<string, number>);
    await recordSearch(item, body, r, rates, { chaos: null, relaxed: false }).catch((e) => console.warn('dataset:', e.message));
    return json(res, 200, { ...r, listings: r.listings.map(({ item: _, ...l }) => l), request: body });
  }
  json(res, 404, { error: 'not found' });
}

async function serveStatic(res: ServerResponse, path: string) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(join(publicDir, rel));
    res.writeHead(200, { 'Content-Type': types[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  try {
    if (path.startsWith('/api/')) await api(req, res, path, url.searchParams);
    else await serveStatic(res, path);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    if (status >= 500) console.error(e);
    json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
}).listen(config.port, '127.0.0.1', () => {
  console.log(`poe-pricer on http://127.0.0.1:${config.port}  (${config.account || 'ACCOUNT_NAME unset'} / ${config.league})`);
  retrain().catch((e) => console.warn('model:', e.message));
  if (config.autoScanMinutes > 0 && config.poesessid) autoScan(config.autoScanMinutes * 60 * 1000);
  startExplorer();
});
