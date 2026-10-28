#!/usr/bin/env bash
# AIR-004: offline tests of scripts/lint-money.sh on the fixtures in scripts/lint-fixtures/.
# Each case builds a scratch tree (mktemp -d) with its own scripts/lint-money.dirs and runs the lint there with LINT_ROOT.
# Last line: LINT TESTS OK (rust 2 violations, ts 4 violations, 0 false positives)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT="$here/lint-money.sh"
FIX="$here/lint-fixtures"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$LINT" ] || fail setup "scripts/lint-money.sh is missing or not executable"

tree() {   # tree <dirs file content>: a scratch root holding scripts/lint-money.dirs
  local t; t="$(mktemp -d)"
  mkdir -p "$t/scripts" "$t/runtime/src/chain" "$t/contracts/x/src"
  printf '%s\n' "$1" > "$t/scripts/lint-money.dirs"
  echo "$t"
}
run() {    # run <root>: sets OUT and RC
  set +e; OUT="$(LINT_ROOT="$1" "$LINT" 2>&1)"; RC=$?; set -e
}
count() { printf '%s\n' "$OUT" | grep -cE ': rule (R1|T[1-4])$' || true; }

# bad.rs: two R1 findings
T="$(tree runtime/src/chain)"; cp "$FIX/bad.rs" "$T/contracts/x/src/t.rs"; run "$T"
[ "$RC" -eq 1 ] || fail bad.rs "exit $RC, want 1"
[ "$(count)" -eq 2 ] || fail bad.rs "$(count) violations, want 2"
printf '%s\n' "$OUT" | grep -q 't.rs:1: rule R1$' || fail bad.rs "no 't.rs:1: rule R1' line"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "LINT FAILED (2 violations)" ] || fail bad.rs "last line: $(printf '%s\n' "$OUT" | tail -1)"
RUST=$(count); rm -rf "$T"

# bad.ts: T1 to T4, one each
T="$(tree runtime/src/chain)"; cp "$FIX/bad.ts" "$T/runtime/src/chain/t.ts"; run "$T"
[ "$RC" -eq 1 ] || fail bad.ts "exit $RC, want 1"
[ "$(count)" -eq 4 ] || fail bad.ts "$(count) violations, want 4"
for r in "1: rule T1" "2: rule T2" "3: rule T3" "4: rule T4"; do
  printf '%s\n' "$OUT" | grep -q "t.ts:$r\$" || fail bad.ts "no 't.ts:$r' line"
done
[ "$(printf '%s\n' "$OUT" | tail -1)" = "LINT FAILED (4 violations)" ] || fail bad.ts "last line: $(printf '%s\n' "$OUT" | tail -1)"
TS=$(count); rm -rf "$T"

# good.ts: no finding (MyNumber, Number.isInteger, parseIntent, BigInt with ** and with string or integer literals)
T="$(tree runtime/src/chain)"; cp "$FIX/good.ts" "$T/runtime/src/chain/t.ts"; run "$T"
[ "$RC" -eq 0 ] || fail good.ts "exit $RC, want 0: $OUT"
FP=$(count)
[ "$(printf '%s\n' "$OUT" | tail -1)" = "LINT OK (1 directories, 0 violations)" ] || fail good.ts "last line: $(printf '%s\n' "$OUT" | tail -1)"
rm -rf "$T"

# allowed.ts: exempt by its money-lint-allow comment, listed once as EXEMPT
T="$(tree runtime/src/chain)"; cp "$FIX/allowed.ts" "$T/runtime/src/chain/t.ts"; run "$T"
[ "$RC" -eq 0 ] || fail allowed.ts "exit $RC, want 0: $OUT"
[ "$(printf '%s\n' "$OUT" | grep -c '^EXEMPT runtime/src/chain/t.ts:1: array index, not money$')" -eq 1 ] || fail allowed.ts "want one EXEMPT line: $OUT"
rm -rf "$T"

# the real directory list: its runtime/src/chain entry is checked, the others print (absent)
T="$(tree x)"; cp "$here/lint-money.dirs" "$T/scripts/lint-money.dirs"; printf 'const a = Number(x);\n' > "$T/runtime/src/chain/t.ts"; run "$T"
[ "$RC" -eq 1 ] || fail real-dirs "exit $RC, want 1"
printf '%s\n' "$OUT" | grep -q 't.ts:1: rule T1$' || fail real-dirs "no 't.ts:1: rule T1' line"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "LINT FAILED (1 violations)" ] || fail real-dirs "last line: $(printf '%s\n' "$OUT" | tail -1)"
printf '%s\n' "$OUT" | grep -qx 'runtime/src/dsl (absent)' || fail real-dirs "a missing listed directory must print (absent)"
rm -rf "$T"

# a duplicate line is read once; a missing directory prints (absent); comments and blank lines are ignored
T="$(tree "$(printf '# note\nruntime/src/chain\n\nruntime/src/chain\nweb/src/nowhere')")"; run "$T"
[ "$RC" -eq 0 ] || fail dirs "exit $RC, want 0: $OUT"
[ "$(printf '%s\n' "$OUT" | grep -cx 'runtime/src/chain')" -eq 1 ] || fail dirs "duplicate directory listed more than once: $OUT"
printf '%s\n' "$OUT" | grep -qx 'web/src/nowhere (absent)' || fail dirs "missing directory not printed as (absent)"
[ "$(printf '%s\n' "$OUT" | tail -1)" = "LINT OK (2 directories, 0 violations)" ] || fail dirs "last line: $(printf '%s\n' "$OUT" | tail -1)"
rm -rf "$T"

# no dirs file: usage error
T="$(mktemp -d)"; run "$T"
[ "$RC" -eq 2 ] && printf '%s\n' "$OUT" | grep -q 'no dirs file' || fail no-dirs "exit $RC, want 2 and 'no dirs file': $OUT"
rm -rf "$T"

echo "LINT TESTS OK (rust $RUST violations, ts $TS violations, $FP false positives)"
