#!/usr/bin/env bash
# Fixture tests for scripts/evidence-transcript.sh, scripts/evidence-check-transcripts.sh and the --record wiring of
# scripts/g5-check.sh (AIR-285). Written before the scripts: with them missing it prints EVIDENCE TRANSCRIPT TESTS FAILED.
# Helper cases (1 to 15) run the helper in a scratch git repository under mktemp -d with stub tools (node, pnpm, rustc, cargo, lake,
# hostname) first on the PATH, HOME and USER set to fixture values and EVIDENCE_DIR in the scratch tree:
#   1 header (line 1 with a 40 hex sha equal to HEAD, a UTC date taken during the run, tools=), line 2 cmd=, the raw output, exit=0
#   2 the tools line: five versions read from the stubs, none for a tool that is not on the PATH, unknown for an unreadable version
#   3 ANSI escapes stripped (colours, cursor moves, OSC titles and links, charset selectors), no ESC byte left
#   4 the home directory written as ~ in the output and in the cmd line, not inside a longer name, never for HOME=/ or no HOME
#   5 the user and host names removed, a name of two characters left alone
#   6 a line with KEY=, TOKEN=, SECRET= or PASSWORD= and a value replaced by <redacted> (any case), a bare KEY= and KEYS=1 kept
#   7 a 500 line output cut to its first 20 and last 200 lines with one "... 280 lines omitted" line between
#   8 the cut boundary: 220 lines are kept whole, 221 lines lose one
#   9 a failing command: the file is written, ends with exit=1 (exit=3 for 3), the helper exits with the same code, stderr is in the file
#  10 a command that does not exist: exit 127, file written
#  11 stdout and stderr in order, a last line without a newline, a newline inside an argument, CRLF line ends, input piped to the helper
#     not reaching the command, bytes that are not valid UTF-8
#  12 usage errors and a directory that is not a git repository: exit 2, no file, the command never ran
#  13 docs/evidence of the current directory when EVIDENCE_DIR is unset, a nested EVIDENCE_DIR is created, a second run replaces the file
#  14 EVIDENCE_CMD_LABEL replaces the cmd= text (for output captured earlier)
#  15 the command's output also reaches the helper's own stdout while it runs, then one "wrote" line
# --record cases (16 to 22) build a bare origin, a working repository holding the real g5-check.sh, fresh-clone-check.sh,
# evidence-transcript.sh and evidence-check-transcripts.sh and stubs for everything else (as scripts/test-fresh-clone.sh does), run with
# FRESH_CLONE_SKIP_INSTALL=1 and G5_TEST_MODE=1 (no lockfile, no network):
#  16 --record writes exactly five files into docs/evidence of the working repository, each naming the clone's sha, with the right cmd=
#     line, the stub's last lines, home and secrets redacted, check.sh called twice only (no second full run), TMPDIR empty; the checker
#     then passes on the committed result
#  17 a second --record replaces the five files (new sha), still five, also when it is started from another folder
#  18 a run without --record writes nothing and calls none of the record commands
# The record cases 16, 17 and 19 to 22 run --record --transcripts; case 32 covers --record alone and --transcripts alone.
#  19 each of the four commands failing: exit 1, last line G5 FAIL record, its transcript written and ending exit=1, no later command ran,
#     docs/EVIDENCE.md untouched, TMPDIR empty; a TMPDIR folder that turned read-only before the record: nothing published
#  20 each script missing: the run says so, names it, runs nothing, writes nothing, ends G5 FAIL record, TMPDIR empty
#  21 G5_LEAN_CMD stands in for scripts/lean-axioms.sh (the D1 lake command)
#  22 EVIDENCE_DIR (absolute and relative, also when the run starts in another folder) says where the five files go
# Checker cases (23 to 31) use scratch repositories with the real checker, a payload-scan stub and hand-written transcripts:
#  23 five good transcripts, docs-only distance: EVIDENCE TRANSCRIPTS OK sha=<sha>; a tag works as the reference
#  24 README.md, files under docs/ and video/x-post.txt may change after the recorded sha
#  25 a code change after the sha fails (and so do look-alike paths, a deleted code file and a rename of code into docs/)
#  26 each of the five files missing fails
#  27 a header sha that git does not find fails; a header without sha= fails
#  28 headers with two different shas fail
#  29 a file that does not end with exit=0 fails (exit=1, no exit line)
#  30 payload-scan.sh failing fails
#  31 /Users/ or /home/ in any file of docs/evidence fails; usage error exits 2; a tag with a code change fails while HEAD of docs passes
# Usage: scripts/test-evidence-transcript.sh     (any directory; the scripts under test sit next to this file)
# Last line: EVIDENCE TRANSCRIPT TESTS OK <n>   (n cases)
set -uo pipefail

SELF=$(cd "$(dirname "$0")" && pwd -P)
HELPER="$SELF/evidence-transcript.sh"
CHECKER="$SELF/evidence-check-transcripts.sh"
G5_SCRIPT="$SELF/g5-check.sh"
CLONE_SCRIPT="$SELF/fresh-clone-check.sh"
TOTAL_CASES=32
OK=0
CLEAN=""
T=""
R=""
EV=""
OUT=""
RC=0
BAD=""
trap 'for d in $CLEAN; do case "$d" in */evt.*) rm -rf "$d";; esac; done' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

for f in "$HELPER" "$CHECKER" "$G5_SCRIPT" "$CLONE_SCRIPT"; do
  if [ ! -f "$f" ]; then
    echo "missing $f"
    echo "EVIDENCE TRANSCRIPT TESTS FAILED (0 of $TOTAL_CASES ok)"
    exit 1
  fi
done

git_as() {
  env GIT_AUTHOR_NAME=erfan-7116 GIT_AUTHOR_EMAIL=erfan@welcomeaide.com \
    GIT_COMMITTER_NAME=erfan-7116 GIT_COMMITTER_EMAIL=erfan@welcomeaide.com git "$@"
}

# ---- assertions: each prints nothing and returns 0 or 1; chk records a failure under its description ----
chk() { local d=$1; shift; "$@" || BAD="$BAD [$d]"; }
rc_is() { [ "$RC" -eq "$1" ]; }
has() { grep -Eq -e "$1" <<<"$OUT"; }
lacks() { ! grep -Eq -e "$1" <<<"$OUT"; }
has_line() { grep -qxF -e "$1" <<<"$OUT"; }
last_is() { [ "$(printf '%s\n' "$OUT" | tail -n 1)" = "$1" ]; }
last_has() { printf '%s\n' "$OUT" | tail -n 1 | grep -Eq -e "$1"; }
fline() { sed -n "$2p" "$1"; }                  # fline <file> <n>: line n of the file
flast() { tail -n 1 "$1"; }
fcount() { wc -l < "$1" | tr -d ' '; }
fhas() { grep -qF -e "$2" "$1"; }               # fhas <file> <text>: the file holds the text on some line
fhas_line() { grep -qxF -e "$2" "$1"; }         # the file holds the text as a whole line
flacks() { ! grep -qF -e "$2" "$1"; }
nlines_is() { [ "$(fcount "$1")" = "$2" ]; }
tmp_empty() { [ -z "$(ls -A "$T/tmp")" ]; }
in_ok() { local d=$1; shift; ( cd "$d" && "$@" ) >/dev/null 2>&1; }
between() { [[ ! "$1" < "$2" && ! "$1" > "$3" ]]; }   # between <value> <low> <high>: low <= value <= high, as strings
no_esc() { ! LC_ALL=C grep -q "$(printf '\033')" "$1"; }

end_case() { # n description
  if [ -z "$BAD" ]; then
    OK=$((OK + 1))
    echo "PASS case $1: $2"
  else
    echo "FAIL case $1: $2:$BAD"
    printf '%s\n' "$OUT" | tail -25 | sed 's/^/    | /'
  fi
}

