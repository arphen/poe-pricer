# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:
<https://github.com/arphen/poe-pricer/security/advisories/new>

Do **not** open a public issue containing a session cookie, account name, stash
export, or any other personal data. If you are unsure whether something is
sensitive, report it privately first.

## Credential model

The tool authenticates to `www.pathofexile.com` with the user's `POESESSID`
session cookie from `.env`. That cookie is a bearer credential with the same
power as a logged-in browser session. It must never be published, shared, or
pasted into an issue.

- `.env` is gitignored and is never read by the server's HTTP API.
- The cookie is attached only to requests to `www.pathofexile.com` (stash and
  item-filter pages). It is not sent to poe.ninja, RePoE, or any other host.
- The local HTTP server has no authentication. It binds to `127.0.0.1` and must
  not be exposed through a proxy, tunnel, container port publish, or public host.
- `data/`, `filters/`, and `.cache/` are gitignored because they contain the
  user's stash and market history, not because they contain credentials.

## If a credential leaks

1. Log out of `pathofexile.com` to invalidate the session cookie.
2. Change the account password and enable two-factor authentication.
3. If the value reached a git commit, rotate it first, then remove it from history
   with `git filter-repo` (or the GitHub support flow) and force-push. Treat any
   value that was public, even briefly, as compromised.
4. If it reached a GitHub issue, PR, or gist, delete or edit it, but still rotate.

## Supported versions

Only the latest commit on `main` is supported. This is a personal-use tool with
no hosted service and no warranty.
