#!/usr/bin/env node
// Scans every file that would be published (tracked + untracked, minus gitignored)
// for credentials. Reads .env only to compare its values against those files; it
// never prints a value, only the file and the kind of match.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const MAX_BYTES = 2 * 1024 * 1024;
const SELF = 'scripts/check-secrets.mjs';
const ENV_FILE = '.env';
// Generic/non-secret settings that may legitimately appear in documentation.
const NOT_SECRET = new Set(['LEAGUE', 'REALM', 'PORT', 'USER_AGENT', 'AUTO_SCAN_MINUTES', 'TRASH_CHAOS', 'EXPLORE_PER_SCAN', 'EXPLORE_RATE', 'PROBE_SECONDS', 'PROBE_IDLE_MINUTES']);

const patterns = [
  ['Path of Exile session cookie', /POESESSID\s*[=:]\s*["']?([A-Fa-f0-9]{16,})["']?/g],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['assigned secret', /\b(?:api[_-]?key|secret|token|password|passwd|session[_-]?id)\b\s*[=:]\s*["'][^"'\s]{12,}["']/gi],
];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && f !== ENV_FILE);

const contents = new Map();
for (const name of files) {
  if (name === SELF) continue;
  let buf;
  try {
    if (statSync(name).size > MAX_BYTES) continue;
    buf = readFileSync(name);
  } catch {
    continue; // deleted but still in the index, broken symlink, ...
  }
  if (buf.includes(0)) continue; // binary
  contents.set(name, buf.toString('utf8'));
}

const findings = [];
const note = (name, label) => findings.push({ name, label });

for (const [name, text] of contents) {
  for (const [label, re] of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const hit = m[1] ?? m[0];
      if (/^(?:your|example|placeholder|changeme|redacted|replace|todo|\$\{|<)/i.test(hit)) continue;
      if (/^0+$/.test(hit)) continue;
      note(name, label);
    }
  }
}

// Exact value comparison: catches B4ckl0g-style account names that are personal
// but do not look like a token, and any secret format we did not anticipate.
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (NOT_SECRET.has(key)) continue;
    const value = raw.replace(/^["']|["']$/g, '').trim();
    if (value.length < 4) continue;
    for (const [name, text] of contents) {
      if (text.includes(value)) note(name, `value of ${key}`);
    }
  }
}

const unique = [...new Map(findings.map((f) => [`${f.name}\0${f.label}`, f])).values()];
if (unique.length) {
  console.error('Secret scan failed. No values are printed.');
  for (const f of unique) console.error(`  ${f.name}: ${f.label}`);
  console.error('Remove the secret, rotate it, and never force-add ignored paths.');
  process.exit(1);
}

console.log(`Secret scan passed (${contents.size} publishable files checked, values not printed).`);
