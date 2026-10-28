#!/usr/bin/env bash
# AIR-286: fixture tests of scripts/hidden-text-scan.sh. Each case builds a scratch git repo with one tracked doc.
# Planted characters are built at run time, so this file holds none of them.
# Last line: HIDDEN TEXT TESTS OK <n>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN="$here/hidden-text-scan.sh"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$SCAN" ] || fail setup "scripts/hidden-text-scan.sh is missing or not executable"
N=0
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
zwsp=$(printf '\342\200\213'); rlo=$(printf '\342\200\256'); bom=$(printf '\357\273\277'); wj=$(printf '\342\201\240')

repo() {   # repo <name> <docs/x.md content>: a scratch repo with README, AGENTS, CLAUDE and one tracked doc
  R="$W/$1"; mkdir -p "$R/docs"
  printf '# T\n\nPlain text.\n' > "$R/README.md"; printf 'agents\n' > "$R/AGENTS.md"; printf 'claude\n' > "$R/CLAUDE.md"
  printf '%s\n' "$2" > "$R/docs/x.md"
  git -C "$R" init -q && git -C "$R" add README.md AGENTS.md CLAUDE.md docs/x.md
}
run() { set +e; OUT="$(SCAN_ROOT="$R" "$SCAN" 2>&1)"; RC=$?; set -e; }
expect_found() {  # expect_found <case> <path:line>
  [ "$RC" -eq 1 ] || fail "$1" "exit $RC, want 1: $OUT"
  printf '%s\n' "$OUT" | grep -qx "$2" || fail "$1" "no '$2' line: $OUT"
  printf '%s\n' "$OUT" | tail -1 | grep -qE '^HIDDEN TEXT FOUND [1-9][0-9]*$' || fail "$1" "last line: $(printf '%s\n' "$OUT" | tail -1)"
  N=$((N + 1))
}

repo clean "$(printf 'Clean text.\n<!-- bench:start -->\n<!-- BEGIN SUITE adaptive -->\n<!-- harness-table:end -->\n<!-- plumbing:start -->\n<!-- END GENERATED -->')"; run
[ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$OUT" | tail -1)" = "HIDDEN TEXT OK" ] || fail clean "allowed markers must pass: $RC $OUT"; N=$((N + 1))
repo zwsp "a${zwsp}b"; run; expect_found zwsp 'docs/x.md:1'
repo bidi "line one
x${rlo}y"; run; expect_found bidi 'docs/x.md:2'
repo bom "${bom}starts with a byte order mark"; run; expect_found bom 'docs/x.md:1'
repo wj "word${wj}joiner"; run; expect_found word-joiner 'docs/x.md:1'
repo comment "text
<!-- note for the reader -->"; run; expect_found comment 'docs/x.md:2'
# an untracked doc is not scanned (only tracked docs/*.md), the root files always are
repo untracked "fine"; printf 'a%sb\n' "$zwsp" > "$R/docs/new.md"; run
[ "$RC" -eq 0 ] || fail untracked "an untracked doc must not be scanned: $OUT"; N=$((N + 1))
repo root "fine"; printf '# T\n<!-- hidden -->\n' > "$R/README.md"; run; expect_found root-file 'README.md:2'
echo "HIDDEN TEXT TESTS OK $N"
