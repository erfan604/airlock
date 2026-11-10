#!/usr/bin/env bash
# AIR-336: one Credit Arena round for the coordinator's keep-alive job, called no more often than every 65 minutes (the round's own spacing rule
# also stops it). ARENA_ROUNDS (default 1) rounds per call. Every line of output goes to target/arena/cron.log (or $ARENA_DIR/cron.log) with a UTC
# stamp. Exit 0 on a round and on any stop rule; exit 1 only when a round failed. The model key comes from the environment the job already has,
# or from ~/.airlock-research.env when that file exists. Live rounds run only while target/arena/LIVE_OK exists (the coordinator's switch).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
dir="${ARENA_DIR:-$repo/target/arena}"
mkdir -p "$dir"
log="$dir/cron.log"
rounds="${ARENA_ROUNDS:-1}"
case "$rounds" in ''|*[!0-9]*) echo "ARENA_ROUNDS must be a whole number" >&2; exit 2;; esac
if [ -f "$HOME/.airlock-research.env" ]; then set -a; . "$HOME/.airlock-research.env"; set +a; fi
export LLM_MODE="${LLM_MODE:-live}"
status=0
i=0
while [ "$i" -lt "$rounds" ]; do
  i=$((i + 1))
  out="$(cd "$repo" && source scripts/env.sh >/dev/null 2>&1 && pnpm -s tsx scripts/credit-arena.ts 2>&1)"
  rc=$?
  while IFS= read -r line; do printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> "$log"; done <<< "$out"
  printf '%s round %s of %s exit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$i" "$rounds" "$rc" >> "$log"
  # a failed round ends the run with exit 1; a stop rule ends it with exit 0; anything that is not a finished round is a failure
  if [ "$rc" -ne 0 ]; then status=1; break; fi
  if printf '%s\n' "$out" | grep -q '^STOP '; then break; fi
  if ! printf '%s\n' "$out" | grep -q '^ARENA ROUND OK'; then status=1; break; fi
done
exit "$status"
