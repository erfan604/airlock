#!/usr/bin/env bash
# AIR-125: tests of scripts/check-payloads.sh and scripts/payload-scan.sh. Each case builds a scratch git repo under mktemp -d
# holding a copy of fixtures/ and the three scripts the check calls (check-payloads.sh, payload-markers.mjs, payload-scan.sh).
# The pasted line is read from a payload file at run time, so this file holds no payload text.
# Last line: PAYLOAD CHECK TESTS OK (11 cases)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$here/.."
fail() { echo "FAIL $1: $2"; exit 1; }
for f in check-payloads.sh payload-scan.sh payload-markers.mjs; do [ -f "$here/$f" ] || fail setup "scripts/$f is missing"; done
[ -d "$root/fixtures/payloads" ] || fail setup "fixtures/payloads is missing (AIR-125 writes it)"
N=0
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

repo() {  # repo <name>: scratch repo with fixtures/ and the three scripts, all committed
  R="$W/$1"; mkdir -p "$R/scripts"
  cp -R "$root/fixtures" "$R/fixtures"
  cp "$here/check-payloads.sh" "$here/payload-scan.sh" "$here/payload-markers.mjs" "$R/scripts/"
  git -C "$R" init -q
  git -C "$R" add fixtures scripts
  git -C "$R" commit -q -m "fixtures and scripts"
}
run() { set +e; OUT="$(cd "$R" && "$@" 2>&1)"; RC=$?; set -e; }
expect_rc() {  # expect_rc <case> <code>
  [ "$RC" -eq "$2" ] || fail "$1" "exit $RC, want $2: $OUT"
  N=$((N + 1))
}

repo clean
line="$(awk 'length($0) >= 30 {print; exit}' "$R"/fixtures/payloads/*.txt)"
[ -n "$line" ] || fail setup "no payload line of 30 or more characters to paste"

run scripts/check-payloads.sh
printf '%s\n' "$OUT" | tail -1 | grep -qE '^PAYLOADS OK \([0-9]+ payloads, [0-9]+ x402 files, 0 leaks\)$' || fail clean "last line: $OUT"
expect_rc clean 0

repo markdown; printf '# Notes\n\n%s\n' "$line" > "$R/notes.md"; run scripts/check-payloads.sh
printf '%s\n' "$OUT" | grep -q 'notes.md' || fail markdown "the pasted file is not named: $OUT"
printf '%s\n' "$OUT" | grep -q '^FAIL leak: 1 payload lines' || fail markdown "no leak failure line: $OUT"
expect_rc markdown 1

repo message; git -C "$R" commit -q --allow-empty -m "$line"; run scripts/payload-scan.sh
expect_rc commit-message 1

repo byte; f="$(ls "$R"/fixtures/payloads/*.txt | head -1)"; printf 'x' >> "$f"; run scripts/check-payloads.sh
printf '%s\n' "$OUT" | grep -q "$(basename "$f").*FAILED" || fail byte "the manifest failure does not name $(basename "$f"): $OUT"
expect_rc byte 1

repo empty; : > "$R/fixtures/payload-markers.txt"; run scripts/payload-scan.sh
[ "$RC" -eq 2 ] || fail empty-markers "an empty marker file: exit $RC, want 2: $OUT"
printf '\n' > "$R/fixtures/payload-markers.txt"; run scripts/payload-scan.sh   # a blank fixed string would match every line
expect_rc empty-markers 2

# a scan that cannot run is not a pass: outside a git repository git grep fails and the scan exits 2
R="$W/norepo"; mkdir -p "$R/scripts"; cp -R "$root/fixtures" "$R/fixtures"; cp "$here/payload-scan.sh" "$R/scripts/"
GIT_CEILING_DIRECTORIES="$W" run scripts/payload-scan.sh
expect_rc no-repo 2

repo few; rm "$(ls "$R"/fixtures/payloads/*.txt | head -1)"; node "$R/scripts/payload-markers.mjs" > /dev/null; run scripts/check-payloads.sh
printf '%s\n' "$OUT" | grep -q '^FAIL count: ' || fail few-files "no count failure: $OUT"
expect_rc few-files 1

repo ascii; f="$(ls "$R"/fixtures/payloads/*.txt | head -1)"; printf 'caf\303\251\n' >> "$f"; run scripts/check-payloads.sh
printf '%s\n' "$OUT" | grep -q "^FAIL ascii: fixtures/payloads/$(basename "$f"):" || fail ascii "the non-ASCII line is not named: $OUT"
expect_rc ascii 1

repo unlisted; printf 'short\n' > "$R/fixtures/payloads/zz-new.txt"; run scripts/check-payloads.sh
printf '%s\n' "$OUT" | grep -q 'zz-new.txt is not listed' || fail unlisted "a file missing from the manifest passes: $OUT"
expect_rc unlisted 1

repo stale; f="$(ls "$R"/fixtures/payloads/*.txt | head -1)"; printf 'An added line that is long enough to become a marker.\n' >> "$f"
cp "$R/fixtures/payloads.sha256" "$W/stale.sha256"; run scripts/check-payloads.sh --update
printf '%s\n' "$OUT" | grep -q '^FAIL markers: STALE' || fail stale-markers "no stale marker failure: $OUT"
cmp -s "$R/fixtures/payloads.sha256" "$W/stale.sha256" || fail stale-markers "--update rewrote the manifest although the markers are stale"
expect_rc stale-markers 1

repo recordings; mkdir -p "$R/runtime/recordings"; printf '%s\n' "$line" > "$R/runtime/recordings/r1.txt"; run scripts/check-payloads.sh
expect_rc recordings 0

echo "PAYLOAD CHECK TESTS OK ($N cases)"
