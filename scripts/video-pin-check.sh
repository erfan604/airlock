#!/usr/bin/env bash
# AIR-249: the pin rule of the demo video. No screen shown in a captured take may have changed since the commit the take was
# recorded from. Reads <root>/video/shots.md (the status of each shot and its `pin: <40 hex> <shot ids>` lines) and
# <root>/docs/video-script.md (the SCREEN, SCREEN-FMT and SCREEN-DATA lines of AIR-248), and fails when a file that holds a string
# of a captured shot is among the files changed since that shot's pin. Used by AIR-249 (check 7), AIR-283 (check 5) and before AIR-250
# cuts. Runs under macOS /bin/bash 3.2.
# Usage: scripts/video-pin-check.sh [--root <dir>]      (default .; the folder must be the top of a git repository)
# Output: PIN CHANGED <shot> <file>, one line per changed file of a shot, then the last line PIN OK <n> shots <m> strings (exit 0)
# or PIN FAIL <k> changed (exit 1; k is the number of PIN CHANGED lines). Exit 2, with the offending line as the last line: NO PIN
# <shot> (a captured shot that is not on exactly one pin line), BAD PIN <sha> (a pin that is not 40 lower case hex digits naming a
# commit of the root), INPUT MISSING <path> (no shots.md or no script), NOT A REPO <root>; a usage error also exits 2 (stderr).
# Rules, as AIR-249 Scope writes them:
#   captured shot   a `| S.. |` row of shots.md whose status (the fourth column) is captured or fallback-replay; todo and dropped
#                   rows are ignored, as is the pin line of a shot that is not captured.
#   the strings     of a captured shot: every SCREEN <cue> "<string>" and SCREEN-FMT <cue> "<template>" line of the script whose cue is
#                   the shot id plus one letter (S04a belongs to S04, S010a does not belong to S01), and the file named by every
#                   SCREEN-DATA <cue> <file> line. The lines are read as scripts/video-script-check.ts reads them (its SCREEN and
#                   SCREEN-FMT regular expressions): the text runs from the first quote mark to the LAST quote mark that the
#                   regular expression accepts, so a string that holds a quote mark is whole. An empty string is skipped (the script
#                   checker rejects it) and so is a malformed line (the script checker names it).
#   SCREEN-FMT      the template is searched whole, placeholders included, as one fixed string. The script checker (rule
#                   screen-fmt) already requires the template, with its {name} placeholders as written, to be in the code, because
#                   the code holds the format string and not the filled text; searching only the text before the first placeholder
#                   would also match unrelated files that begin the same way.
#   the search      git grep -l -F -e <string> in the root, over the tracked files of the pathspecs web/src, 'contracts/*/src',
#                   'contracts/*/src/**', runtime/src and scripts. The ticket's list lacks the 'contracts/*/src/**' entry; without it
#                   git matches no file under contracts/<crate>/src (measured with git 2.50.1), and the script checker adds it too.
#   changed         git diff --no-renames --name-only <pin> HEAD (a rename lists both names).
#   n and m         n is the number of captured shots and m the number of SCREEN, SCREEN-FMT and SCREEN-DATA lines read for them.
# Two additions that only turn a pass into a failure, and make PIN OK mean what it says (cases 14 and 15 of the tests):
#   the search also runs in the tree of the pin, and its files count as holders, so a string edited out of its file, or a file moved
#   out of the searched folders, after the pin is a change although the search at HEAD finds nothing; and the files that differ
#   between HEAD and the work tree (git diff --name-only HEAD) count as changed, so an edit that is not committed yet is caught.
LC_ALL=C; export LC_ALL
set -euo pipefail

die() { echo "video-pin-check: $1" >&2; exit 2; }

root=.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || die "--root needs a value"; root="$2"; shift 2 ;;
    *) die "usage: scripts/video-pin-check.sh [--root <dir>]" ;;
  esac
done

SHOTS="$root/video/shots.md"
SCRIPT="$root/docs/video-script.md"
[ -f "$SHOTS" ] || { echo "INPUT MISSING $SHOTS"; exit 2; }
[ -f "$SCRIPT" ] || { echo "INPUT MISSING $SCRIPT"; exit 2; }
# the root must be the top of its own repository: git grep prints names relative to it and git diff names relative to the top, so
# a folder inside a bigger repository would compare unlike paths and pass
prefix="$(git -C "$root" rev-parse --show-prefix 2>/dev/null)" || prefix=x
[ -z "$prefix" ] || { echo "NOT A REPO $root"; exit 2; }

T="$(mktemp -d "${TMPDIR:-/tmp}/video-pin-check.XXXXXX")"   # macOS mktemp -d alone ignores TMPDIR
trap 'rm -rf "$T"' EXIT
US="$(printf '\037')"   # field separator of the temporary files (a byte no script line holds)

# captured shots with their pin: OK<US>shot<US>sha, or NOPIN<US>shot<US>number of lines (not 1) that name the shot
awk -v US="$US" '
  { line = $0; sub(/\r$/, "", line) }
  substr(line, 1, 4) == "pin:" {
    n = split(line, f)
    if (f[1] == "pin:") {
      split("", seen)
      for (i = 3; i <= n; i++) if (!(f[i] in seen)) { seen[f[i]] = 1; cnt[f[i]]++; sha[f[i]] = f[2] }
    }
    next
  }
  line ~ /^\| S[0-9]/ {
    split(line, c, "|")
    id = c[2]; st = c[4]
    gsub(/[ \t]/, "", id); gsub(/[ \t]/, "", st)
    if ((st == "captured" || st == "fallback-replay") && !(id in cap)) { cap[id] = 1; order[++no] = id }
  }
  END {
    for (i = 1; i <= no; i++) {
      id = order[i]
      if (cnt[id] == 1) print "OK" US id US sha[id]; else print "NOPIN" US id US (cnt[id] + 0)
    }
  }' "$SHOTS" > "$T/shots"

