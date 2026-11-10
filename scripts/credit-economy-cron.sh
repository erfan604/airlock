#!/usr/bin/env bash
# AIR-359: one cycle of the hourly economy loop for the coordinator's keep-alive job, called after its expire step and before the arena
# round (scripts/credit-arena-cron.sh), so the two never run at once; they also share the lock target/credit/LOCK. Every line of output
# goes to target/economy/cron.log (or $ECONOMY_DIR/cron.log) with a UTC stamp. Exit 0 on a finished cycle, a recovery and any stop rule;
# exit 1 only when a cycle failed. Live cycles run only while target/economy/LIVE_OK exists (the coordinator's switch). No model is called.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
dir="${ECONOMY_DIR:-$repo/target/economy}"
mkdir -p "$dir"
log="$dir/cron.log"
out="$(cd "$repo" && source scripts/env.sh >/dev/null 2>&1 && pnpm -s tsx scripts/credit-economy.ts 2>&1)"
rc=$?
while IFS= read -r line; do printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> "$log"; done <<< "$out"
printf '%s cycle exit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >> "$log"
# a failed cycle is exit 1; a stop rule, a recovery and a finished cycle are exit 0; anything else is a failure
if [ "$rc" -ne 0 ]; then exit 1; fi
if printf '%s\n' "$out" | grep -q '^STOP '; then exit 0; fi
if printf '%s\n' "$out" | grep -qE '^(ECONOMY CYCLE OK|ECONOMY RECOVERED)'; then exit 0; fi
exit 1
