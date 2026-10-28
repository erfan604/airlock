#!/usr/bin/env bash
# AIR-284: fixture tests of scripts/verify-doc-check.sh. Each case builds a scratch root (mktemp -d) with README.md, docs/VERIFY.md,
# docs/CLAIMS.md and optionally docs/EVIDENCE.md, runs the check there with VERIFY_ROOT and reads its lines and exit code.
# Last line: VERIFY DOC TESTS OK <n>. Bash 3.2 compatible (macOS /bin/bash); the tests also run under bash 5.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$here/verify-doc-check.sh"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$CHECK" ] || fail setup "scripts/verify-doc-check.sh is missing or not executable"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
N=0

# the five command rows of both documents: # | tier | command | time | last line
rows() {
  cat <<'EOF'
| 1 | T1 | `pnpm i && pnpm demo --no-open --exit-when-ready` | about 40 s | `ready in <n>s` |
| 2 | T1 | `scripts/claims-run.sh --tier node` | about 20 s | `CLAIMS TIER node OK <n> run, <k> skipped` |
| 3 | T2 | `pnpm bench:replay` | about 90 s | `REPLAY OK <n> runs` |
| 4 | T3 | `scripts/check.sh full` | about 1200 s | `ALL GREEN (full` |
| 5 | T4 | `scripts/claims-run.sh --network` | about 30 s | `CLAIMS NETWORK OK <n> rows` |
EOF
}
HEAD_ROWS='| # | Tier | Command | Time | Last line |
| --- | --- | --- | --- | --- |'

mk() {   # mk <name>: a scratch root where every document is right; sets R
  R="$W/$1"; mkdir -p "$R/docs"
  { printf '# Sample\n\nIntro.\n\n## Try it in 2 minutes\n\nRun the demo.\n\n## Verify in 5 commands\n\n%s\n' "$HEAD_ROWS"; rows
    printf '\nSee docs/VERIFY.md.\n\n## Limits\n\nNone.\n'; } > "$R/README.md"
  { printf '# Verify\n\n| Tier | Needs |\n| --- | --- |\n| T0 | nothing to run |\n| T1 | Node 24 and pnpm |\n\n%s\n' "$HEAD_ROWS"; rows; } > "$R/docs/VERIFY.md"
  cat > "$R/docs/CLAIMS.md" <<'EOF'
# Claims

| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |
| --- | --- | --- | --- | --- | --- | --- |
| C6 | Bench. | | `pending: AIR-228 scripts/bench-replay-check.sh` | `BENCH REPLAY OK` | none | AIR-240 |
| C11 | The demo runs. | | `pending: AIR-246 pnpm demo --no-open --exit-when-ready` | `ready in` | none | AIR-240 |
| C12 | No expected cell. | | `echo x` | | none | AIR-240 |
EOF
}
g5() {   # g5 <demo> <replay> <full> [quick]: a G5 fresh clone section above Model choice in docs/EVIDENCE.md
  { printf '# Evidence\n\n## Pins\n\nTable.\n\n## G5 fresh clone\n\n- Date: today\n\n```\n'
    [ -z "${4:-}" ] || printf 'DURATION quick %ss\n' "$4"
    printf 'DURATION full %ss\n' "$3"
    [ -z "$1" ] || printf 'DURATION demo %ss\n' "$1"
    [ -z "$2" ] || printf 'DURATION replay %ss\n' "$2"
    printf '```\n\n## Model choice\n\nText.\n'; } > "$R/docs/EVIDENCE.md"
}
sub() {  # sub <file> <sed expression>: edit a file of the scratch root in place (BSD and GNU sed both)
  sed "$2" "$R/$1" > "$R/$1.new" && mv "$R/$1.new" "$R/$1"
}
run() { set +e; OUT="$(VERIFY_ROOT="$R" "$CHECK" 2>&1)"; RC=$?; set -e; LAST="$(printf '%s\n' "$OUT" | tail -1)"; }
expect() {   # expect <case> <exit> <last line>
  [ "$RC" -eq "$2" ] || fail "$1" "exit $RC, want $2: $OUT"
  [ "$LAST" = "$3" ] || fail "$1" "last line '$LAST', want '$3': $OUT"
  N=$((N + 1))
}
has() { printf '%s\n' "$OUT" | grep -qF -- "$2" || fail "$1" "no line with '$2': $OUT"; }
hasnt() { if printf '%s\n' "$OUT" | grep -qF -- "$2"; then fail "$1" "unexpected '$2': $OUT"; fi; }