# ---- helper fixtures ----
# mkhelper: T with a scratch repository (one commit), stub tools in bin, an empty home, and the TMPDIR folder tmp
mkhelper() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/evt.XXXXXX") || exit 1
  CLEAN="$CLEAN $T"
  mkdir "$T/tmp" "$T/bin" "$T/home" "$T/plain"
  R="$T/repo"
  git init -q "$R" || exit 1
  ( cd "$R" && : > f.txt && git add f.txt && git_as commit -q -m "fixture" ) || exit 1
  SHA=$(git -C "$R" rev-parse HEAD)
  printf '%s\n' '#!/bin/sh' 'echo v24.0.1' > "$T/bin/node"
  printf '%s\n' '#!/bin/sh' 'echo 10.2.3' > "$T/bin/pnpm"
  printf '%s\n' '#!/bin/sh' 'echo "rustc 1.86.0 (05f9846f8 2025-03-31)"' > "$T/bin/rustc"
  printf '%s\n' '#!/bin/sh' 'case "$*" in "kani --version") echo "cargo-kani 0.68.0";; *) echo "error: no such command" >&2; exit 101;; esac' > "$T/bin/cargo"
  printf '%s\n' '#!/bin/sh' 'echo "Lake version 5.0.0-abc123 (Lean (version 4.12.0, arm64-apple-darwin, commit abc, Release))"' > "$T/bin/lake"
  printf '%s\n' '#!/bin/sh' 'case "${1:-}" in -s) echo fixturehost;; *) echo fixturehost.example;; esac' > "$T/bin/hostname"
  chmod +x "$T/bin/"*
}

# hrun <helper arguments>: the helper in the scratch repository, writing into $EV, with the stub tools first on the PATH; sets OUT and RC
hrun() {
  OUT=$(cd "$R" && env -u EVIDENCE_CMD_LABEL EVIDENCE_DIR="$EV" HOME="$T/home" USER=fixtureuser TMPDIR="$T/tmp" PATH="$T/bin:$PATH" \
    "$HELPER" "$@" 2>&1)
  RC=$?
}

echo "evidence transcript tests (scratch repositories, stub tools, no network)"

# ---- case 1 ----
echo "case 1: header, cmd line, output and exit line"
mkhelper
BAD=""
EV="$T/ev"
BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
hrun demo -- echo hello world
AFTER=$(date -u +%Y-%m-%dT%H:%M:%SZ)
F="$EV/demo.txt"
chk "exit 0" rc_is 0
chk "the file exists" test -f "$F"
chk "line 1 is sha=<40 hex> date=<UTC> tools=" grep -Eq '^sha=[0-9a-f]{40} date=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z tools=.+$' <(fline "$F" 1)
chk "the sha is HEAD of the repository" test "$(fline "$F" 1 | sed -n 's/^sha=\([0-9a-f]*\) .*/\1/p')" = "$SHA"
D=$(fline "$F" 1 | sed -n 's/^sha=[0-9a-f]* date=\([^ ]*\) tools=.*/\1/p')
chk "the date was taken during the run" between "$D" "$BEFORE" "$AFTER"
chk "the header is one line" test "$(fline "$F" 1 | wc -l | tr -d ' ')" = 1
chk "lines 2 to the end are cmd=, the output, exit=0" test "$(sed -n '2,$p' "$F")" = "$(printf 'cmd=echo hello world\nhello world\nexit=0')"
chk "four lines in all" nlines_is "$F" 4
end_case 1 "line 1 sha=, date=, tools=; line 2 cmd=; the output; exit=0"

