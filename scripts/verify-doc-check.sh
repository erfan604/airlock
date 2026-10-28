#!/usr/bin/env bash
# AIR-284: the README section "Verify in 5 commands" and docs/VERIFY.md say the same five commands, each with a last line that something
# checks and a time that the G5 record supports.
# Usage: scripts/verify-doc-check.sh   (VERIFY_ROOT overrides the repo root, for the tests)
# Last line: VERIFY DOC OK (exit 0) or VERIFY DOC FAIL <k> (exit 1, k counts the FAIL lines printed above it). NOTE lines are not failures.
#
# How the two documents are read (the ticket pins the checks, not the layout, so this is the simplest reading of it):
#   A command row is a markdown table row whose first cell is a number. It has five cells: # | tier | command | time | last line, for
#   example  | 3 | T2 | `pnpm bench:replay` | about 90 s | `REPLAY OK <n> runs` |   The command and the last line sit in one pair of
#   backticks each; a pipe inside a cell is written \| and read back as a pipe. In README.md only the rows between the heading
#   "## Verify in 5 commands" and the next "## " heading are read; in docs/VERIFY.md every numbered row is read (its tier table, whose
#   first cells are T0 to T4, is not a command table). Each document must hold exactly 5 command rows.
# Checks:
#   1 row i of the README section equals row i of docs/VERIFY.md in tier, command, time and last line.
#   2 the last line of each docs/VERIFY.md row is one of the four pinned strings below, or is inside a docs/CLAIMS.md Expected output
#     cell or contains one (an empty cell counts for nothing). The fifth last line, "ready in <n>s", is the one the CLAIMS row of the
#     demo carries as its Expected output ("ready in").
#   3 the time reads "about <n> s". When docs/EVIDENCE.md has a "## G5 fresh clone" section, a row whose command is matched to a
#     DURATION line (pnpm demo to demo, bench:replay to replay, check.sh full to full, check.sh quick to quick; the claims-run rows
#     have none) needs n/2 <= duration <= 2n against the first "DURATION <name> <s>s" line of that section. Without the section, or
#     without that line, a NOTE is printed and the time is not compared.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$#" -eq 0 ] || { echo "usage: scripts/verify-doc-check.sh (no arguments; VERIFY_ROOT overrides the repo root)" >&2; exit 2; }
ROOT="${VERIFY_ROOT:-$(cd "$here/.." && pwd)}"
cd "$ROOT" || { echo "no such root: $ROOT" >&2; exit 2; }

HEADING='## Verify in 5 commands'
PINNED=('CLAIMS TIER node OK <n> run, <k> skipped' 'REPLAY OK <n> runs' 'ALL GREEN (full' 'CLAIMS NETWORK OK <n> rows')
US=$'\037'
FAILS=0
fail() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf 'NOTE %s\n' "$*"; }

# rows <file> <heading or empty>: one line per command row, fields joined by US: number, tier, command, time, last line.
# A row with another number of cells prints BAD, number, cell count.
rows() {
  awk -v sec="$2" -v us="$US" '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function unbt(s) { s = trim(s); if (length(s) >= 2 && substr(s, 1, 1) == "`" && substr(s, length(s), 1) == "`") s = trim(substr(s, 2, length(s) - 2)); return s }
    function back(s) { gsub(/\001/, "|", s); return s }
    BEGIN { on = (sec == "") }
    { line = $0; sub(/[ \t\r]+$/, "", line) }
    sec != "" && /^## / { on = (line == sec); next }
    on && line ~ /^\|/ {
      gsub(/\\\|/, "\001", line)
      sub(/^\|/, "", line); sub(/\|$/, "", line)
      n = split(line, c, "|")
      if (trim(c[1]) !~ /^[0-9]+$/) next
      if (n != 5) { print "BAD" us trim(c[1]) us n; next }
      print trim(c[1]) us back(trim(c[2])) us back(unbt(c[3])) us back(trim(c[4])) us back(unbt(c[5]))
    }
  ' "$1"
}

# field <rows text> <row number in the text> <field number>
field() { printf '%s\n' "$1" | awk -F"$US" -v i="$2" -v f="$3" 'NR == i { print $f }'; }
count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }

# the Expected output cells of docs/CLAIMS.md, one per line, empty cells left out
expected_cells() {
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function unbt(s) { s = trim(s); if (length(s) >= 2 && substr(s, 1, 1) == "`" && substr(s, length(s), 1) == "`") s = trim(substr(s, 2, length(s) - 2)); return s }
    BEGIN { col = 5 }
    /^\|/ {
      line = $0
      gsub(/\\\|/, "\001", line)
      sub(/^\|/, "", line); sub(/\|$/, "", line)
      n = split(line, c, "|")
      if (trim(c[1]) == "#") { for (i = 1; i <= n; i++) if (tolower(trim(c[i])) == "expected output") col = i; next }
      if (trim(c[1]) ~ /^C[0-9]+[a-z]?$/) { v = unbt(c[col]); gsub(/\001/, "|", v); if (v != "") print v }
    }
  ' docs/CLAIMS.md
}

in_claims() {   # in_claims <last line>: is it inside an Expected cell, or does it contain one
  local cell
  while IFS= read -r cell; do
    [ -n "$cell" ] || continue
    case "$1" in *"$cell"*) return 0;; esac
    case "$cell" in *"$1"*) return 0;; esac
  done <<EOF
$EXPECTED
EOF
  return 1
}