# 1 a right set of documents without a G5 record passes and says the durations were not compared
mk good; run; expect good 0 'VERIFY DOC OK'; has good 'NOTE docs/EVIDENCE.md has no "## G5 fresh clone" section'; hasnt good 'NOTE row'

# 2 with a G5 record whose durations match, there is no note
mk g5ok; g5 40 90 1200 25; run; expect g5-ok 0 'VERIFY DOC OK'; hasnt g5-ok 'NOTE'

# 3 the README without its section, the README itself missing, VERIFY.md missing, CLAIMS.md missing: one failure each
mk nosec; sub README.md 's/^## Verify in 5 commands$/## Checks/'; run; expect no-section 1 'VERIFY DOC FAIL 1'; has no-section '"## Verify in 5 commands"'
mk noreadme; rm "$R/README.md"; run; expect no-readme 1 'VERIFY DOC FAIL 1'; has no-readme 'README.md is missing'
mk noverify; rm "$R/docs/VERIFY.md"; run; expect no-verify 1 'VERIFY DOC FAIL 1'; has no-verify 'docs/VERIFY.md is missing'
mk noclaims; rm "$R/docs/CLAIMS.md"; run; expect no-claims 1 'VERIFY DOC FAIL 1'; has no-claims 'docs/CLAIMS.md is missing'

# 4 a README section with 4 command rows, a VERIFY.md with 6, a malformed row (four cells)
mk four; sub README.md '/^| 5 | /d'; run; expect four-rows 1 'VERIFY DOC FAIL 1'; has four-rows 'README.md section has 4 command rows, want 5'
mk six; printf '| 6 | T4 | `extra` | about 5 s | `ALL GREEN (full` |\n' >> "$R/docs/VERIFY.md"; run; expect six-rows 1 'VERIFY DOC FAIL 1'; has six-rows 'docs/VERIFY.md has 6 command rows, want 5'
mk sixr; sub README.md 's/^| 5 | T4 | \(.*\)$/| 5 | T4 | \1\
| 6 | T4 | `extra` | about 5 s | `ALL GREEN (full` |/'; run; expect readme-six-rows 1 'VERIFY DOC FAIL 1'; has readme-six-rows 'README.md section has 6 command rows, want 5'
mk fourv; sub docs/VERIFY.md '/^| 5 | /d'; run; expect verify-four-rows 1 'VERIFY DOC FAIL 1'; has verify-four-rows 'docs/VERIFY.md has 4 command rows, want 5'
mk bad; sub docs/VERIFY.md 's/^| 2 | T1 | \(.*\) | about 20 s | \(.*\) |$/| 2 | T1 | \1 | \2 |/'; run; expect four-cells 1 'VERIFY DOC FAIL 1'; has four-cells 'docs/VERIFY.md row 2 has 4 cells, want 5'

# 5 each field of a row must be the same in the README and in VERIFY.md
mk cmd; sub README.md 's/`pnpm bench:replay`/`pnpm bench:replay --quick`/'; run; expect cmd-differs 1 'VERIFY DOC FAIL 1'; has cmd-differs 'row 3: command differs'
mk tier; sub README.md 's/^| 3 | T2 |/| 3 | T3 |/'; run; expect tier-differs 1 'VERIFY DOC FAIL 1'; has tier-differs 'row 3: tier differs'
mk time; sub README.md 's/about 90 s/about 91 s/'; run; expect time-differs 1 'VERIFY DOC FAIL 1'; has time-differs 'row 3: time differs'
mk last; sub README.md 's/`REPLAY OK <n> runs`/`REPLAY OK <n> run`/'; run; expect last-differs 1 'VERIFY DOC FAIL 1'; has last-differs 'row 3: last line differs'

