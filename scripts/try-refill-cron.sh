#!/usr/bin/env bash
# AIR-356: one run of the try card's refill and renew job for the coordinator's keep-alive job. A held request frees its slot only when
# someone calls expire, and the policy has 50 slots, so under traffic this should run every few minutes: between runs, once 50 holds are
# open, further held attempts come back blocked with PendingFull (still refused). Gas, storage, tasks and the registration last longer. Every line
# of output goes to target/try/refill.log (or $TRY_DIR/refill.log) with a UTC stamp. Exit 0 on a finished run and on the stop line; exit
# 1 only when an action failed. It runs live only while target/try/LIVE_OK exists (the coordinator's switch). ALERT lines are in the log.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
dir="${TRY_DIR:-$repo/target/try}"
mkdir -p "$dir"
log="$dir/refill.log"
out="$(cd "$repo" && source scripts/env.sh >/dev/null 2>&1 && pnpm -s tsx scripts/try-refill.ts --live 2>&1)"
rc=$?
while IFS= read -r line; do printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> "$log"; done <<< "$out"
printf '%s refill exit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >> "$log"
if [ "$rc" -ne 0 ]; then exit 1; fi
if printf '%s\n' "$out" | grep -q '^STOP '; then exit 0; fi
if printf '%s\n' "$out" | grep -q '^TRY REFILL OK'; then exit 0; fi
exit 1
