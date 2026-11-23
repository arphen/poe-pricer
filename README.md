# poe-pricer

A local stash pricer for **Path of Exile 1**. It reads your stash through the official site using your own session cookie, prices rare items against the official trade site, learns from every listing it sees, and turns the result into sell lists and in-game stash searches.

Everything runs on your machine. There are **no npm dependencies** and no telemetry. The only network calls are the ones needed to talk to `pathofexile.com`, `poe.ninja`, and the RePoE data mirror.

> This is an unofficial personal-use tool. It is not affiliated with or endorsed by Grinding Gear Games. Read [Safety and fair use](#safety-and-fair-use) before running it.

## What it does

- **Stash pricing** — browse your dump tabs, score every rare locally (affix tiers, open affixes, bench crafts, DPS/defences), then price suspicious items with real trade searches.
- **Rate-limit aware** — every GGG request goes through one client-side limiter that learns the `X-Rate-Limit-*` headers, respects your browser's usage on the same account/IP, prioritizes manual searches, and backs off on `429`.
- **Tier ladder** — starts with the whole item and drops the least important line one step at a time until enough comparables exist. Thin markets are marked low-confidence instead of being overpriced.
- **Learned price model** — gradient-boosted trees over item features, trained on the listings your own searches collect. Once a slot has enough data, the model can skip searches for items it is confident are vendor trash.
- **Sell page** — groups priced items into round price levels, prints the `~price` note, and generates stash search strings that highlight exactly the items for each group.
- **Trade search page** — a local trade-site query builder with the same item/stat data, paging, and a live rate-limit budget display. Manual searches also become training data.
- **Overview page** — dataset size, model accuracy per slot, learned affix values, and the priced-stash summary.
- **Loot filter CLI** — list, pull, and push your own online item filters (with a safety check against overwriting edits made on the website).

## Requirements

- **Node.js 24 or newer** (the project runs TypeScript directly with Node's built-in type stripping).
- A Path of Exile account on PC and a character with stash tabs in the league you want to price.
- Your `POESESSID` session cookie. See [Get your POESESSID safely](#get-your-poesessid-safely).

There is nothing to `npm install`.

## Install with your agent

Paste this prompt into your coding agent (Claude Code, OpenCode, Cursor, Codex, etc.):

```text
Set up poe-pricer for me from https://github.com/arphen/poe-pricer.

1. Clone it to ~/projects/poe-pricer and read AGENTS.md before doing anything.
2. Never read, print, copy, or commit .env. Create it from .env.example with mode 600,
   then tell me exactly which lines to fill in myself. Do not ask me for my POESESSID in chat.
3. Leave AUTO_SCAN_MINUTES=0 and PROBE_SECONDS=0 until I have reviewed the first scan.
4. Run `npm test` and `npm run check:secrets` and show me the results.
5. Start the server with `npm start`, verify http://127.0.0.1:5173 responds, and tell me the URL.
   Do not bind it to anything other than 127.0.0.1.
```

The agent should stop and hand `.env` back to you. **Never paste your session cookie into a chat, an issue, a PR, or a shell command that ends up in your history.** Edit `.env` in your own editor.

## Manual install

```bash
git clone https://github.com/arphen/poe-pricer.git
cd poe-pricer
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
POESESSID=your-session-cookie
ACCOUNT_NAME=YourName#1234
LEAGUE=Standard
REALM=pc
PORT=5173
```

Then:

```bash
npm start
```

Open <http://127.0.0.1:5173>. The server logs the account and league it resolved. If `ACCOUNT_NAME` omits the `#1234` discriminator, the app reads it from your profile page.

### Get your POESESSID safely

1. Log in at <https://www.pathofexile.com> in your browser.
2. Open devtools → **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → `https://www.pathofexile.com`.
3. Copy the value of `POESESSID` into `.env`.
4. Keep `.env` private. The cookie is a bearer credential: anyone who has it can act as your account on the website.
5. Logging out of pathofexile.com invalidates the cookie. If it leaks, log out, change your password, and enable two-factor authentication.

## First run

1. Set `LEAGUE` to the exact league name shown on the trade site.
2. Leave `AUTO_SCAN_MINUTES=0` and `PROBE_SECONDS=0` for the first session.
3. Start the server and open the stash page.
4. Pick one dump tab and press **Price this tab**. Watch the progress and the rate-limit waits.
5. Review a few items by clicking them. Each item shows why it was priced the way it was.
6. Once you are happy with the results, re-enable background scanning and the idle explorer if you want them (see [Configuration](#configuration)).

## Usage

### Stash (`/`)

- The tab selector lists tabs; **Normal**, **Premium**, and **Quad** stash tabs are treated as dump tabs.
- **Price this tab** searches trade for every rare/magic item in the current tab.
- **Price all dump tabs** queues all dump tabs.
- **Stop** cancels the queue.
- Click an item to see its mods, tiers, open affixes, bench options, the query that was used, the listings found, and the model's estimate.
- **Stash search** generates strings that highlight the items worth selling; paste them into the in-game stash search.

Prices are cached per item and per league. Re-pricing happens when the item, the rules, or the model's query change, or after the freshness window.

### Sell (`/sell.html`)

Groups trade-priced items by round price level (chaos below the divine rate, divines above it). Each group has:

- a `~price N currency` note to put on the items,
- stash search strings that light up exactly that group,
- the tabs the group's items live in.

In game: paste a group's search string, move the highlighted items to a sale tab at that price, then do the next group. Items whose price is uncertain in the direction of underselling are kept in a **by hand** list instead of being auto-grouped.

The price ladder can be switched between `fine`, `normal`, and `coarse` in the page header.

### Search (`/search.html`)

A local trade-site query builder:

- item category, rarity, level, sockets, links, influences, and stat filters,
- autocomplete backed by the trade site's own stat/item lists,
- price sorting, paging, and a `paste a trade link` box,
- a live budget display for the search and fetch buckets.

Searches from this page are treated as urgent by the limiter, so they jump ahead of background scanning. Price-sorted searches are also recorded as training data.

### Overview (`/overview.html`)

Shows what the tool has learned: listing/query counts, data file size, rarity and price buckets, model error per slot, the model's guess versus the trade price on your own held-out items, and the strongest learned affix values. **Retrain now** rebuilds the model immediately.

The model needs at least **150 listings** before it is used, **80 listings of a slot** before it may skip searches there, and **40 of those** above the market floor to be considered informative. It retrains automatically after roughly **50 new listings**.

### Loot filters (CLI)

```bash
npm run filter -- list
npm run filter -- pull <filter-id>
npm run filter -- push <filter-id>
npm run filter -- push <filter-id> --force
```

`list` shows your owned and followed filters. `pull` writes `filters/<id>.filter` plus a metadata file. `push` refuses to overwrite changes made on the website since your last pull unless you pass `--force`, and verifies the result by reading it back. Only filters you own can be pushed. Downloaded filters are gitignored.

## Configuration

All settings are environment variables, normally in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `POESESSID` | empty | Session cookie. Required for stash and filter operations. |
| `ACCOUNT_NAME` | empty | Account name, optionally `Name#1234`. Resolved from your profile if omitted. |
| `LEAGUE` | `Standard` | League to read and search. Must match the trade site exactly. |
| `REALM` | `pc` | `pc`, `xbox`, or `sony`. |
| `PORT` | `5173` | Local port. The server always binds to `127.0.0.1`. |
| `USER_AGENT` | `poe-pricer/0.1 (personal use)` | Sent to GGG and poe.ninja. A descriptive value with contact info is polite. |
| `AUTO_SCAN_MINUTES` | `10` | Re-read dump tabs and price new items every N minutes. `0` disables. |
| `TRASH_CHAOS` | `3` | The model must put an item's optimistic price below this to skip its trade search. |
| `EXPLORE_PER_SCAN` | `0` | Maximum rule-skipped rares searched per scan. `0` means all of them. |
| `EXPLORE_RATE` | `0.1` | Share of model-trash items still searched, to check the model's blind spots. |
| `PROBE_SECONDS` | `60` | Idle explorer: at most one affix probe every N seconds. `0` disables. |
| `PROBE_IDLE_MINUTES` | `10` | Only probe after the trade site has been quiet on this account for N minutes. |

`AUTO_SCAN_MINUTES` and `PROBE_SECONDS` are the two settings that generate background traffic. Set both to `0` if you only want manual pricing.

## Your data

Everything is local and gitignored:

| Path | Contents |
| --- | --- |
| `.env` | Your session cookie and account configuration. **Never share or commit.** |
| `data/obs-<league>.jsonl` | Every listing seen, with full item JSON: the long-term training set. |
| `data/model-<league>.json` | The trained price model. |
| `data/probes-<league>.json` | Idle-explorer probe results and learned affix weights. |
| `.cache/` | Disposable caches: tabs, trade static data, RePoE data, prices, currency rates. |
| `filters/` | Loot filters you pulled or pushed. Third-party filters are not redistributed. |

Deleting `.cache/` is safe; it only costs re-fetching. Deleting `data/` throws away the model's training history. Deleting `.env` just means setting up credentials again.

The session cookie is only attached to requests to `www.pathofexile.com`. Price data from poe.ninja and RePoE never receives it.

## Safety and fair use

- **The cookie is the account.** Treat `POESESSID` like a password. Do not paste it into chats, issues, screenshots, or bug reports. Do not commit it. The repository's secret scan exists to catch accidents, not to make sharing safe.
- **Local only.** The HTTP server has no authentication and binds to `127.0.0.1`. Do not port-forward it, reverse-proxy it, run it on a public host, or use a tunnel to expose it. Anyone who can reach it can read your stash and spend your trade-site budget.
- **Respect GGG's rate limits.** The client-side limiter is intentionally conservative, uses the headers the server returns, and treats your browser's own usage as shared budget. Do not run multiple copies against the same account, remove the backoff, or hammer `429`s. The official trade site and stash endpoints are for personal use; this tool does not automate gameplay, whispers, or trades.
- **Third parties.** Currency data comes from poe.ninja and mod data from the RePoE mirror. Their terms and availability are their own. No affiliation with Grinding Gear Games; Path of Exile is a trademark of Grinding Gear Games.
- **No warranty.** Prices are estimates from public listings. Thin markets, price fixing, and stale listings exist. You are responsible for what you list and sell.

See [SECURITY.md](SECURITY.md) for the credential model and how to report a problem.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `POESESSID rejected` | The cookie expired or the account/profile is private. Re-copy it from a logged-in browser, check `ACCOUNT_NAME`, and make sure your profile is public. |
| `POESESSID missing in .env` | Fill the line in `.env`; do not add quotes. |
| `blocked by Cloudflare` on filter commands | The site is challenging automated page loads. Wait, use the browser normally, and retry later. Do not loop. |
| Frequent rate-limit waits / `429` | Expected on large scans. Let the limiter work, lower `AUTO_SCAN_MINUTES`/`PROBE_SECONDS`, or scan fewer tabs. Do not run a second instance. |
| Model not being used | It needs at least 150 listings, 80 per slot, and 40 informative per slot. Check the overview page's thresholds. |
| `mod db unavailable` warning | RePoE could not be fetched. Scoring still works without tiers/crafts. Delete `.cache/repoe` to retry. |
| `EADDRINUSE` | Another process uses the port. Set `PORT=5175` (or any free port). |
| Node syntax/type error on start | You are on Node < 24. Upgrade Node. |
| Empty/stale stash | Check `LEAGUE`, `REALM`, and that the tabs are dump types. Use the reload button to bypass the cache. |

## Development

```bash
npm test              # unit tests, no network
npm run check:secrets # scan publishable files for leaked credentials
```

TypeScript is run directly by Node; there is no build step and no runtime dependency. The UI is plain HTML/CSS/ES modules served by `src/server.ts`.

| Path | Purpose |
| --- | --- |
| `src/server.ts` | HTTP server, API routes, static files. |
| `src/poeClient.ts` | Rate-limit learner and request queues. |
| `src/stash.ts`, `src/trade.ts` | GGG stash and trade endpoints. |
| `src/query.ts`, `src/valuation.ts`, `src/moddb.ts` | Item analysis, trade query building, affix tiers. |
| `src/scanner.ts` | Background pricing queue and tier ladder. |
| `src/model.ts`, `src/gbdt.ts`, `src/features.ts`, `src/dataset.ts` | Training data, model, features, persistence. |
| `src/explore.ts` | Idle affix probes and learned weights. |
| `src/sell.ts`, `src/regex.ts` | Sell groups and stash search strings. |
| `src/lootfilter.ts` | Online filter pull/push CLI. |
| `public/` | Browser UI. |
| `test/` | Unit tests. |

## Publishing this repository safely

Before pushing:

```bash
npm test
npm run check:secrets
git status --ignored --short
git add -A
git diff --cached --stat
```

Confirm that `.env`, `data/`, `filters/`, `.cache/`, and `.claude/settings.local.json` are ignored and not staged. Never use `git add -f` on an ignored path. If a secret reaches a commit, rotate it first; assume it is compromised and rewrite history before publishing.

## License

MIT. See [LICENSE](LICENSE). Your stash data, downloaded filters, and third-party data are not covered by that license.