# 6 a last line that is in no CLAIMS Expected cell and is not one of the four pinned strings
mk unpinned; sub README.md 's/`REPLAY OK <n> runs`/`REPLAY DONE`/'; sub docs/VERIFY.md 's/`REPLAY OK <n> runs`/`REPLAY DONE`/'; run; expect unpinned 1 'VERIFY DOC FAIL 1'; has unpinned 'row 3: last line "REPLAY DONE"'
# each pinned string is accepted exactly, a near miss is not
for pair in 'CLAIMS TIER node OK <n> run, <k> skipped|CLAIMS TIER node OK <n> run, <k> skipped.' 'ALL GREEN (full|ALL GREEN (full)' 'CLAIMS NETWORK OK <n> rows|CLAIMS NETWORK OK <n> row'; do
  good="${pair%%|*}"; near="${pair#*|}"
  mk "near-$N"; sub README.md "s/\`$good\`/\`$near\`/"; sub docs/VERIFY.md "s/\`$good\`/\`$near\`/"; run; expect "near-miss $good" 1 'VERIFY DOC FAIL 1'
done
# row 1 is accepted through a CLAIMS Expected cell that is inside the last line, and through one that holds the last line
mk cellin; sub docs/CLAIMS.md 's/`ready in`/`ready in <n>s and more`/'; run; expect cell-holds-line 0 'VERIFY DOC OK'
mk nocell; sub docs/CLAIMS.md 's/`ready in`/`something else`/'; run; expect no-cell 1 'VERIFY DOC FAIL 1'; has no-cell 'row 1: last line "ready in <n>s"'
# an empty Expected cell is not a substring of every line
mk emptycell; sub docs/CLAIMS.md 's/`ready in`//'; run; expect empty-cell 1 'VERIFY DOC FAIL 1'

mk noexp; sub docs/CLAIMS.md '/^| C6 /d'; sub docs/CLAIMS.md '/^| C11 /d'; run; expect no-expected-cells 1 'VERIFY DOC FAIL 1'; has no-expected-cells 'row 1: last line "ready in <n>s"'

# 7 the time must read "about <n> s"
mk fmt; sub README.md 's/about 20 s/20 s/'; sub docs/VERIFY.md 's/about 20 s/20 s/'; run; expect time-format 1 'VERIFY DOC FAIL 1'; has time-format 'row 2: time "20 s" is not of the form about <n> s'
mk fmt2; sub README.md 's/about 20 s/about 20 seconds/'; sub docs/VERIFY.md 's/about 20 s/about 20 seconds/'; run; expect time-format2 1 'VERIFY DOC FAIL 1'