duration_name() {   # the DURATION line a command is matched to, or nothing
  case "$1" in
    *"pnpm demo"*) echo demo;;
    *"bench:replay"*) echo replay;;
    *"check.sh full"*) echo full;;
    *"check.sh quick"*) echo quick;;
  esac
}

# ---------- the two documents ----------
README_ROWS=""; VERIFY_ROWS=""; README_OK=0; VERIFY_OK=0
if [ ! -f README.md ]; then fail "README.md is missing"
elif ! grep -q "^$HEADING[[:space:]]*\$" README.md; then fail "README.md has no \"$HEADING\" section"
else README_OK=1; README_ROWS="$(rows README.md "$HEADING")"; fi
if [ ! -f docs/VERIFY.md ]; then fail "docs/VERIFY.md is missing"
else VERIFY_OK=1; VERIFY_ROWS="$(rows docs/VERIFY.md "")"; fi

NR_README="$(count "$README_ROWS")"; NR_VERIFY="$(count "$VERIFY_ROWS")"
if [ "$README_OK" = 1 ] && [ "$NR_README" -ne 5 ]; then fail "README.md section has $NR_README command rows, want 5"; fi
if [ "$VERIFY_OK" = 1 ] && [ "$NR_VERIFY" -ne 5 ]; then fail "docs/VERIFY.md has $NR_VERIFY command rows, want 5"; fi

# malformed rows are reported once and skipped by the other checks
bad_rows() {   # bad_rows <rows text> <file label>
  local i n
  n="$(count "$1")"; i=1
  while [ "$i" -le "$n" ]; do
    if [ "$(field "$1" "$i" 1)" = BAD ]; then fail "$2 row $(field "$1" "$i" 2) has $(field "$1" "$i" 3) cells, want 5"; fi
    i=$((i + 1))
  done
}
bad_rows "$README_ROWS" "README.md"
bad_rows "$VERIFY_ROWS" "docs/VERIFY.md"

# 1 the same five rows in both
if [ "$README_OK" = 1 ] && [ "$VERIFY_OK" = 1 ] && [ "$NR_README" -eq 5 ] && [ "$NR_VERIFY" -eq 5 ]; then
  i=1
  while [ "$i" -le 5 ]; do
    if [ "$(field "$README_ROWS" "$i" 1)" != BAD ] && [ "$(field "$VERIFY_ROWS" "$i" 1)" != BAD ]; then
      for pair in "2 tier" "3 command" "4 time" "5 last line"; do
        f="${pair%% *}"; what="${pair#* }"
        a="$(field "$README_ROWS" "$i" "$f")"; b="$(field "$VERIFY_ROWS" "$i" "$f")"
        [ "$a" = "$b" ] || fail "row $i: $what differs: README.md \"$a\", docs/VERIFY.md \"$b\""
      done
    fi
    i=$((i + 1))
  done
fi

# 2 and 3 on the rows of docs/VERIFY.md
EXPECTED=""; HAVE_CLAIMS=0
if [ ! -f docs/CLAIMS.md ]; then fail "docs/CLAIMS.md is missing"; else HAVE_CLAIMS=1; EXPECTED="$(expected_cells)"; fi
G5=""; HAVE_G5=0
if [ -f docs/EVIDENCE.md ] && grep -q '^## G5 fresh clone' docs/EVIDENCE.md; then
  HAVE_G5=1
  G5="$(awk '/^## /{ on = ($0 ~ /^## G5 fresh clone[ \t]*$/) } on && /^DURATION (quick|full|demo|replay) [0-9]+s[ \t]*$/ { print $2 " " $3 }' docs/EVIDENCE.md)"
else
  note 'docs/EVIDENCE.md has no "## G5 fresh clone" section, durations not compared'
fi

if [ "$VERIFY_OK" = 1 ]; then
  i=1
  while [ "$i" -le "$NR_VERIFY" ]; do
    if [ "$(field "$VERIFY_ROWS" "$i" 1)" != BAD ]; then
      cmd="$(field "$VERIFY_ROWS" "$i" 3)"; tm="$(field "$VERIFY_ROWS" "$i" 4)"; last="$(field "$VERIFY_ROWS" "$i" 5)"
      if [ "$HAVE_CLAIMS" = 1 ]; then
        ok=0
        for p in "${PINNED[@]}"; do [ "$last" = "$p" ] && ok=1; done
        [ "$ok" = 1 ] || in_claims "$last" || fail "row $i: last line \"$last\" is in no CLAIMS Expected output cell and is not one of the pinned strings"
      fi
      if ! printf '%s\n' "$tm" | grep -qE '^about [0-9]+ s$'; then
        fail "row $i: time \"$tm\" is not of the form about <n> s"
      elif [ "$HAVE_G5" = 1 ]; then
        name="$(duration_name "$cmd")"
        if [ -n "$name" ]; then
          d="$(printf '%s\n' "$G5" | awk -v n="$name" '$1 == n { sub(/s$/, "", $2); print $2; exit }')"
          t="$(printf '%s\n' "$tm" | awk '{ print $2 }')"
          if [ -z "$d" ]; then
            note "row $i: no DURATION $name line in the G5 section, time not compared"
          elif [ $((2 * 10#$d)) -lt $((10#$t)) ] || [ $((10#$d)) -gt $((2 * 10#$t)) ]; then
            fail "row $i: about $t s is not within a factor of 2 of DURATION $name ${d}s"
          fi
        fi
      fi
    fi
    i=$((i + 1))
  done
fi

if [ "$FAILS" -eq 0 ]; then echo "VERIFY DOC OK"; exit 0; fi
echo "VERIFY DOC FAIL $FAILS"
exit 1
