#!/bin/bash
# 24/7 wrapper for verify-accounts.mjs.
#
# A single run stops cleanly when the CDP-measured bandwidth budget
# (--max-mb) is exhausted. This loop relaunches it automatically so the
# checker runs around the clock until every account has a verdict. Safe
# because results are appended to verify-results.jsonl and the checker
# never re-processes an account that already has a result line.
#
# Live output is streamed to verify-run.log (same file the checker uses).
# Usage: nohup ./run-24h.sh > run-24h.log 2>&1 &

set -u

MAX_MB="${1:-300}"

while true; do
  echo "=== run at $(date -Is) ==="
  out=$(node verify-accounts.mjs --max-mb "$MAX_MB" 2>&1 | tee -a verify-run.log)
  if echo "$out" | grep -q "nothing to do"; then
    echo "=== ALL DONE at $(date -Is) ==="
    break
  fi
  if echo "$out" | grep -qiE "FATAL|no healthy IPs|no usable session"; then
    echo "=== blocked condition, waiting 5 min before retry ==="
    sleep 300
    continue
  fi
  sleep 20
done
