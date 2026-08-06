# vc-login — Vestiaire Collective account checker

Node module (`playwright-core` + system `/usr/bin/chromium`) that verifies VC
accounts through Webshare proxies and rebuilds per-status lists. Self-contained:
the module dir is the repo root (all paths derive from it), the Webshare CLI
binary is bundled in `bin/`, and agent skills are bundled in `skills/`.

## Requirements (fresh machine)

- Linux with `/usr/bin/chromium` (a real Chromium engine; VC uses a Cloudflare
  managed challenge — plain `curl`/`requests` always get 403).
- Node.js 18+ (tested on 22).
- A Webshare account (free plan = 1 GB/month, 10 IPs) with `WEBSHARE_API_KEY`.
- npm dependencies: `playwright-core`, `random-useragent`.

## Setup

```bash
git clone <private-repo-url> && cd vc-login
npm ci
cp .env.example .env        # fill in WEBSHARE_API_KEY (+ WEBSHARE_PLAN_ID)
# make sure bin/webshare is executable (it is committed with +x)
```

Optional overrides (env): `VC_DIR`, `VALID_FILE`, `VC_PROFILE_ROOT` (default
`/tmp/opencode/vc-profiles`). `valid.txt` defaults to `../results/valid.txt`
when that dir exists next to the checkout (this machine), else a repo-local
`results/valid.txt`.

## Usage

```bash
# main checker — never re-checks accounts already in verify-results.jsonl
nohup node verify-accounts.mjs --max-mb 300 > verify-run.log 2>&1 &
tail -f verify-run.log

# 24/7 operation — auto-relaunch after each bandwidth-guard stop; waits for the
# pool to recover (probes probe-login-ips.mjs every 5 min) when all IPs are down
nohup ./run-24h.sh > run-24h.log 2>&1 &

# resume after a stop / bandwidth guard (same command; skips already-verdict'd)
node verify-accounts.mjs --max-mb 300

# rebuild the status lists from all results
node verify-accounts.mjs --final

# probe the whole proxy pool / a single flow through an IP
node probe-login-ips.mjs
node probe-ip.mjs

# helpers
node build-pool.mjs          # rebuild user-agents.json from the gist dump
node check-proxies.mjs       # mark IPs blocked against the VC home page
node login.mjs               # manual login helper (env VC_EMAIL/VC_PASSWORD)
node scrape.mjs <url>...     # polite crawler reusing a login session
python3 clean-accounts.py    # one-shot: raw myaccount.txt -> accounts.json (see AGENTS.md)
```

## Anti-ban model (per AGENTS.md)

One persistent browser profile (disk cache) per IP at `/tmp/opencode/vc-profiles/<ip>`;
a FRESH desktop-Chromium UA per check via CDP (`freshDesktopUA()`, pinned to the
installed Chromium major so sec-ch-ua hints match); IPs rotate round-robin per
check (randomized start, never the same IP twice in a row). Heavy assets are
blocked via CDP `Network.setBlockedURLs`. The Webshare free plan has 0
on-demand refreshes and no sticky backbone sessions, so "fresh IP per check" =
rotation among the healthy proxies.

Bandwidth is measured with a CDP `encodedDataLength` counter and guarded by
`--max-mb` per run. Plan usage is informational only (the stats API lags).

## Statuses

Definitive: `WORKING` / `FAILED` / `NOT_REGISTERED` / `SUSPENDED` / `DELETED` /
`LOCKED`. Transient (retried within the run): `WAF` / `BLOCKED` /
`RATE_LIMITED` / `ERROR`.

Results append to `verify-results.jsonl` (resume-safe). Any account already in
the results file (definitive OR transient) is skipped on relaunch; `--all` or
`--account <email>` force an explicit re-check. `--final` writes
`myaccount-verified.txt` and the per-status `accounts-*.txt` lists.

## Skills

Bundled twice so they are usable in every context:

- `skills/` — plain copy for manual use / copying to other machines.
- `.opencode/skills/` — auto-loaded by opencode (`opencode.json` declares
  `skills.paths: [".opencode/skills"]`). Reinstall on a new machine with:
  `npx skills add <repo> --skill <name> -g -a codex -y --copy`

Available:
- `vibe-check` — browser verification layer (navigate/map/click/fill, screenshots, storage-state).
- `playwright-skill` — Playwright E2E generator (local + TestMu cloud).
- `systematic-debugging` — root-cause-before-fix methodology.
