# AGENTS.md

Instructions for coding agents setting up, running, or changing **poe-pricer**.

This is a local-only Path of Exile pricing tool. It uses the user's `POESESSID`
session cookie, which grants full website access to their account. Treat that
cookie as a password.

## Non-negotiables

1. **Never read, print, copy, summarize, or commit `.env`.** Do not `cat`, `grep`,
   `git diff`, or otherwise display its contents. You may check that it exists and
   has a non-empty `POESESSID` line without printing the value:
   `test -s .env && grep -q '^POESESSID=.\+' .env && echo "cookie configured"`.
2. **Never ask the user to paste the cookie into chat.** Do not put it in a command
   line (shell history and process lists leak). Tell the user to edit `.env`
   themselves in their editor.
3. **Never commit or force-add** `.env`, `data/`, `filters/`, `.cache/`, or
   `.claude/settings.local.json`. Never weaken `.gitignore`.
4. **Keep the server on `127.0.0.1`.** Never bind `0.0.0.0`, never add a tunnel,
   reverse proxy, or public host, and never remove the loopback restriction.
5. **Do not change the rate limiter or run multiple instances** against the same
   account. Do not bypass, parallelize, or retry `429`s outside `src/poeClient.ts`.
6. **Do not add analytics, telemetry, or new outbound hosts** without explicit
   approval. The expected hosts are `pathofexile.com`, `poe.ninja`, and the RePoE
   mirror.
7. **Do not automate gameplay**: no whispers, trades, movement, or client input.
   This tool only reads public/session data and shows results.

## Setup

1. Verify Node.js 24 or newer: `node --version`.
2. Clone to a user-owned directory if the repo is not already present.
3. Create local config without handling the secret:
   ```bash
   cp .env.example .env
   chmod 600 .env
   ```
4. Tell the user to fill these lines in `.env` themselves, then stop:
   - `POESESSID=` (from browser devtools cookies for `pathofexile.com`)
   - `ACCOUNT_NAME=` (`Name#1234`)
   - `LEAGUE=` (exact trade-site league name)
5. For a first session, set `AUTO_SCAN_MINUTES=0` and `PROBE_SECONDS=0` unless the
   user explicitly wants background traffic.

There are no dependencies to install.

## Verify

```bash
npm test
npm run check:secrets
```

`npm test` runs the unit tests (no network). `npm run check:secrets` scans files
that would be published and fails without printing the secret values.

Start the server only when the user asks:

```bash
npm start
```

Then verify without exposing account details:

```bash
node -e "fetch('http://127.0.0.1:5173/api/config').then(r=>r.json()).then(j=>console.log('league:', j.league, 'account set:', Boolean(j.account))).catch(e=>{console.error(e.message);process.exit(1)})"
```

Do not expose port 5173 beyond loopback.

## Explaining usage to the user

- `/` — stash tab browser; **Price this tab** / **Price all dump tabs**.
- `/sell.html` — price groups plus stash search strings.
- `/search.html` — trade query builder with a rate-limit budget display.
- `/overview.html` — dataset/model status and retraining.
- Filter CLI — `npm run filter -- list|pull <id>|push <id> [--force]`.
- All background behavior is controlled by `.env`; see the README configuration table.

## Making changes

- Keep the zero-dependency, no-build setup: Node runs the TypeScript directly.
- Match the surrounding style (plain functions, comments explaining *why*).
- Add or update tests in `test/` for behavior changes.
- Run `npm test` and `npm run check:secrets` before proposing a commit.
- Check `git status --ignored --short` before staging. Never use `git add -f` on an
  ignored path.
- If a secret is ever committed, stop, tell the user to rotate it, and treat it as
  compromised. Do not try to hide it with a new commit alone.

## Git identity for this repository

The user's personal account is `arphen`. If this clone uses SSH, prefer the
`github-personal` host alias (personal key) over the default work identity:

```bash
git remote set-url origin git@github-personal:arphen/poe-pricer.git
git config user.name "Sebastian Wozny"
git config user.email "arpheno@gmail.com"
```

Use repo-local config; do not change the user's global git identity.
