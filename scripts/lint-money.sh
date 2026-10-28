#!/usr/bin/env bash
# AIR-004: money-path lint, run by `scripts/check.sh quick` (step lint-money).
#   R1  f32 or f64 in contracts/*/src/**/*.rs
#   T1  Number(   T2 parseFloat   T3 parseInt   T4 BigInt(...) holding a decimal literal, an exponent literal or a lone *
#       in *.ts *.tsx *.mts *.js *.mjs under the directories of scripts/lint-money.dirs (node_modules and dist skipped)
# Text based, so a match in a comment or a string counts. A line ending in `// money-lint-allow: <reason>` is exempt.
# grep -E only: rg is not a binary on this Mac and BSD grep has no -P. Bash 3.2 compatible (macOS /bin/bash).
# Usage: scripts/lint-money.sh   (LINT_ROOT overrides the repo root, for the tests)
# Exit 0 clean, 1 on any violation, 2 on a usage error.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LINT_ROOT:-$(cd "$here/.." && pwd)}"
[ "$#" -eq 0 ] || { echo "usage: scripts/lint-money.sh (no arguments; LINT_ROOT overrides the root)" >&2; exit 2; }
cd "$ROOT"
[ -f scripts/lint-money.dirs ] || { echo "no dirs file: $ROOT/scripts/lint-money.dirs"; exit 2; }

ALLOW='// money-lint-allow: .*[^[:space:]][[:space:]]*$'
R1='\b(f32|f64)\b'
T1='\bNumber[[:space:]]*\('
T2='\bparseFloat\b'
T3='\bparseInt\b'
T4='BigInt[[:space:]]*\([^)]*([0-9]\.[0-9]|[0-9][eE][0-9]|[^*]\*[^*])'

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
: > "$work/dirs"; : > "$work/files"; : > "$work/viol"; : > "$work/exempt"

# the directory list: comments and blank lines ignored, duplicates read once, order kept
while IFS= read -r line || [ -n "$line" ]; do
  line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$line" in ''|'#'*) continue ;; esac
  grep -qxF -- "$line" "$work/dirs" || printf '%s\n' "$line" >> "$work/dirs"
done < scripts/lint-money.dirs
ndirs=$(wc -l < "$work/dirs" | tr -d ' ')

while IFS= read -r d; do
  if [ -e "$d" ]; then
    echo "$d"
    if [ -f "$d" ]; then
      case "$d" in *.ts|*.tsx|*.mts|*.js|*.mjs) printf 'T %s\n' "$d" >> "$work/files" ;; esac
    else
      find "$d" \( -name node_modules -o -name dist \) -prune -o -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' \) -print \
        | LC_ALL=C sort | sed 's/^/T /' >> "$work/files"
    fi
  else
    echo "$d (absent)"
  fi
done < "$work/dirs"
if [ -d contracts ]; then
  find contracts -path '*/src/*' -type f -name '*.rs' | LC_ALL=C sort | sed 's/^/R /' >> "$work/files"
fi

check() {   # check <file> <rule id> <pattern>: one violation per matching line, unless the line carries the allow comment
  local f="$1" id="$2" pat="$3" hit n text reason
  { grep -nE -- "$pat" "$f" 2>/dev/null || true; } | while IFS= read -r hit; do   # no match is not an error
    n="${hit%%:*}"; text="${hit#*:}"
    if printf '%s\n' "$text" | grep -qE -- "$ALLOW"; then
      reason="$(printf '%s\n' "$text" | sed 's|.*// money-lint-allow: ||;s/[[:space:]]*$//')"
      printf 'EXEMPT %s:%s: %s\n' "$f" "$n" "$reason" >> "$work/exempt"
    else
      printf '%s:%s: rule %s\n' "$f" "$n" "$id" >> "$work/viol"
    fi
  done
}
# dedupe file entries (a file can sit in two listed directories)
LC_ALL=C sort -u "$work/files" -o "$work/files"
while IFS= read -r entry; do
  kind="${entry%% *}"; f="${entry#* }"
  if [ "$kind" = R ]; then
    check "$f" R1 "$R1"
  else
    check "$f" T1 "$T1"; check "$f" T2 "$T2"; check "$f" T3 "$T3"; check "$f" T4 "$T4"
  fi
done < "$work/files"

# violations by file, then line, then rule; an exempt line is listed once even when several rules matched it
LC_ALL=C sort -t: -k1,1 -k2,2n -k3 "$work/viol"
LC_ALL=C sort -u "$work/exempt" | LC_ALL=C sort -t: -k1,1 -k2,2n
nv=$(wc -l < "$work/viol" | tr -d ' ')
if [ "$nv" -eq 0 ]; then
  echo "LINT OK ($ndirs directories, 0 violations)"
else
  echo "LINT FAILED ($nv violations)"
  exit 1
fi
