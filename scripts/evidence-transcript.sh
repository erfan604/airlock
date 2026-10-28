#!/usr/bin/env bash
# AIR-285: runs one command and writes its output as a committed proof transcript, docs/evidence/<name>.txt (or
# $EVIDENCE_DIR/<name>.txt when that variable is set; a relative path is taken from the current directory), so a reader in a
# read-only or no-install sandbox can see the command pass. scripts/g5-check.sh --record calls it five times inside the fresh clone.
# Usage: scripts/evidence-transcript.sh <name> -- <command...>     (run inside the repository or clone the commit belongs to)
# The file has three kinds of lines:
#   line 1  sha=<40 hex of HEAD> date=<UTC as YYYY-MM-DDTHH:MM:SSZ, taken before the command starts> tools=node=<v> pnpm=<v> rustc=<v>
#           kani=<v> lake=<v>  (one line; none for a tool that is not on the PATH, unknown for a version that cannot be read)
#   line 2  cmd=<the command, its words joined by spaces>, or the text of EVIDENCE_CMD_LABEL when that variable is not empty (for output
#           that was captured earlier, so the label can say what the output is; g5-check.sh uses it for check-full-tail)
#   then    the combined stdout and stderr of the command, with: carriage returns dropped, ANSI escapes stripped, every line that holds
#           KEY=, TOKEN=, SECRET= or PASSWORD= followed by a value (any case) replaced by <redacted>, the home directory written as ~,
#           host names written as <host> and user names as <user> (names of three or more characters), and an output of more than
#           220 lines cut to its first 20 and last 200 lines with one "... <n> lines omitted" line between
#   last    exit=<code>
# The cmd line goes through the same filters. The redaction is a safety net: the real protection is that the fresh clone has no key
# file, and scripts/evidence-check-transcripts.sh refuses any file with /Users/ or /home/ in it.
# The helper exits with the command's own code and writes the file also when the command fails. While the command runs its output is
# also printed here, then one line "evidence-transcript: wrote <file> (exit=<code>)". The file replaces an earlier one of that name in
# one step. Exit 2 (nothing run, nothing written) for a usage error, a name that is not a plain file name, a directory that is not a git
# repository with a commit, or an output folder that cannot be made. The command reads no input (stdin is /dev/null).
# Bash 3.2 compatible (macOS /bin/bash), BSD tools only.
set -euo pipefail

usage() { echo "usage: scripts/evidence-transcript.sh <name> -- <command...>" >&2; exit 2; }

[ "$#" -ge 3 ] || usage
NAME=$1
[ "$2" = "--" ] || usage
shift 2
case "$NAME" in ''|.*|*[!A-Za-z0-9._-]*) usage;; esac   # a plain file name: no slash, so the file cannot leave its folder

KEEP_HEAD=20
KEEP_TAIL=200

SHA=$(git rev-parse HEAD 2>/dev/null || true)
if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "evidence-transcript: no commit here, so there is no sha for the header (run it inside the repository or the fresh clone)" >&2
  exit 2
fi

DIR=${EVIDENCE_DIR:-docs/evidence}
DEST="$DIR/$NAME.txt"
WORK=""
PART=""
cleanup() {
  [ -z "$PART" ] || rm -f "$PART"
  case "$WORK" in */evidence-transcript.*) rm -rf "$WORK";; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$DIR" 2>/dev/null && [ -w "$DIR" ] || { echo "evidence-transcript: cannot write into $DIR" >&2; exit 2; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/evidence-transcript.XXXXXX") || { echo "evidence-transcript: no temp directory" >&2; exit 2; }
RAW="$WORK/raw"
SAN="$WORK/sanitized"

# the home directory without trailing slashes; empty when it is unset or the root, which would match every slash
HOME_DIR=${HOME:-}
while [ "${#HOME_DIR}" -gt 1 ] && [ "${HOME_DIR%/}" != "$HOME_DIR" ]; do HOME_DIR=${HOME_DIR%/}; done
[ "${#HOME_DIR}" -gt 1 ] || HOME_DIR=""

# names_by_length <name>...: the names of three or more characters, longest first, one per line (a name inside another goes second)
names_by_length() {
  local n
  for n in "$@"; do
    if [ "${#n}" -ge 3 ]; then printf '%s\n' "$n"; fi
  done | awk '{ print length($0) "\t" $0 }' | sort -rn | cut -f2- | uniq
}
HOSTS=$(names_by_length "$(hostname 2>/dev/null || true)" "$(hostname -s 2>/dev/null || true)")
USERS=$(names_by_length "${USER:-}" "${LOGNAME:-}" "$(id -un 2>/dev/null || true)")

