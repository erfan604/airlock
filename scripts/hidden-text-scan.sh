#!/usr/bin/env bash
# AIR-286 (D6 of the readiness doc): fail on text a human reader cannot see but a model reads.
# Scans README.md, AGENTS.md, CLAUDE.md and every tracked docs/*.md for U+200B to U+200F, U+202A to U+202E, U+2060 and
# U+FEFF, and for any HTML comment that is not one of the generated-section markers other tickets write:
# bench:start, bench:end (README, AIR-255), BEGIN GENERATED, END GENERATED, BEGIN SUITE <name>, END SUITE <name>
# (docs/BENCH.md, AIR-220, AIR-229, AIR-231), harness-table:start|end, theorem-list:start|end (docs/CLAIMS.md, AIR-028),
# plumbing:start|end (docs/PLUMBING.md, AIR-241).
# Prints each hit as <path>:<line>, then HIDDEN TEXT OK (exit 0) or HIDDEN TEXT FOUND <n> (exit 1).
# Usage: scripts/hidden-text-scan.sh   (SCAN_ROOT overrides the repo root, for the tests)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCAN_ROOT:-$here/..}"
files=""
for f in README.md AGENTS.md CLAUDE.md; do [ -f "$f" ] && files="$files $f"; done
tracked="$(git ls-files -- 'docs/*.md' 2>/dev/null || true)"
# shellcheck disable=SC2086
hits="$(perl -CSD -nle '
  my $bad = /[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}]/;
  if (!$bad && /<!--/) {
    my $ok = !/<!--(?![^\n]*-->)/;   # an unclosed comment on the line is a hit
    while (/<!--(.*?)-->/g) {
      $ok = 0 unless $1 =~ /^\s*(?:bench:(?:start|end)|(?:BEGIN|END) GENERATED|(?:BEGIN|END) SUITE [A-Za-z0-9_-]+|(?:harness-table|theorem-list|plumbing):(?:start|end))\s*$/;
    }
    $bad = !$ok;
  }
  print "$ARGV:$." if $bad;
  close ARGV if eof;
' $files $tracked)"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "HIDDEN TEXT FOUND $(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  exit 1
fi
echo "HIDDEN TEXT OK"
