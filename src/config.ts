export const config = {
  poesessid: process.env.POESESSID ?? '',
  account: process.env.ACCOUNT_NAME ?? '',
  league: process.env.LEAGUE ?? 'Standard',
  realm: process.env.REALM ?? 'pc',
  port: Number(process.env.PORT ?? 5173),
  userAgent: process.env.USER_AGENT ?? 'poe-pricer/0.1 (personal use)',
  // re-read dump tabs every N minutes and price new rares in the background (0 = off)
  autoScanMinutes: Number(process.env.AUTO_SCAN_MINUTES ?? 10),
  // model says the optimistic price is below this: don't spend a trade search on it
  trashChaos: Number(process.env.TRASH_CHAOS ?? 3),
  // per scan, search at most this many rule-skipped rares after the rest (0 = all of them)
  explorePerScan: Number(process.env.EXPLORE_PER_SCAN ?? 0),
  // share of model-trash items still searched, to keep checking the model's blind spots
  exploreRate: Number(process.env.EXPLORE_RATE ?? 0.1),
  // idle explorer: one affix probe (1 search + 2 fetches) at most every N seconds while nothing of
  // ours is queued and nobody else is using trade on this account (0 = off)
  probeSeconds: Number(process.env.PROBE_SECONDS ?? 60),
  // ...and only after the trade site has been left alone by others for this many minutes
  probeIdleMinutes: Number(process.env.PROBE_IDLE_MINUTES ?? 10),
};
