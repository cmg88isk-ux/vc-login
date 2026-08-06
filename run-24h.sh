#!/bin/bash
# 24/7 wrapper for verify-accounts.mjs.
#
# A single run stops cleanly when the CDP-measured bandwidth budget
# (--max-mb) is exhausted. This loop relaunches it automatically so the
# checker runs around the clock until every account has a verdict. Safe
# because results are appended to verify-results.jsonl and the checker
# never re-processes an account that already has a result line.
#
# When the whole proxy pool is down (no healthy IPs / no usable session),
# instead of retrying on a fixed timer it polls the pool with
# probe-login-ips.mjs every POOL_POLL_S (matches the per-IP re-probe
# cooldown in verify-accounts.mjs) and only relaunches the checker once
# at least one IP is healthy again. probe-login-ips.mjs persists the
# verdicts to vc-healthy.json, so the relaunched checker skips its own
# full-pool probe and starts sessions immediately.
#
# Live output is streamed to verify-run.log (same file the checker uses).
# Usage: nohup ./run-24h.sh > run-24h.log 2>&1 &

set -u

MAX_MB="${1:-300}"
POOL_POLL_S="${POOL_POLL_S:-300}"   # min between pool probes (>= RECOVER_INTERVAL_MS)

while true; do
  echo "=== run at $(date -Is) ==="
  out=$(node verify-accounts.mjs --max-mb "$MAX_MB" 2>&1 | tee -a verify-run.log)
  if echo "$out" | grep -q "nothing to do"; then
    echo "=== ALL DONE at $(date -Is) ==="
    break
  fi
  if echo "$out" | grep -qiE "no healthy IPs|no usable session"; then
    echo "=== pool down — probing every ${POOL_POLL_S}s until an IP recovers ==="
    while true; do
      out=$(node probe-login-ips.mjs 2>&1 | tee -a verify-run.log)
      if echo "$out" | grep -qE "[1-9][0-9]*/[0-9]+ IPs pass"; then
        echo "=== pool recovered, relaunching checker ==="
        break
      fi
      echo "  no healthy IP yet — next probe in ${POOL_POLL_S}s"
      sleep "$POOL_POLL_S"
    done
    continue
  fi
  if echo "$out" | grep -qi "FATAL"; then
    echo "=== FATAL error, waiting 5 min before retry ==="
    sleep 300
    continue
  fi
  sleep 20
done
