#!/usr/bin/env bash
# AIR-024: every consumer of the shared vector file family must exist and read it. scripts/vector-consumers.txt lists one path per line
# (AIR-122 appends runtime/test/vectors.test.ts in its own commit); a path that is missing, or whose file does not contain the string
# `verdict-vectors` (the name of the file family), is reported as `MISSING CONSUMER: <path>` and the script exits 1.
# Usage: scripts/check-vector-consumers.sh      (last line `CONSUMERS OK (<n>)` on success)
set -u
cd "$(dirname "$0")/.."
LIST=scripts/vector-consumers.txt
if [ ! -s "$LIST" ]; then
  echo "MISSING CONSUMER LIST: $LIST"
  exit 1
fi
n=0
bad=0
while IFS= read -r path || [ -n "$path" ]; do
  case "$path" in
    '' | '#'*) continue ;;
  esac
  if [ ! -f "$path" ] || ! grep -q 'verdict-vectors' "$path"; then
    echo "MISSING CONSUMER: $path"
    bad=$((bad + 1))
    continue
  fi
  n=$((n + 1))
done < "$LIST"
if [ "$bad" -ne 0 ]; then
  echo "CONSUMERS FAILED ($bad missing)"
  exit 1
fi
echo "CONSUMERS OK ($n)"
