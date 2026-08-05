# AGENTS.md — vc-login

Standalone account checker for Vestiaire Collective via Webshare proxies.
The module dir IS the repo root: all code derives its paths from `import.meta.url`
so it runs identically from any checkout. `bin/webshare` and `.env.example` are
bundled here (on this machine the live `.env` lives one level up in `../.env`
— proxy.js falls back to it automatically).

Never print, commit, or paste the values of `.env` (`WEBSHARE_API_KEY`,
`WEBSHARE_PLAN_ID`). `accounts.json` (email+password list) and
`verify-results.jsonl` are committed on purpose — the repo is private and they
are the resume data. Runtime state (`vc-healthy.json`, `vc-blocked.json`,
`vc-state.json`, `vc-profile.json`, `verify-run.log`, `results/`) is gitignored.

## Main tool: verify-accounts.mjs

- Usage: `node verify-accounts.mjs [--max-mb N] [--limit N] [--account <email>] [--all] [--probe]` and `node verify-accounts.mjs --final` to rebuild the output lists (`myaccount-verified.txt`, `accounts-failed.txt`, `accounts-not-registered.txt`, `accounts-suspended.txt`, `accounts-deleted.txt`, `accounts-locked.txt`, `accounts-unverified.txt`).
- Results append to `verify-results.jsonl` (resume-safe). **Never re-checks the logs**: any account already in the results file (definitive OR transient) is skipped; `--all` or `--account` force an explicit re-check.
- Anti-ban: one persistent browser profile (disk cache) per IP at `/tmp/opencode/vc-profiles/<ip>`; a FRESH desktop-Chromium UA per check via CDP (`freshDesktopUA()` in `ua.js`, pinned to the installed Chromium major so sec-ch-ua hints match); IPs rotate round-robin per check with a randomized start and never the same IP twice in a row. Heavy assets (images/fonts/media/ads) are blocked natively via CDP `Network.setBlockedURLs`, preserving the HTTP cache.
- Cache adapts to the pool: profiles for IPs freed from the plan or permanently flagged (max demerits) are purged; blocked-but-allocated IPs keep their warm cache and are auto-recovered by re-probing. Webshare free plan has 0 on-demand refreshes and no sticky backbone sessions, so "fresh IP per check" = rotation among the healthy proxies (no list replacement possible).
- Pool self-heals: reconcile runs every 10 accounts and re-probes up to 4 blocked IPs (oldest-tried first, min 5 min between probes of the same IP, round-robin cursor); when all sessions are cooling, `waitForSession` re-probes blocked IPs during the cooldown instead of idling — the pool does not collapse to a single IP. Recovered IPs get a session relaunched immediately.
- Bandwidth: measured with a CDP counter (`encodedDataLength`; `performance.transferSize` is unreliable). Guarded by `--max-mb` (default 250) per run; the Webshare stats API lags, so it is informational only. Free plan = 1 GB/month.
- Statuses: `WORKING`/`FAILED`/`NOT_REGISTERED`/`SUSPENDED`/`DELETED`/`LOCKED` = definitive; `WAF`/`BLOCKED`/`RATE_LIMITED`/`ERROR` = transient (retried within the run). Classic messages: "Incorrect email or password." → FAILED; "Access to your account has been suspended." → SUSPENDED; no account / not registered → NOT_REGISTERED.
- Relaunch after a stop: same command (`node verify-accounts.mjs --max-mb 300`); it picks up where it left off. Typical pace ~1 account/min — run under `nohup ... > verify-run.log 2>&1 &`.

## Other scripts

- `proxy.js` — Webshare helpers (load .env, `proxies list --json`, health state persisted to `vc-healthy.json`/`vc-blocked.json`, `onDemandRefreshAvailable()`/`refreshProxyList()` for the currently-unavailable whole-list refresh, `bandwidthUsage()`). Resolves `bin/webshare` and `.env` from the module dir, falling back to `../`.
- `ua.js` + `user-agents.json` — UA pool; `freshDesktopUA()` generates a per-check UA pinned to the installed Chromium major; `seededDesktopUA()`/`seededUA()` give deterministic UAs for sticky profiles.
- `probe-ip.mjs` / `probe-login-ips.mjs` — shared IP probe (email/check step) + probe the whole pool; write `vc-healthy.json` / `vc-blocked.json`.
- `check-proxies.mjs` — marks IPs blocked against the VC home page.
- `login.mjs` / `scrape.mjs` — manual login + polite crawler helpers.
- `build-pool.mjs` — rebuilds `user-agents.json` from `user-agents-gist.json`.

## Skills

Bundled twice so they are usable in every context:

- `skills/` — plain copy for manual use / copying to other machines.
- `.opencode/skills/` — auto-loaded by opencode (`opencode.json` declares
  `skills.paths: [".opencode/skills"]`).

Available:
- `vibe-check` — browser verification layer (navigate/map/click/fill, screenshots, storage-state persist/restore).
- `playwright-skill` — Playwright E2E generator (local + TestMu cloud).
- `systematic-debugging` — root-cause before fix.

Reinstall with `npx skills add <repo> --skill <name> -g -a codex -y --copy`.