# ---- case 2 ----
echo "case 2: the tools line"
mkhelper
BAD=""
EV="$T/ev"
hrun demo -- true
chk "five versions read from the stubs" test "$(fline "$EV/demo.txt" 1 | sed 's/^.* tools=//')" = 'node=24.0.1 pnpm=10.2.3 rustc=1.86.0 kani=0.68.0 lake=5.0.0-abc123'
mkdir "$T/bin2"
cp "$T/bin/node" "$T/bin2/node"
printf '%s\n' '#!/bin/sh' 'echo "no version in here"' > "$T/bin2/pnpm"
chmod +x "$T/bin2/pnpm"
OUT=$(cd "$R" && env EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin2:/usr/bin:/bin" "$HELPER" demo2 -- true 2>&1)
RC=$?
chk "second run exit 0" rc_is 0
chk "tools that are not on the PATH read none, an unreadable version reads unknown" test "$(fline "$EV/demo2.txt" 1 | sed 's/^.* tools=//')" = 'node=24.0.1 pnpm=unknown rustc=none kani=none lake=none'
end_case 2 "node pnpm rustc kani lake on one line, none and unknown"

# ---- case 3 ----
echo "case 3: ANSI escapes stripped"
mkhelper
BAD=""
EV="$T/ev"
hrun ansi -- printf '\033[31mred\033[0m \033[1;32mgreen\033[0m\n\033[2K\033[1Gcleared\n\033]0;title\007osc\n\033(Bcharset\n\033]8;;http://x\033\\link\033]8;;\033\\\n\033[?25lhidden cursor\n'
F="$EV/ansi.txt"
sed -n '3,$p' "$F" > "$T/ansi.out"       # the cmd= line shows the printf text as typed, so only the output lines are judged
chk "exit 0" rc_is 0
chk "no ESC byte is left in the file" no_esc "$F"
chk "six output lines" test "$(sed '$d' "$T/ansi.out" | wc -l | tr -d ' ')" = 6
chk "the colour codes are gone, the text stays" fhas_line "$T/ansi.out" 'red green'
chk "cursor and erase codes are gone" fhas_line "$T/ansi.out" 'cleared'
chk "an OSC title ended by BEL is gone" fhas_line "$T/ansi.out" 'osc'
chk "a charset selector is gone" fhas_line "$T/ansi.out" 'charset'
chk "an OSC link ended by ESC backslash is gone" fhas_line "$T/ansi.out" 'link'
chk "a private mode code is gone" fhas_line "$T/ansi.out" 'hidden cursor'
chk "nothing of the escape bodies is left" flacks "$T/ansi.out" '[31m'
chk "the title text is gone" flacks "$T/ansi.out" 'title'
chk "the link target is gone" flacks "$T/ansi.out" 'http://x'
end_case 3 "colours, cursor moves, OSC with BEL or ST, charset: stripped, text kept"

# ---- case 4 ----
echo "case 4: the home directory is written as ~"
mkhelper
BAD=""
EV="$T/ev"
H="$T/home"
cat > "$T/home.sh" <<EOF
echo $H/.cargo/bin
echo "$H/"
echo "in $H and $H/x"
echo "${H}x/keep"
echo "${H}-other/keep"
EOF
hrun home -- sh "$T/home.sh"
F="$EV/home.txt"
chk "exit 0" rc_is 0
chk "a path under HOME starts with ~" fhas_line "$F" '~/.cargo/bin'
chk "HOME with a trailing slash" fhas_line "$F" '~/'
chk "every occurrence on a line" fhas_line "$F" 'in ~ and ~/x'
chk "a longer folder name that starts like HOME is not cut" fhas_line "$F" "${H}x/keep"
chk "a hyphenated sibling is not cut" fhas_line "$F" "${H}-other/keep"
OUT=$(cd "$R" && env EVIDENCE_DIR="$EV" HOME=/ TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" root -- echo /usr/bin /.cache/x a//b / 2>&1)
RC=$?
chk "HOME=/ would match every slash and is not used: exit 0" rc_is 0
chk "HOME=/ leaves paths alone" fhas_line "$EV/root.txt" '/usr/bin /.cache/x a//b /'
OUT=$(cd "$R" && env -u HOME EVIDENCE_DIR="$EV" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" nohome -- echo /usr/bin 2>&1)
RC=$?
chk "an unset HOME is not an error: exit 0" rc_is 0
chk "an unset HOME leaves paths alone" fhas_line "$EV/nohome.txt" '/usr/bin'
hrun home2 -- echo "$H/in-cmd"
chk "the cmd line goes through the same filter" test "$(fline "$EV/home2.txt" 2)" = 'cmd=echo ~/in-cmd'
end_case 4 "HOME becomes ~ in the output and the cmd line, never inside a longer name"

# ---- case 5 ----
echo "case 5: user and host names removed"
mkhelper
BAD=""
EV="$T/ev"
hrun names -- echo "built by fixtureuser on fixturehost.example, short fixturehost, again fixtureuser"
F="$EV/names.txt"
chk "exit 0" rc_is 0
chk "user and host replaced, longer host name first" fhas_line "$F" 'built by <user> on <host>, short <host>, again <user>'
chk "the user name is nowhere in the file" flacks "$F" fixtureuser
chk "the host name is nowhere in the file" flacks "$F" fixturehost
ME=$(id -un)
if [ "${#ME}" -ge 3 ]; then
  hrun names2 -- echo "login $ME here"
  chk "the account name that id -un reports is removed too" fhas_line "$EV/names2.txt" 'login <user> here'
fi
OUT=$(cd "$R" && env EVIDENCE_DIR="$EV" HOME="$T/home" USER=ab TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" short -- echo "ab abab" 2>&1)
RC=$?
chk "a two character name is left alone" fhas_line "$EV/short.txt" 'ab abab'
end_case 5 "user and host names are replaced by <user> and <host>"

# ---- case 6 ----
echo "case 6: KEY=, TOKEN=, SECRET=, PASSWORD= lines redacted"
mkhelper
BAD=""
EV="$T/ev"
cat > "$T/secrets.sh" <<'EOF'
echo 'API_KEY=zq9v8w7u'
echo 'export GITHUB_TOKEN=ghp_xyz'
echo 'DB_PASSWORD=hunter2'
echo 'CLIENT_SECRET="s3cr3t"'
echo 'api_key=lowercase'
echo 'curl https://x/y?token=in-a-url&b=1'
echo 'a line KEYS=1 stays'
echo 'a bare KEY= stays'
echo 'monkey business'
echo 'plain line'
EOF
hrun secrets -- sh "$T/secrets.sh"
F="$EV/secrets.txt"
chk "exit 0" rc_is 0
chk "six lines are replaced by <redacted>" test "$(grep -cxF '<redacted>' "$F")" = 6
for v in zq9v8w7u ghp_xyz hunter2 's3cr3t' lowercase in-a-url; do chk "the value $v is gone" flacks "$F" "$v"; done
chk "KEYS=1 is kept" fhas_line "$F" 'a line KEYS=1 stays'
chk "a bare KEY= is kept" fhas_line "$F" 'a bare KEY= stays'
chk "a line without the pattern is kept" fhas_line "$F" 'plain line'
chk "a word that holds key without = is kept" fhas_line "$F" 'monkey business'
hrun secrets2 -- echo --password=hunter2 --other
chk "a value on the command line never reaches the cmd line" test "$(fline "$EV/secrets2.txt" 2)" = 'cmd=<redacted>'
end_case 6 "a line with KEY=, TOKEN=, SECRET= or PASSWORD= and a value becomes <redacted>"

# ---- case 7 ----
echo "case 7: a 500 line output is cut to its first 20 and last 200 lines"
mkhelper
BAD=""
EV="$T/ev"
hrun big -- seq 1 500
F="$EV/big.txt"
chk "exit 0" rc_is 0
chk "224 lines: header, cmd, 20, marker, 200, exit" nlines_is "$F" 224
chk "the marker line says 280 lines omitted" test "$(sed -n '23p' "$F")" = '... 280 lines omitted'
chk "exactly one marker" test "$(grep -c 'lines omitted' "$F")" = 1
chk "output line 1 is the first kept line" test "$(fline "$F" 3)" = 1
chk "output line 20 is the last of the head" test "$(fline "$F" 22)" = 20
chk "the line after the marker is 301" test "$(fline "$F" 24)" = 301
chk "the last output line is 500" test "$(fline "$F" 223)" = 500
chk "line 21 was cut" test "$(grep -cx '21' "$F")" = 0
chk "line 300 was cut" test "$(grep -cx '300' "$F")" = 0
chk "the file ends with exit=0" test "$(flast "$F")" = 'exit=0'
end_case 7 "head 20, tail 200, one omitted marker, exit line last"

# ---- case 8 ----
echo "case 8: the cut boundary"
mkhelper
BAD=""
EV="$T/ev"
hrun b220 -- seq 1 220
chk "220 lines of output are kept whole: 2 + 220 + 1 lines" nlines_is "$EV/b220.txt" 223
chk "no marker at 220" flacks "$EV/b220.txt" 'lines omitted'
hrun b221 -- seq 1 221
chk "221 lines of output lose one" fhas_line "$EV/b221.txt" '... 1 lines omitted'
chk "221: the file has 20 + marker + 200 output lines" nlines_is "$EV/b221.txt" 224
chk "221: line 21 is the one that was cut" test "$(grep -cx '21' "$EV/b221.txt")" = 0
chk "221: line 22 is kept after the marker" test "$(fline "$EV/b221.txt" 24)" = 22
hrun b0 -- true
chk "no output at all: header, cmd, exit" nlines_is "$EV/b0.txt" 3
end_case 8 "220 lines whole, 221 lines cut by one, empty output"

# ---- case 9 ----
echo "case 9: a failing command still writes the file"
mkhelper
BAD=""
EV="$T/ev"
hrun fail -- sh -c 'echo out; echo err >&2; exit 1'
chk "the helper exits 1" rc_is 1
chk "the file is written" test -f "$EV/fail.txt"
chk "the file ends with exit=1" test "$(flast "$EV/fail.txt")" = 'exit=1'
chk "stdout and stderr are both in the file" test "$(sed -n '3,4p' "$EV/fail.txt")" = "$(printf 'out\nerr')"
hrun fail3 -- sh -c 'exit 3'
chk "another code is passed through: exit 3" rc_is 3
chk "and written: exit=3" test "$(flast "$EV/fail3.txt")" = 'exit=3'
hrun ok -- true
chk "a passing command exits 0" rc_is 0
chk "and ends with exit=0" test "$(flast "$EV/ok.txt")" = 'exit=0'
end_case 9 "exit code passed through, file written on failure, last line exit=<code>"

# ---- case 10 ----
echo "case 10: a command that does not exist"
mkhelper
BAD=""
EV="$T/ev"
hrun missing -- no-such-command-evt
chk "exit 127" rc_is 127
chk "the file is written" test -f "$EV/missing.txt"
chk "ends with exit=127" test "$(flast "$EV/missing.txt")" = 'exit=127'
chk "the shell's message is in the file" fhas "$EV/missing.txt" 'no-such-command-evt'
end_case 10 "exit 127 and a transcript"

# ---- case 11 ----
echo "case 11: ordering, a last line without a newline, CRLF"
mkhelper
BAD=""
EV="$T/ev"
hrun order -- sh -c 'echo a; echo b >&2; echo c'
chk "stdout and stderr keep their order" test "$(sed -n '3,5p' "$EV/order.txt")" = "$(printf 'a\nb\nc')"
hrun nonl -- printf 'no newline'
chk "the wrote line stands alone after an output without a newline" last_has '^evidence-transcript: wrote .*nonl\.txt \(exit=0\)$'
chk "a last line without a newline gets its own line before exit=" test "$(sed -n '2,$p' "$EV/nonl.txt")" = "$(printf 'cmd=printf no newline\nno newline\nexit=0')"
hrun multi -- echo 'one
two'
chk "a newline inside an argument stays on the cmd line" test "$(fline "$EV/multi.txt" 2)" = 'cmd=echo one two'
chk "while the output keeps its two lines" test "$(sed -n '3,4p' "$EV/multi.txt")" = "$(printf 'one\ntwo')"
hrun crlf -- printf 'a\r\nb\r\n'
chk "CRLF line ends are normalised" test "$(sed -n '3,4p' "$EV/crlf.txt" | tr -d '\n')" = 'ab'
chk "no carriage return in the file" test "$(LC_ALL=C grep -c "$(printf '\r')" "$EV/crlf.txt")" = 0
OUT=$(cd "$R" && printf 'fed\n' | env EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" stdin -- cat 2>&1)
RC=$?
chk "the command reads no input: what is piped to the helper does not reach it" test "$(sed -n '2,$p' "$EV/stdin.txt")" = "$(printf 'cmd=cat\nexit=0')"
hrun bytes -- printf 'bad \377\376 bytes\nafter\n'
chk "output that is not valid UTF-8 does not stop the run: exit 0" rc_is 0
chk "and the lines after it are in the file" fhas_line "$EV/bytes.txt" 'after'
end_case 11 "order kept, last line terminated, CR removed, invalid bytes survived"

# ---- case 12 ----
echo "case 12: usage errors and a directory that is not a repository"
mkhelper
BAD=""
EV="$T/ev"
hrun
chk "no arguments: exit 2" rc_is 2
chk "the usage line is shown" has 'usage: scripts/evidence-transcript.sh <name> -- <command'
hrun demo echo hi
chk "no separator argument: exit 2" rc_is 2
hrun demo --
chk "no command after --: exit 2" rc_is 2
hrun ../escape -- true
chk "a name with a slash: exit 2" rc_is 2
hrun .hidden -- true
chk "a name starting with a dot: exit 2" rc_is 2
hrun 'two words' -- true
chk "a name with a space: exit 2" rc_is 2
chk "no file was written by any of them" test ! -e "$EV"
chk "nothing escaped upward" test ! -e "$T/escape.txt"
OUT=$(cd "$T/plain" && env GIT_CEILING_DIRECTORIES="$T" EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" nogit -- touch "$T/ran" 2>&1)
RC=$?
chk "outside a git repository: exit 2" rc_is 2
chk "it says there is no commit" has 'no commit'
chk "the command did not run" test ! -e "$T/ran"
chk "no file was written" test ! -e "$EV"
mkdir "$T/emptyrepo"
git init -q "$T/emptyrepo"
OUT=$(cd "$T/emptyrepo" && env EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" nocommit -- touch "$T/ran2" 2>&1)
RC=$?
chk "a repository with no commit: exit 2" rc_is 2
chk "its command did not run" test ! -e "$T/ran2"
chk "TMPDIR folder is empty" tmp_empty
end_case 12 "usage errors and no repository give exit 2, no file, no run"

# ---- case 13 ----
echo "case 13: default folder, nested EVIDENCE_DIR, replace on a second run"
mkhelper
BAD=""
OUT=$(cd "$R" && env -u EVIDENCE_DIR HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" dflt -- echo first 2>&1)
RC=$?
chk "exit 0" rc_is 0
chk "docs/evidence/<name>.txt of the current directory" test -f "$R/docs/evidence/dflt.txt"
EV="$T/a/b/c"
hrun nested -- echo one
chk "a nested EVIDENCE_DIR is created" test -f "$EV/nested.txt"
hrun nested -- echo two
chk "a second run replaces the file" test "$(sed -n '2,$p' "$EV/nested.txt")" = "$(printf 'cmd=echo two\ntwo\nexit=0')"
chk "and does not leave a temp file behind" test "$(ls -A "$EV" | wc -l | tr -d ' ')" = 1
chk "the file is readable by everyone (mode 644), not the 600 of a temp file" test "$(ls -l "$EV/nested.txt" | cut -c1-10)" = '-rw-r--r--'
chk "TMPDIR folder is empty" tmp_empty
end_case 13 "docs/evidence by default, EVIDENCE_DIR created, replaced on a second run"

# ---- case 14 ----
echo "case 14: EVIDENCE_CMD_LABEL"
mkhelper
BAD=""
EV="$T/ev"
OUT=$(cd "$R" && env EVIDENCE_CMD_LABEL='scripts/check.sh full | tail -n 40' EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" lbl -- echo captured 2>&1)
RC=$?
chk "exit 0" rc_is 0
chk "the label is the cmd= line" test "$(fline "$EV/lbl.txt" 2)" = 'cmd=scripts/check.sh full | tail -n 40'
chk "the output is the command's" test "$(fline "$EV/lbl.txt" 3)" = captured
OUT=$(cd "$R" && env EVIDENCE_CMD_LABEL='' EVIDENCE_DIR="$EV" HOME="$T/home" TMPDIR="$T/tmp" PATH="$T/bin:$PATH" "$HELPER" lbl2 -- echo captured 2>&1)
chk "an empty label means the command itself" test "$(fline "$EV/lbl2.txt" 2)" = 'cmd=echo captured'
end_case 14 "the label replaces the command text, empty means the command"

# ---- case 15 ----
echo "case 15: output also reaches the helper's stdout"
mkhelper
BAD=""
EV="$T/ev"
hrun live -- sh -c 'echo line-one; echo line-two >&2'
chk "exit 0" rc_is 0
chk "the output is printed while it runs" has_line 'line-one'
chk "stderr too" has_line 'line-two'
chk "the last line says where the file went" last_has '^evidence-transcript: wrote .*live\.txt \(exit=0\)$'
end_case 15 "live passthrough and one wrote line"

# ---- --record fixtures ----
# mkg5: T holds tmp (the TMPDIR of the runs), nodebin and pnpmbin (stub tools), origin.git (bare, HEAD main), work (a clone of it with the
# real scripts under test and stubs for the rest, one pushed commit). The stubs read STUB_LOG (a file) and STUB_FAIL (a name) from the
# environment of the run, so a case changes behaviour without a new commit.
mkg5() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/evt.XXXXXX") || exit 1
  CLEAN="$CLEAN $T"
  mkdir "$T/tmp" "$T/nodebin" "$T/pnpmbin"
  git init -q --bare "$T/origin.git" || exit 1
  git --git-dir="$T/origin.git" symbolic-ref HEAD refs/heads/main || exit 1
  git clone -q "$T/origin.git" "$T/work" 2>/dev/null || exit 1
  git -C "$T/work" symbolic-ref HEAD refs/heads/main || exit 1
  local s="$T/work/scripts"
  mkdir "$s" "$T/work/docs"
  cp "$CLONE_SCRIPT" "$G5_SCRIPT" "$HELPER" "$CHECKER" "$s/" || exit 1
  : > "$T/calls"
  printf '%s\n' '#!/usr/bin/env bash' 'echo v24.0.0' > "$T/nodebin/node"
  printf '%s\n' '#!/usr/bin/env bash' 'case "${1:-}" in' '  --version) echo 10.0.0;;' \
    '  demo) shift; exec bash scripts/demo.ts "$@";;' '  tsx) shift; f=$1; shift; exec bash "$f" "$@";;' \
    '  *) echo "fixture pnpm: unexpected arguments: $*"; exit 9;;' 'esac' > "$T/pnpmbin/pnpm"
  chmod +x "$T/nodebin/node" "$T/pnpmbin/pnpm"
  printf '%s\n' '# fixture env' ': ' > "$s/env.sh"
  cat > "$s/check.sh" <<'EOF'
#!/usr/bin/env bash
echo "check $*" >> "$STUB_LOG"
if [ "$1" = full ]; then
  i=1
  while [ "$i" -le 59 ]; do echo "full-line $i"; i=$((i + 1)); done
fi
echo "ALL GREEN ($1)"
EOF
  cat > "$s/evidence-pins.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '| tool | pinned | actual | status |' '| --- | --- | --- | --- |' '| fixturetool | 1.2 | 1.2 | ok |' '' 'commit fixture'
EOF
  printf '%s\n' '#!/usr/bin/env bash' 'echo "ready in 2s"' > "$s/demo.ts"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "BENCH REPLAY OK 30 runs, block unchanged"' > "$s/bench-replay-check.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo "EVIDENCE OK 7 links checked"' > "$s/evidence-check.ts"
  cat > "$s/privacy-screen.sh" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_FAIL:-}" != tmpro ] || chmod a-w "$TMPDIR"
echo "privacy screen: clean"
EOF
  printf '%s\n' '#!/usr/bin/env bash' 'echo "PAYLOAD SCAN OK (3 markers)"' > "$s/payload-scan.sh"
  cat > "$s/claims-run.sh" <<'EOF'
#!/usr/bin/env bash
echo "claims-run $*" >> "$STUB_LOG"
if [ "${STUB_FAIL:-}" = claims-offline ] && [ "$(grep -c '^claims-run ' "$STUB_LOG")" -ge 2 ]; then echo "stub claims: failing"; exit 1; fi
echo "CLAIMS OFFLINE OK 12 rows"
EOF
  cat > "$s/kani-check.sh" <<'EOF'
#!/usr/bin/env bash
echo "kani-check" >> "$STUB_LOG"
echo "home is $HOME/.cargo/registry"
echo "API_KEY=leak123"
[ "${STUB_FAIL:-}" != kani ] || { echo "stub kani: failing"; exit 1; }
echo "KANI OK: 36 harnesses, 5 covers satisfied"
EOF
  cat > "$s/lean-axioms.sh" <<'EOF'
#!/usr/bin/env bash
echo "lean-axioms" >> "$STUB_LOG"
[ "${STUB_FAIL:-}" != lean-axioms ] || { echo "stub lean: failing"; exit 1; }
echo "AXIOMS OK: 12 theorems"
echo "LEANCHECKER OK"
EOF
  cat > "$s/diff-verdict.sh" <<'EOF'
#!/usr/bin/env bash
echo "diff-verdict $*" >> "$STUB_LOG"
[ "${STUB_FAIL:-}" != diff-verdict ] || { echo "stub diff: failing"; exit 1; }
echo "Lean and Rust verdicts identical on 40000 cases"
EOF
  chmod +x "$s/"*.sh "$s/demo.ts" "$s/evidence-check.ts"
  printf '%s\n' '# bench' '' '| model | n |' '| --- | --- |' '| fixture | 30 |' > "$T/work/docs/BENCH.md"
  printf '%s\n' '# Evidence log' '' '## Pins' '' '| What | Network | Id |' '| --- | --- | --- |' '| Policy | testnet | fixture.testnet |' '' \
    '## Model choice' '' 'planner model: fixture-planner' > "$T/work/docs/EVIDENCE.md"
  commit_push 'test(evidence): fixture' scripts docs
}

commit_push() { # <message> <path>...: stage by name, commit as erfan-7116, push main to the bare origin
  local m=$1; shift
  ( cd "$T/work" && git add "$@" && git_as commit -q -m "$m" && git push -q origin main ) >/dev/null 2>&1 \
    || { echo "fixture commit or push failed in $T"; exit 1; }
}

# drop_tracked <script name>: delete scripts/<name>.sh from origin (a commit and a push); with keep it stays in the working tree
drop_tracked() {
  [ "${2:-}" = keep ] || rm "$T/work/scripts/$1.sh"
  ( cd "$T/work" && git rm -q --cached "scripts/$1.sh" && git_as commit -q -m "test(evidence): drop $1" && git push -q origin main ) >/dev/null 2>&1 \
    || { echo "fixture drop failed in $T"; exit 1; }
}

# grun [VAR=value ...] [-- <g5-check.sh arguments>]: g5-check.sh of the working repository, started in its top folder or in the folder
# named by GRUN_CWD (relative to it), sets OUT and RC. The variables that change
# behaviour are cleared first, TMPDIR is the fixture's own folder, the stub node and pnpm come first on the PATH
grun() {
  local pre=()
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do pre[${#pre[@]}]=$1; shift; done
  [ "$#" -eq 0 ] || shift
  OUT=$(cd "$T/work/${GRUN_CWD:-.}" && env -u CI -u CHECK_ROOT -u CHECK_STRICT -u CARGO_TARGET_DIR -u COREPACK_HOME -u EVIDENCE_DIR -u EVIDENCE_CMD_LABEL \
    -u G5_LEAN_CMD -u STUB_FAIL \
    TMPDIR="$T/tmp" PATH="$T/nodebin:$T/pnpmbin:$PATH" STUB_LOG="$T/calls" FRESH_CLONE_SKIP_INSTALL=1 G5_TEST_MODE=1 \
    ${pre[@]+"${pre[@]}"} "$T/work/scripts/g5-check.sh" "$@" 2>&1)
  RC=$?
}
origin_sha() { git --git-dir="$T/origin.git" rev-parse refs/heads/main; }
five_files() { [ "$(ls "$1" | tr '\n' ' ')" = 'check-full-tail.txt claims-offline.txt diff-verdict.txt kani.txt lean-axioms.txt ' ]; }
calls_of() { grep -c "^$1" "$T/calls"; }
no_hits() { [ "$(grep -rlE -e "$2" "$1" | wc -l | tr -d ' ')" = 0 ]; }   # no_hits <dir> <regex>: no file of the folder matches

echo "g5-check.sh --record fixture tests (bare origin, stub scripts, no network)"

# ---- case 16 ----
echo "case 16: --record writes the five transcripts"
mkg5
BAD=""
SHA=$(origin_sha)
EV="$T/work/docs/evidence"
grun -- --record --transcripts
chk "exit 0" rc_is 0
chk "last line G5 OK sha= the clone's sha" last_is "G5 OK sha=$SHA"
chk "exactly the five files, nothing else" five_files "$EV"
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do
  chk "$n: line 1 names the clone sha, a UTC date and the tools" grep -Eq "^sha=$SHA date=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z tools=node=24\.0\.0 pnpm=10\.0\.0 " <(fline "$EV/$n.txt" 1)
  chk "$n: ends with exit=0" test "$(flast "$EV/$n.txt")" = 'exit=0'
done
chk "kani: cmd line" test "$(fline "$EV/kani.txt" 2)" = 'cmd=scripts/kani-check.sh'
chk "lean-axioms: cmd line" test "$(fline "$EV/lean-axioms.txt" 2)" = 'cmd=scripts/lean-axioms.sh'
chk "diff-verdict: cmd line" test "$(fline "$EV/diff-verdict.txt" 2)" = 'cmd=scripts/diff-verdict.sh --commit'
chk "claims-offline: cmd line" test "$(fline "$EV/claims-offline.txt" 2)" = 'cmd=scripts/claims-run.sh --offline'
chk "check-full-tail: cmd line" test "$(fline "$EV/check-full-tail.txt" 2)" = 'cmd=scripts/check.sh full | tail -n 40'
chk "kani: the stub's last line" fhas_line "$EV/kani.txt" 'KANI OK: 36 harnesses, 5 covers satisfied'
chk "lean-axioms: the stub's lines" fhas_line "$EV/lean-axioms.txt" 'LEANCHECKER OK'
chk "diff-verdict: the stub's line" fhas_line "$EV/diff-verdict.txt" 'Lean and Rust verdicts identical on 40000 cases'
chk "claims-offline: the stub's line" fhas_line "$EV/claims-offline.txt" 'CLAIMS OFFLINE OK 12 rows'
chk "the home directory reached the stub and is written as ~" fhas_line "$EV/kani.txt" 'home is ~/.cargo/registry'
chk "the secret line is redacted" fhas_line "$EV/kani.txt" '<redacted>'
chk "the secret value is nowhere" no_hits "$EV" 'leak123'
chk "no /Users/ or /home/ in any file" no_hits "$EV" '/Users/|/home/'
chk "check-full-tail: 40 output lines between cmd= and exit=" nlines_is "$EV/check-full-tail.txt" 43
chk "check-full-tail: the last output line is the ALL GREEN (full) line" test "$(fline "$EV/check-full-tail.txt" 42)" = 'ALL GREEN (full)'
chk "check-full-tail: the first output line is the 21st of the 60" test "$(fline "$EV/check-full-tail.txt" 3)" = 'full-line 21'
chk "check-full-tail: nothing of the clone script's own lines" flacks "$EV/check-full-tail.txt" 'DURATION'
chk "check.sh ran twice (quick and full), never a third time" test "$(calls_of 'check ')" = 2
chk "each record command ran once" test "$(calls_of 'kani-check')$(calls_of 'lean-axioms')$(calls_of 'diff-verdict --commit')" = 111
chk "claims-run ran twice: step (c) and its transcript" test "$(calls_of 'claims-run --offline')" = 2
chk "TMPDIR folder is empty" tmp_empty
chk "docs/EVIDENCE.md has its one G5 section as before" test "$(grep -c '^## G5 fresh clone$' "$T/work/docs/EVIDENCE.md")" = 1
# the checker on the committed result: the transcripts name the clone's commit, HEAD differs from it by docs only
( cd "$T/work" && git add docs && git_as commit -q -m 'docs(evidence): record' ) >/dev/null 2>&1
OUT=$(cd "$T/work" && scripts/evidence-check-transcripts.sh 2>&1)
RC=$?
chk "the checker passes on the committed record" rc_is 0
chk "and names the recorded sha" last_is "EVIDENCE TRANSCRIPTS OK sha=$SHA"
end_case 16 "five files with the clone sha, right cmd= lines, redacted, one check.sh full only; the checker passes on them"

# ---- case 17 ----
echo "case 17: a second --record replaces the five files"
mkg5
BAD=""
EV="$T/work/docs/evidence"
OLD=$(origin_sha)
grun -- --record --transcripts
chk "first record: exit 0" rc_is 0
chk "first record: five files" five_files "$EV"
chk "first record: the old sha" fhas "$EV/kani.txt" "sha=$OLD "
: > "$T/work/bump.txt"
commit_push 'test(evidence): another commit' bump.txt
NEW=$(origin_sha)
chk "fixture: another sha" test "$OLD" != "$NEW"
GRUN_CWD=scripts grun -- --record --transcripts
chk "second record (started in scripts/): exit 0" rc_is 0
chk "second record: still exactly five files, in docs/evidence of the repository" five_files "$EV"
chk "second record: nothing written under the folder it was started in" test ! -e "$T/work/scripts/docs"
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do
  chk "$n: the new sha" test "$(fline "$EV/$n.txt" 1 | sed -n 's/^sha=\([0-9a-f]*\) .*/\1/p')" = "$NEW"
done
chk "the old sha is nowhere in the folder" no_hits "$EV" "$OLD"
chk "TMPDIR folder is empty" tmp_empty
end_case 17 "five files again, all with the new sha"

# ---- case 18 ----
echo "case 18: no --record, nothing is written and no record command runs"
mkg5
BAD=""
grun
chk "exit 0" rc_is 0
chk "last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
chk "no docs/evidence folder" test ! -e "$T/work/docs/evidence"
chk "kani-check, lean-axioms and diff-verdict never ran" test "$(calls_of 'kani-check')$(calls_of 'lean-axioms')$(calls_of 'diff-verdict')" = 000
chk "claims-run ran once, as step (c)" test "$(calls_of 'claims-run')" = 1
chk "git status of the working repository is empty" test -z "$(git -C "$T/work" status --porcelain)"
chk "TMPDIR folder is empty" tmp_empty
end_case 18 "without --record the record commands do not run and nothing is written"

# ---- case 19 ----
echo "case 19: each record command failing"
BAD=""
for who in kani lean-axioms diff-verdict claims-offline; do
  mkg5
  EV="$T/work/docs/evidence"
  cp "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
  grun STUB_FAIL=$who -- --record --transcripts
  chk "$who: exit 1" rc_is 1
  chk "$who: last line G5 FAIL record" last_is 'G5 FAIL record'
  chk "$who: the failing transcript is named" has "transcript $who exited 1"
  chk "$who: its transcript is still written" test -f "$EV/$who.txt"
  chk "$who: and ends with exit=1" test "$(flast "$EV/$who.txt" 2>/dev/null)" = 'exit=1'
  case "$who" in
    kani) later="lean-axioms diff-verdict claims-offline check-full-tail";;
    lean-axioms) later="diff-verdict claims-offline check-full-tail";;
    diff-verdict) later="claims-offline check-full-tail";;
    *) later="check-full-tail";;
  esac
  for l in $later; do chk "$who: no later transcript ($l)" test ! -e "$EV/$l.txt"; done
  case "$who" in
    kani) chk "kani: lean-axioms never ran" test "$(calls_of 'lean-axioms')" = 0;;
    lean-axioms) chk "lean-axioms: diff-verdict never ran" test "$(calls_of 'diff-verdict')" = 0;;
    diff-verdict) chk "diff-verdict: claims ran only as step (c)" test "$(calls_of 'claims-run')" = 1;;
  esac
  chk "$who: docs/EVIDENCE.md is untouched" cmp -s "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
  chk "$who: TMPDIR folder is empty" tmp_empty
done
# no temp folder for the transcripts (the TMPDIR folder turns read-only before the record starts): nothing is published, no folder made
mkg5
EV="$T/work/docs/evidence"
cp "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
grun STUB_FAIL=tmpro -- --record --transcripts
chmod -R u+w "$T/tmp"
chk "no stage folder: exit 1" rc_is 1
chk "no stage folder: G5 FAIL record (rm's complaints about the read-only folder follow it, so it is not the last line)" has_line 'G5 FAIL record'
chk "no stage folder: said so" has 'could not make a temp directory'
chk "no stage folder: no docs/evidence folder was made" test ! -e "$EV"
chk "no stage folder: docs/EVIDENCE.md is untouched" cmp -s "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
end_case 19 "a failing command: G5 FAIL record, its transcript kept with exit=1, nothing after it, EVIDENCE.md untouched; no stage folder: nothing published"

# ---- case 20 ----
echo "case 20: a script that --record needs is missing"
BAD=""
for who in kani-check diff-verdict claims-run lean-axioms evidence-transcript; do
  mkg5
  EV="$T/work/docs/evidence"
  cp "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
  drop_tracked "$who"
  grun -- --record --transcripts
  chk "$who: exit 1" rc_is 1
  chk "$who: last line G5 FAIL record" last_is 'G5 FAIL record'
  chk "$who: the missing script is named" has "scripts/$who\\.sh"
  chk "$who: it is said before the clone is made" lacks '^clone HEAD '
  chk "$who: no record command ran" test "$(calls_of 'kani-check')$(calls_of 'lean-axioms')$(calls_of 'diff-verdict')" = 000
  chk "$who: nothing was written" test ! -e "$EV"
  chk "$who: docs/EVIDENCE.md is untouched" cmp -s "$T/work/docs/EVIDENCE.md" "$T/EVIDENCE.orig"
  chk "$who: TMPDIR folder is empty" tmp_empty
  [ "$who" != lean-axioms ] || chk "lean-axioms: the message names G5_LEAN_CMD" has 'G5_LEAN_CMD'
done
# present in the working tree but not in origin: the clone is made, and the run ends before any step
for who in kani-check lean-axioms; do
  mkg5
  EV="$T/work/docs/evidence"
  drop_tracked "$who" keep
  grun -- --record --transcripts
  chk "$who not pushed: exit 1" rc_is 1
  chk "$who not pushed: last line G5 FAIL record" last_is 'G5 FAIL record'
  chk "$who not pushed: named" has "scripts/$who\\.sh"
  chk "$who not pushed: the clone was made" has '^clone HEAD '
  chk "$who not pushed: no step ran (not even claims)" test "$(calls_of 'claims-run')" = 0
  chk "$who not pushed: no record command ran" test "$(calls_of 'kani-check')$(calls_of 'lean-axioms')$(calls_of 'diff-verdict')" = 000
  chk "$who not pushed: nothing was written" test ! -e "$EV"
  chk "$who not pushed: TMPDIR folder is empty" tmp_empty
done
# a script that is there but cannot be run is as good as missing
mkg5
EV="$T/work/docs/evidence"
chmod -x "$T/work/scripts/kani-check.sh"
( cd "$T/work" && git update-index --chmod=-x scripts/kani-check.sh && git_as commit -q -m 'test(evidence): kani-check not executable' && git push -q origin main ) >/dev/null 2>&1
grun -- --record --transcripts
chk "not executable: exit 1" rc_is 1
chk "not executable: last line G5 FAIL record" last_is 'G5 FAIL record'
chk "not executable: named" has 'scripts/kani-check\.sh'
chk "not executable: nothing was written" test ! -e "$EV"
end_case 20 "a missing script is named before anything slow runs; G5 FAIL record, nothing written"

# ---- case 21 ----
echo "case 21: G5_LEAN_CMD stands in for scripts/lean-axioms.sh"
mkg5
BAD=""
EV="$T/work/docs/evidence"
drop_tracked lean-axioms
grun G5_LEAN_CMD='echo LAKE CHECK OK' -- --record --transcripts
chk "exit 0" rc_is 0
chk "five files" five_files "$EV"
chk "the cmd line is the D1 command" test "$(fline "$EV/lean-axioms.txt" 2)" = 'cmd=echo LAKE CHECK OK'
chk "its output is the command's" fhas_line "$EV/lean-axioms.txt" 'LAKE CHECK OK'
chk "and ends with exit=0" test "$(flast "$EV/lean-axioms.txt")" = 'exit=0'
grun 'G5_LEAN_CMD=echo no; exit 4' -- --record --transcripts
chk "a failing D1 command fails the run" rc_is 1
chk "as G5 FAIL record" last_is 'G5 FAIL record'
chk "and is written with its own exit code" test "$(flast "$EV/lean-axioms.txt")" = 'exit=4'
chk "TMPDIR folder is empty" tmp_empty
end_case 21 "G5_LEAN_CMD runs through sh -c and is recorded as the command"

# ---- case 22 ----
echo "case 22: EVIDENCE_DIR says where the files go"
mkg5
BAD=""
grun EVIDENCE_DIR="$T/elsewhere" -- --record --transcripts
chk "absolute: exit 0" rc_is 0
chk "absolute: five files there" five_files "$T/elsewhere"
chk "absolute: nothing in docs/evidence" test ! -e "$T/work/docs/evidence"
grun EVIDENCE_DIR="rel/out" -- --record --transcripts
chk "relative: exit 0" rc_is 0
chk "relative: five files under the directory the run started in" five_files "$T/work/rel/out"
GRUN_CWD=scripts grun EVIDENCE_DIR="rel/out" -- --record --transcripts
chk "relative from scripts/: exit 0" rc_is 0
chk "relative from scripts/: five files under scripts/rel/out" five_files "$T/work/scripts/rel/out"
chk "TMPDIR folder is empty" tmp_empty
end_case 22 "EVIDENCE_DIR absolute and relative"

# ---- checker fixtures ----
# mkchk: R is a scratch repository. C0 holds src/main.c, README.md, video/x-post.txt, the real checker and a payload-scan stub; C1 adds
# five well-formed transcripts that name C0 (so HEAD differs from the recorded sha by docs only). crun runs the checker in R.
write_transcripts() { # <sha>: five well-formed transcripts in $R/docs/evidence
  local n
  mkdir -p "$R/docs/evidence"
  for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do
    printf 'sha=%s date=2026-11-12T18:00:00Z tools=node=24.0.0 pnpm=10.0.0 rustc=1.86.0 kani=0.68.0 lake=5.0.0\ncmd=%s\nall good\nexit=0\n' "$1" "$n" > "$R/docs/evidence/$n.txt"
  done
}
mkchk() {
  T=$(mktemp -d "${TMPDIR:-/tmp}/evt.XXXXXX") || exit 1
  CLEAN="$CLEAN $T"
  R="$T/r"
  git init -q "$R" || exit 1
  mkdir -p "$R/scripts" "$R/src" "$R/docs" "$R/video"
  cp "$CHECKER" "$R/scripts/"
  printf '%s\n' '#!/bin/sh' '[ ! -e payload-fail ] || { echo "PAYLOAD SCAN FOUND 1"; exit 1; }' 'echo "PAYLOAD SCAN OK (3 markers)"' > "$R/scripts/payload-scan.sh"
  chmod +x "$R/scripts/"*.sh
  printf 'int main(void) { return 0; }\n' > "$R/src/main.c"
  printf '# readme\n' > "$R/README.md"
  printf 'video\n' > "$R/video/x-post.txt"
  ( cd "$R" && git add scripts src README.md video && git_as commit -q -m 'feat: code' ) || exit 1
  C0=$(git -C "$R" rev-parse HEAD)
  write_transcripts "$C0"
  ( cd "$R" && git add docs && git_as commit -q -m 'docs(evidence): record' ) || exit 1
}
# rcommit <message> [<path>...]: stage the named paths (deletions and moves are staged by their own git rm and git mv), commit as erfan-7116
rcommit() {
  local m=$1; shift
  ( cd "$R" && { [ "$#" -eq 0 ] || git add -- "$@"; } && git_as commit -q -m "$m" ) >/dev/null 2>&1 || { echo "fixture commit failed in $T"; exit 1; }
}
crun() { OUT=$(cd "$R" && scripts/evidence-check-transcripts.sh "$@" 2>&1); RC=$?; }
# retarget <file> <sed script>: edit a transcript in place (BSD sed)
retarget() { sed -i.bak "$2" "$R/docs/evidence/$1.txt" && rm "$R/docs/evidence/$1.txt.bak"; }

echo "evidence-check-transcripts.sh fixture tests (scratch repositories, payload-scan stub)"

# ---- case 23 ----
echo "case 23: five good transcripts at a docs-only distance"
mkchk
BAD=""
crun
chk "exit 0" rc_is 0
chk "last line EVIDENCE TRANSCRIPTS OK sha=<the recorded sha>" last_is "EVIDENCE TRANSCRIPTS OK sha=$C0"
chk "the sha is 40 hex" last_has '^EVIDENCE TRANSCRIPTS OK sha=[0-9a-f]{40}$'
chk "nothing before it says FAIL" lacks '^FAIL'
git -C "$R" tag record-tag
crun record-tag
chk "a tag as the reference: exit 0" rc_is 0
chk "a tag as the reference: the same last line" last_is "EVIDENCE TRANSCRIPTS OK sha=$C0"
crun "$C0"
chk "the recorded sha itself as the reference (distance 0): exit 0" rc_is 0
end_case 23 "OK sha=<sha> on a good record; a tag or the sha itself works as the reference"

# ---- case 24 ----
echo "case 24: README.md, docs/ and video/x-post.txt may change after the recorded sha"
mkchk
BAD=""
printf 'more\n' >> "$R/README.md"
printf 'more\n' >> "$R/video/x-post.txt"
mkdir -p "$R/docs/deep/er"
printf 'new\n' > "$R/docs/deep/er/new.md"
printf 'new\n' > "$R/docs/VERIFY.md"
rcommit 'docs: links' README.md video/x-post.txt docs/deep/er/new.md docs/VERIFY.md
crun
chk "exit 0" rc_is 0
chk "last line OK with the recorded sha" last_is "EVIDENCE TRANSCRIPTS OK sha=$C0"
git -C "$R" rm -q docs/VERIFY.md
rcommit 'docs: remove a doc'
crun
chk "a deleted doc file is fine too" rc_is 0
end_case 24 "docs-only distance passes: README.md, any file under docs/, video/x-post.txt"

# ---- case 25 ----
echo "case 25: code changed after the recorded sha"
mkchk
BAD=""
printf '// changed\n' >> "$R/src/main.c"
rcommit 'fix: code after the record' src/main.c
crun
chk "exit 1" rc_is 1
chk "the changed file is named" has 'src/main\.c'
chk "the last line is EVIDENCE TRANSCRIPTS FAIL <n>" last_has '^EVIDENCE TRANSCRIPTS FAIL [1-9][0-9]*$'
chk "it does not end OK" lacks '^EVIDENCE TRANSCRIPTS OK'
for p in src/docs/a.md docsx/a.md README.md.bak video/other.txt video/x-post.txt.bak scripts/evidence-check-transcripts.sh .github/workflows/ci.yml; do
  mkchk
  mkdir -p "$R/$(dirname "$p")"
  printf 'x\n' >> "$R/$p"
  rcommit "feat: touch $p" "$p"
  crun
  chk "$p counts as code (exit 1)" rc_is 1
  chk "$p is named" has "$p"
done
mkchk
git -C "$R" rm -q src/main.c
rcommit 'fix: delete code'
crun
chk "a deleted code file fails" rc_is 1
mkchk
git -C "$R" mv src/main.c docs/main.c
rcommit 'docs: move code into docs'
crun
chk "code moved into docs/ fails (the old path counts)" rc_is 1
chk "the old path is named" has 'src/main\.c'
end_case 25 "a code change, look-alike paths, a delete and a move out of code all fail"

# ---- case 26 ----
echo "case 26: a missing file"
BAD=""
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do
  mkchk
  git -C "$R" rm -q "docs/evidence/$n.txt"
  rcommit "docs: drop $n"
  crun
  chk "$n missing: exit 1" rc_is 1
  chk "$n missing: it is named" has "docs/evidence/$n\\.txt is missing"
  chk "$n missing: FAIL last line" last_has '^EVIDENCE TRANSCRIPTS FAIL [1-9]'
done
mkchk
git -C "$R" rm -q -r docs/evidence
rcommit 'docs: no evidence folder'
crun
chk "no folder at all: exit 1" rc_is 1
chk "no folder at all: five problems" last_is 'EVIDENCE TRANSCRIPTS FAIL 5'
end_case 26 "each of the five files is required"

# ---- case 27 ----
echo "case 27: a header sha git does not find, a header without a sha"
mkchk
BAD=""
Z=0000000000000000000000000000000000000000
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do retarget "$n" "1s/^sha=[0-9a-f]*/sha=$Z/"; done
rcommit 'docs: unknown sha' docs/evidence
crun
chk "exit 1" rc_is 1
chk "the unknown sha is reported" has 'not found'
chk "the last line is a FAIL" last_has '^EVIDENCE TRANSCRIPTS FAIL [1-9]'
mkchk
retarget kani '1s/^sha=//'
rcommit 'docs: header without sha' docs/evidence
crun
chk "a header without sha= fails" rc_is 1
chk "and names the file" has 'kani\.txt'
mkchk
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do retarget "$n" "1s/^sha=[0-9a-f]*/sha=${C0%????}/"; done
rcommit 'docs: short sha' docs/evidence
crun
chk "five headers with a sha of 36 hex digits: exit 1" rc_is 1
chk "a 36 digit sha is not a 40 hex sha" has 'kani\.txt: line 1 does not start with sha='
mkchk
TREE=$(git -C "$R" rev-parse "HEAD^{tree}")
for n in kani lean-axioms diff-verdict claims-offline check-full-tail; do retarget "$n" "1s/^sha=[0-9a-f]*/sha=$TREE/"; done
rcommit 'docs: a tree id is not a commit' docs/evidence
crun
chk "five headers naming a tree, not a commit: exit 1" rc_is 1
chk "the tree is not found as a commit" has 'not found in this repository'
end_case 27 "unknown sha, no sha, a short sha and a tree id fail"

# ---- case 28 ----
echo "case 28: two different shas"
mkchk
BAD=""
printf 'x\n' >> "$R/README.md"
rcommit 'docs: second commit' README.md
C1=$(git -C "$R" rev-parse HEAD)
retarget claims-offline "1s/^sha=[0-9a-f]*/sha=$C1/"
rcommit 'docs: one transcript from another commit' docs/evidence
crun
chk "exit 1" rc_is 1
chk "the mismatch is reported" has 'different'
chk "last line is a FAIL" last_has '^EVIDENCE TRANSCRIPTS FAIL [1-9]'
end_case 28 "headers with two shas fail"

# ---- case 29 ----
echo "case 29: a file that does not end with exit=0"
mkchk
BAD=""
retarget diff-verdict '$s/.*/exit=1/'
rcommit 'docs: failed transcript' docs/evidence
crun
chk "exit=1: exit 1" rc_is 1
chk "exit=1: the file is named" has 'diff-verdict\.txt'
mkchk
retarget kani '$d'
rcommit 'docs: no exit line' docs/evidence
crun
chk "no exit line: exit 1" rc_is 1
mkchk
printf 'exit=0 but not last\nmore\n' >> "$R/docs/evidence/kani.txt"
rcommit 'docs: exit=0 in the middle' docs/evidence
crun
chk "exit=0 that is not the last line: exit 1" rc_is 1
mkchk
retarget lean-axioms '$s/.*/exit=00/'
rcommit 'docs: exit=00' docs/evidence
crun
chk "exit=00 is not exit=0: exit 1" rc_is 1
end_case 29 "the last line must be exactly exit=0"

# ---- case 30 ----
echo "case 30: payload-scan.sh must exit 0"
mkchk
BAD=""
: > "$R/payload-fail"
crun
chk "a failing scan: exit 1" rc_is 1
chk "the scan is named" has 'payload-scan'
chk "last line is a FAIL" last_has '^EVIDENCE TRANSCRIPTS FAIL [1-9]'
rm "$R/payload-fail"
printf '%s\n' '#!/bin/sh' 'echo "payload-scan: marker file missing"; exit 2' > "$R/scripts/payload-scan.sh"
rcommit 'chore: a scan that cannot run' scripts/payload-scan.sh
crun
chk "a scan that cannot run (exit 2) is not a pass: exit 1" rc_is 1
git -C "$R" rm -q scripts/payload-scan.sh
rcommit 'chore: no scan'
crun
chk "no scan script at all: exit 1" rc_is 1
end_case 30 "a failing, unrunnable or missing payload scan fails the check"

# ---- case 31 ----
echo "case 31: home paths in the folder, usage, a tag"
mkchk
BAD=""
retarget kani 's#^cmd=.*#built in /Users/someone/work#'
rcommit 'docs: a home path' docs/evidence
crun
chk "/Users/ in a transcript: exit 1" rc_is 1
chk "the file is named" has 'kani\.txt'
mkchk
printf 'at /home/runner/x\n' > "$R/docs/evidence/notes.md"
rcommit 'docs: a home path in another file of the folder' docs/evidence/notes.md
crun
chk "/home/ in any file of the folder: exit 1" rc_is 1
chk "that file is named" has 'notes\.md'
mkchk
crun a b
chk "two arguments: exit 2" rc_is 2
chk "the usage line is shown" has 'usage: scripts/evidence-check-transcripts.sh'
crun no-such-ref
chk "an unknown reference: exit 1" rc_is 1
chk "and the reference is named" has 'no-such-ref'
mkchk
git -C "$R" tag docs-only
printf '// later\n' >> "$R/src/main.c"
rcommit 'fix: later code' src/main.c
crun docs-only
chk "a tag at the docs-only commit passes while HEAD has code after it" rc_is 0
crun
chk "HEAD with the later code fails" rc_is 1
end_case 31 "a home path anywhere in the folder fails, usage 2, an unknown ref fails, a tag is judged by its own commit"

# ---- case 32 ----
echo "case 32: --record without --transcripts needs no transcript script and writes none; --transcripts alone is a usage error"
BAD=""
mkg5
drop_tracked kani-check
grun -- --record
chk "plain --record with kani-check.sh missing: exit 0" rc_is 0
chk "plain --record: last line G5 OK" last_has '^G5 OK sha=[0-9a-f]{40}$'
chk "plain --record: no docs/evidence folder" test ! -e "$T/work/docs/evidence"
chk "plain --record: no record command ran" test "$(calls_of 'kani-check')$(calls_of 'lean-axioms')$(calls_of 'diff-verdict')" = 000
chk "plain --record: the G5 section was written" grep -q '^## G5 fresh clone' "$T/work/docs/EVIDENCE.md"
chk "plain --record: TMPDIR folder is empty" tmp_empty
mkg5
grun -- --transcripts
chk "--transcripts alone: exit 2" rc_is 2
end_case 32 "--transcripts is opt-in: plain --record skips the transcripts, and --transcripts needs --record"

if [ "$OK" -eq "$TOTAL_CASES" ]; then
  echo "EVIDENCE TRANSCRIPT TESTS OK $OK"
  exit 0
fi
echo "EVIDENCE TRANSCRIPT TESTS FAILED ($OK of $TOTAL_CASES ok)"
exit 1