# every screen item of the script: S<US>cue<US>string, F<US>cue<US>template or D<US>cue<US>file
awk -v US="$US" '
  # cut(rest, tail): rest starts after the opening quote mark; the text ends at the last quote mark whose remainder matches tail
  function cut(rest, tail,    i) {
    for (i = length(rest); i >= 1; i--)
      if (substr(rest, i, 1) == "\"" && substr(rest, i + 1) ~ tail) { TXT = substr(rest, 1, i - 1); return 1 }
    return 0
  }
  { line = $0; sub(/\r$/, "", line) }
  substr(line, 1, 11) == "SCREEN-FMT " {
    if (match(line, /^SCREEN-FMT [^ \t]+ "/)) {
      split(substr(line, 1, RLENGTH), a, " ")
      if (cut(substr(line, RLENGTH + 1), "^([ \t]+[A-Za-z_][A-Za-z0-9_]*=[^ \t]*)*[ \t]*$") && TXT != "") print "F" US a[2] US TXT
    }
    next
  }
  substr(line, 1, 12) == "SCREEN-DATA " {
    if (match(line, /^SCREEN-DATA [^ \t]+ [^ \t]+([ \t].*)?$/)) { split(line, a); print "D" US a[2] US a[3] }
    next
  }
  substr(line, 1, 7) == "SCREEN " {
    if (match(line, /^SCREEN [^ \t]+ "/)) {
      split(substr(line, 1, RLENGTH), a, " ")
      if (cut(substr(line, RLENGTH + 1), "^[ \t]*$") && TXT != "") print "S" US a[2] US TXT
    }
  }' "$SCRIPT" > "$T/items"

# NO PIN and BAD PIN end the run before anything is compared
bad=0; badseen=" "
while IFS="$US" read -r kind id sha; do
  if [ "$kind" = NOPIN ]; then
    echo "NO PIN $id"; bad=1; continue
  fi
  ok=1
  case "$sha" in *[!0-9a-f]*) ok=0 ;; esac
  [ "${#sha}" -eq 40 ] || ok=0
  if [ "$ok" = 1 ] && ! git -C "$root" cat-file -e "$sha^{commit}" < /dev/null 2>/dev/null; then ok=0; fi
  if [ "$ok" = 0 ]; then
    case "$badseen" in *" $sha "*) ;; *) echo "BAD PIN $sha"; badseen="$badseen$sha " ;; esac
    bad=1
  fi
done < "$T/shots"
[ "$bad" = 0 ] || exit 2

SEARCH=(web/src 'contracts/*/src' 'contracts/*/src/**' runtime/src scripts)

# gg <string> <commit or empty>: append to $T/h the names of the tracked files that hold the string (at that commit, if one is given)
gg() {
  local rc=0
  if [ -n "$2" ]; then
    git -C "$root" grep -z -l -F -e "$1" "$2" -- "${SEARCH[@]}" < /dev/null > "$T/gg" || rc=$?
  else
    git -C "$root" grep -z -l -F -e "$1" -- "${SEARCH[@]}" < /dev/null > "$T/gg" || rc=$?
  fi
  [ "$rc" -le 1 ] || die "git grep exited $rc"   # 1 is no file; a bad pathspec or option is more
  if [ -n "$2" ]; then tr '\0' '\n' < "$T/gg" | sed "s/^$2://" >> "$T/h"; else tr '\0' '\n' < "$T/gg" >> "$T/h"; fi
}

# changed <sha>: print the path of the file that lists the files changed since the pin (made once per pin)
changed() {
  local f="$T/changed.$1"
  if [ ! -f "$f" ]; then
    git -C "$root" diff --no-renames -z --name-only "$1" HEAD -- < /dev/null > "$T/d1" || die "git diff failed for $1"
    git -C "$root" diff --no-renames -z --name-only HEAD -- < /dev/null > "$T/d2" || die "git diff failed for HEAD"
    cat "$T/d1" "$T/d2" | tr '\0' '\n' > "$f"
  fi
  echo "$f"
}

# listed <name> <file>: is the name a whole line of the file
listed() {
  local l
  while IFS= read -r l; do [ "$l" = "$1" ] && return 0; done < "$2"
  return 1
}

n=0; m=0; k=0; printed="$US"
while IFS="$US" read -r kind id sha; do
  n=$((n + 1))
  list="$(changed "$sha")"
  while IFS="$US" read -r ikind cue text; do
    case "$cue" in "$id"[A-Za-z]) ;; *) continue ;; esac
    m=$((m + 1))
    : > "$T/h"
    if [ "$ikind" = D ]; then
      while [ "${text#./}" != "$text" ]; do text="${text#./}"; done
      echo "$text" > "$T/h"
    else
      gg "$text" ""
      gg "$text" "$sha"
    fi
    sort -u "$T/h" > "$T/hu"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      listed "$f" "$list" || continue
      case "$printed" in *"$US$id $f$US"*) continue ;; esac
      printed="$printed$id $f$US"
      echo "PIN CHANGED $id $f"
      k=$((k + 1))
    done < "$T/hu"
  done < "$T/items"
done < "$T/shots"

if [ "$k" -gt 0 ]; then
  echo "PIN FAIL $k changed"
  exit 1
fi
echo "PIN OK $n shots $m strings"
