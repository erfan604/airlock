#!/usr/bin/env bash
# AIR-240, AIR-284: runs every command of docs/CLAIMS.md and prints one PASS, FAIL, PENDING or SKIP line per row (scripts/claims-run.ts).
# Usage: scripts/claims-run.sh [--offline | --network | --tier node|rust|full [--network]]
#   --offline (default) rows that need no network, --network the network rows, --tier a row per line with SKIP <id> needs <tool>
#   for a tool the tier or the machine lacks. Last line: CLAIMS OFFLINE OK <n> rows, CLAIMS NETWORK OK <n> rows or
#   CLAIMS TIER <name> OK <n> run, <k> skipped. Exit 0 when no row failed, 1 otherwise, 2 for a usage error.
# Run it after `source scripts/env.sh` (Node 24 on the PATH). It does not source env.sh itself, so a machine with only Node and pnpm
# sees the same tools the commands see. Node 22.18 or newer runs a .ts file as it is; anything older is refused here with a message.
# Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node > /dev/null 2>&1; then
  echo "claims-run.sh: node is not on the PATH (run: source scripts/env.sh, which selects Node 24)" >&2
  exit 2
fi
ver="$(node --version 2> /dev/null || true)"; ver="${ver#v}"
major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
case "$major" in ''|*[!0-9]*) major=0;; esac
case "$minor" in ''|*[!0-9]*) minor=0;; esac
if ! { [ "$major" -ge 24 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; } || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }; }; then
  echo "claims-run.sh: Node ${ver:-unknown} cannot run a .ts file directly; use Node 24 (source scripts/env.sh) or Node 22.18 or newer" >&2
  exit 2
fi
exec node "$here/claims-run.ts" "$@"