# sanitize: stdin to stdout, the filters of the header comment in that order, byte by byte (LC_ALL=C: output that is not valid UTF-8
# must not stop the run). The names travel in the environment, not in -v, which would process backslashes. The home directory is replaced only where the next character does not continue a folder name.
sanitize() {
  LC_ALL=C tr -d '\r' | LC_ALL=C EVT_HOME="$HOME_DIR" EVT_HOSTS="$HOSTS" EVT_USERS="$USERS" awk '
    function repl(s, from, to, bounded,    out, i, rest) {
      out = ""
      while ((i = index(s, from)) > 0) {
        rest = substr(s, i + length(from))
        if (bounded && substr(rest, 1, 1) ~ /[A-Za-z0-9_-]/) out = out substr(s, 1, i - 1 + length(from))
        else out = out substr(s, 1, i - 1) to
        s = rest
      }
      return out s
    }
    BEGIN {
      csi = "\033\\[[0-9;?]*[ -/]*[@-~]"
      osc = "\033\\][^\007\033]*(\007|\033\\\\)"
      cs2 = "\033[()*+][0-9A-Za-z]"
      home = ENVIRON["EVT_HOME"]
      nh = split(ENVIRON["EVT_HOSTS"], hosts, "\n")
      nu = split(ENVIRON["EVT_USERS"], users, "\n")
    }
    {
      line = $0
      gsub(csi, "", line)
      gsub(osc, "", line)
      gsub(cs2, "", line)
      gsub("\033", "", line)
      if (tolower(line) ~ /(key|token|secret|password)=[^ \t]/) { print "<redacted>"; next }
      if (home != "") line = repl(line, home, "~", 1)
      for (k = 1; k <= nh; k++) if (hosts[k] != "") line = repl(line, hosts[k], "<host>", 0)
      for (k = 1; k <= nu; k++) if (users[k] != "") line = repl(line, users[k], "<user>", 0)
      print line
    }'
}

# tool_version <label> <line pattern> <command...>: label=<the first version number on the first line of the command's output that matches
# the pattern (grep -iE)>, none when the command's first word is not on the PATH, unknown when no such number is found
tool_version() {
  local label=$1 pat=$2 v
  shift 2
  if ! command -v "$1" > /dev/null 2>&1; then printf '%s=none' "$label"; return 0; fi
  v=$("$@" < /dev/null 2>&1 | grep -iE -e "$pat" | sed -n -E 's/^[^0-9]*([0-9]+\.[0-9]+[0-9A-Za-z._+-]*).*/\1/p' | head -n 1) || true
  printf '%s=%s' "$label" "${v:-unknown}"
}

DATE=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
TOOLS="$(tool_version node '^v?[0-9]' node --version) $(tool_version pnpm '^[0-9]' pnpm --version) $(tool_version rustc '^rustc' rustc --version)"
TOOLS="$TOOLS $(tool_version kani kani cargo kani --version) $(tool_version lake '^lake' lake --version)"
CMDTXT="${EVIDENCE_CMD_LABEL:-$*}"
CMDTXT=${CMDTXT//$'\n'/ }

RC=0
"$@" < /dev/null 2>&1 | tee "$RAW" || RC=${PIPESTATUS[0]}
# the "wrote" line below must not be glued to an output that ended without a newline
if [ -s "$RAW" ] && [ -n "$(tail -c 1 "$RAW")" ]; then echo; fi

sanitize < "$RAW" > "$SAN"
CMDLINE=$(printf '%s\n' "$CMDTXT" | sanitize | head -n 1)
LINES=$(wc -l < "$SAN" | tr -d ' ')
PART=$(mktemp "$DIR/.$NAME.XXXXXX") || { echo "evidence-transcript: cannot write into $DIR" >&2; exit 2; }
{
  printf 'sha=%s date=%s tools=%s\n' "$SHA" "$DATE" "$TOOLS"
  printf 'cmd=%s\n' "$CMDLINE"
  if [ "$LINES" -gt $((KEEP_HEAD + KEEP_TAIL)) ]; then
    head -n "$KEEP_HEAD" "$SAN"
    printf '... %s lines omitted\n' "$((LINES - KEEP_HEAD - KEEP_TAIL))"
    tail -n "$KEEP_TAIL" "$SAN"
  else
    cat "$SAN"
  fi
  printf 'exit=%s\n' "$RC"
} > "$PART"
chmod 644 "$PART"
mv -f "$PART" "$DEST"
PART=""
printf 'evidence-transcript: wrote %s (exit=%s)\n' "$DEST" "$RC"
exit "$RC"