# 8 within a factor of 2 of the DURATION line, both ends included: about 40 s against 80 s and 20 s pass, 81 s and 19 s fail
mk f80; g5 80 90 1200; run; expect factor-upper-edge 0 'VERIFY DOC OK'
mk f81; g5 81 90 1200; run; expect factor-upper 1 'VERIFY DOC FAIL 1'; has factor-upper 'row 1: about 40 s is not within a factor of 2 of DURATION demo 81s'
mk f20; g5 20 90 1200; run; expect factor-lower-edge 0 'VERIFY DOC OK'
mk f19; g5 19 90 1200; run; expect factor-lower 1 'VERIFY DOC FAIL 1'; has factor-lower 'DURATION demo 19s'
# replay (row 3) and full (row 4) are matched to their own DURATION lines
mk freplay; g5 40 500 1200; run; expect replay-mismatch 1 'VERIFY DOC FAIL 1'; has replay-mismatch 'row 3: about 90 s is not within a factor of 2 of DURATION replay 500s'
mk ffull; g5 40 90 10; run; expect full-mismatch 1 'VERIFY DOC FAIL 1'; has full-mismatch 'row 4: about 1200 s is not within a factor of 2 of DURATION full 10s'
# the claims-run rows (2 and 5) and the quick duration have no counterpart
mk fquick; g5 40 90 1200 999999; run; expect quick-ignored 0 'VERIFY DOC OK'
# DURATION lines of another section are not read, a missing line is a note and not a failure
mk other; g5 40 90 1200; sub docs/EVIDENCE.md 's/^## Model choice$/## Other\
\
DURATION demo 99999s\
\
## Model choice/'; run; expect other-section 0 'VERIFY DOC OK'
mk dup; g5 40 90 1200; sub docs/EVIDENCE.md 's/^DURATION demo 40s$/DURATION demo 40s\
DURATION demo 99999s/'; run; expect first-duration-wins 0 'VERIFY DOC OK'
mk dup2; g5 40 90 1200; sub docs/EVIDENCE.md 's/^DURATION demo 40s$/DURATION demo 99999s\
DURATION demo 40s/'; run; expect first-duration-wins-bad 1 'VERIFY DOC FAIL 1'
mk before; g5 40 90 1200; sub docs/EVIDENCE.md 's/^Table\.$/DURATION demo 99999s/'; run; expect other-section-before 0 'VERIFY DOC OK'
mk nosection; printf '# Evidence\n\n## Pins\n\nTable.\n\n## Model choice\n\nText.\n' > "$R/docs/EVIDENCE.md"; run; expect evidence-without-section 0 'VERIFY DOC OK'; has evidence-without-section 'has no "## G5 fresh clone" section'; hasnt evidence-without-section 'NOTE row'
mk quick; g5 40 90 1200 10; sub README.md 's/`scripts\/check.sh full`/`scripts\/check.sh quick`/'; sub docs/VERIFY.md 's/`scripts\/check.sh full`/`scripts\/check.sh quick`/'; sub README.md 's/about 1200 s/about 1500 s/'; sub docs/VERIFY.md 's/about 1200 s/about 1500 s/'
run; expect quick-mapped 1 'VERIFY DOC FAIL 1'; has quick-mapped 'row 4: about 1500 s is not within a factor of 2 of DURATION quick 10s'
mk nodemo; g5 "" 90 1200; run; expect no-demo-line 0 'VERIFY DOC OK'; has no-demo-line 'NOTE row 1: no DURATION demo line'
mk noevid; g5 40 90 1200; rm "$R/docs/EVIDENCE.md"; run; expect no-evidence-file 0 'VERIFY DOC OK'; has no-evidence-file 'NOTE docs/EVIDENCE.md has no "## G5 fresh clone" section'

# 9 rows outside the README section are not command rows; the section may be the last one; an escaped pipe in a cell is one cell
mk outside; printf '\n| 7 | T9 | `x` | about 1 s | `y` |\n' >> "$R/README.md"; sub README.md 's/^## Try it in 2 minutes$/| 8 | T9 | `x` | about 1 s | `y` |\
\
## Try it in 2 minutes/'; run; expect outside-rows 0 'VERIFY DOC OK'
mk lastsec; sub README.md '/^## Limits$/,$d'; run; expect last-section 0 'VERIFY DOC OK'
mk pipemsg; sub README.md 's/`scripts\/check.sh full`/`scripts\/check.sh full \\| tail -1`/'; sub docs/VERIFY.md 's/`scripts\/check.sh full`/`scripts\/check.sh full \\| tail -2`/'; run
expect escaped-pipe-message 1 'VERIFY DOC FAIL 1'; has escaped-pipe-message 'README.md "scripts/check.sh full | tail -1", docs/VERIFY.md "scripts/check.sh full | tail -2"'
mk pipe; sub README.md 's/`scripts\/check.sh full`/`scripts\/check.sh full \\| tail -1`/'; sub docs/VERIFY.md 's/`scripts\/check.sh full`/`scripts\/check.sh full \\| tail -1`/'; run; expect escaped-pipe 0 'VERIFY DOC OK'

# 10 several failures are all counted
mk many; sub README.md 's/`pnpm bench:replay`/`pnpm other`/'; sub README.md 's/^| 4 | T3 |/| 4 | T2 |/'; rm "$R/docs/CLAIMS.md"; run; expect many 1 'VERIFY DOC FAIL 3'

# 11 an argument is a usage error
mk usage; set +e; OUT="$(VERIFY_ROOT="$R" "$CHECK" --bogus 2>&1)"; RC=$?; set -e
[ "$RC" -eq 2 ] || fail usage "exit $RC, want 2: $OUT"; N=$((N + 1))

echo "VERIFY DOC TESTS OK $N"
