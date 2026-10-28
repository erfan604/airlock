#!/usr/bin/env bash
# AIR-249: offline tests of scripts/video-pin-check.sh. Every case builds a scratch git repository under mktemp -d (a few lines of
# web/src, scripts, contracts/*/src and fixtures, a docs/video-script.md and a video/shots.md with two pin: lines), changes files
# after the pin, and compares the whole stdout and the exit code of the checker with the expected text. The repo is never written
# to and the user's git config is not read (GIT_CONFIG_GLOBAL=/dev/null). Runs under macOS /bin/bash 3.2.
# Cases 1 to 5 are the five the AIR-249 Scope lists: 1 unchanged files give PIN OK; 2 a change after the pin to a file that holds a
# captured shot's string gives PIN CHANGED and exit 1; 3 a change to a file that holds no captured string, or only the string of a
# todo shot, gives PIN OK; 4 a captured shot on no pin line gives NO PIN and exit 2; 5 with two pin lines, a change between the two
# commits to a file of the first line's shot fails and to a file of the second line's shot passes.
# Cases 6 to 20 pin what those five leave open (BAD PIN forms, a shot on two lines, SCREEN-FMT, SCREEN-DATA, the status words, the
# cue rule, fixed-string search, contract sources, strings edited or moved away, uncommitted edits, a file shared by two shots,
# the --root option and the input errors, a string that holds quote marks, file names with a space and a non-ASCII letter, a
# search that fails). Every run also checks that the checker removed its temporary folder (TMPDIR is a folder of its own).
# Every string of the fixture starts with zzpt: this file lives in scripts/, a folder the checker searches, so no real SCREEN string
# of the product may match it. The ticket says 5 of 5; the count printed below is the real number of cases.
# A stub checker that prints nothing fails case 1 on its missing PIN OK line. All cases stop at the first failure.
# Last line: VIDEO PIN TESTS OK (<n> of <n>)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$here/video-pin-check.sh"
WANT=20
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$CHECK" ] || fail setup "scripts/video-pin-check.sh is missing or not executable"
N=0
W="$(mktemp -d)"; W="$(cd "$W" && pwd -P)"; trap 'rm -rf "$W"' EXIT
mkdir "$W/tmp"; export TMPDIR="$W/tmp"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$W"

w() { mkdir -p "$(dirname "$R/$1")"; printf '%s\n' "$2" > "$R/$1"; }   # w <path> <text>: a one-line file in the scratch repo
commit() { git -C "$R" add -- web contracts scripts docs video fixtures; git -C "$R" commit -q --allow-empty -m "$1"; }
head_sha() { git -C "$R" rev-parse HEAD; }

shots() {  # shots <pin line>...: write video/shots.md with these lines directly above the table header (not committed)
  mkdir -p "$R/video"
  {
    printf '# Video shots\n\n'
    for l in "$@"; do printf '%s\n' "$l"; done
    printf '\n| shot | mode | status | file | links shown |\n| - | - | - | - | - |\n'
    printf '%s\n' '| S01 | LIVE-CONSOLE | captured | video/raw/S01-1.mov | none |' \
      '| S03 | REPLAY | fallback-replay | video/raw/S03-1.mov | none |' \
      '| S04 | LIVE-CONSOLE | captured | video/raw/S04-1.mov | none |' \
      '| S05 | TERMINAL | todo |  | none |' \
      '| S07 | TITLE | dropped |  | none |' \
      '| S010 | TITLE | todo |  | none |'
  } > "$R/video/shots.md"
}

mk() {  # mk <name>: scratch repo with the build files, the script and an empty shots.md, committed; PIN is that commit
  R="$W/$1"; mkdir -p "$R"; git -C "$R" init -q 2>/dev/null
  w web/src/card.ts "export const T = ['zzpt Plan preview', 'zzpt Stamp one'];"
  w scripts/news.ts "console.log('zzpt News headline');"
  w web/src/shared.ts "export const S = 'zzpt Shared line';"
  w web/src/pay.ts "export const P = 'zzpt Pays {amount} {symbol} to {to}?';"
  w web/src/payprefix.ts "export const D = 'zzpt Pays 4 NEAR to bob?';"
  w fixtures/world.jsonl '{"scenario":"B01","item":"x"}'
  w fixtures/other.jsonl '{"scenario":"B02","item":"y"}'
  w contracts/x/src/lib.rs 'pub const E: &str = "zzpt Contract event line";'
  w web/src/meta.ts "export const M = '-- zzpt a.*b (z)';"
  w web/src/meta2.ts "export const M2 = '-- zzpt axxb (z)';"
  w web/src/todo.ts "export const O = 'zzpt Only a todo shot shows this';"
  w web/src/dropped.ts "export const X = 'zzpt Dropped shot string';"
  w web/src/ten.ts "export const N = 'zzpt Ten string';"
  w web/src/caption.ts "export const C = 'zzpt Caption decoy text';"
  w web/src/unrelated.ts "export const U = 'zzpt nothing shown here';"
  w web/src/quote.ts "export const Q = 'zzpt say \"hi\" now';"
  w web/src/quote2.ts "export const Q2 = 'zzpt say ';"
  w "$CAFE" "export const R = 'zzpt Menu line';"
  mkdir -p "$R/docs"
  cat > "$R/docs/video-script.md" <<'EOF'
LOCKED 2026-11-10

SHOT S01 0:00-0:10 mode LIVE-CONSOLE
RUN pnpm demo:live
SCREEN S01a "zzpt Plan preview"
SCREEN S01b "zzpt Stamp one"
CAP S01c 0:02-0:06 [DESC] zzpt Caption decoy text

SHOT S03 0:10-0:20 mode REPLAY
RUN pnpm demo
SCREEN S03a "zzpt News headline"
SCREEN S03b "zzpt Shared line"

SHOT S04 0:20-0:35 mode LIVE-CONSOLE
SCREEN S04a "zzpt Shared line"
SCREEN-FMT S04b "zzpt Pays {amount} {symbol} to {to}?" amount=9.4 symbol=NEAR to=near:x.testnet
SCREEN-DATA S04c ./fixtures/world.jsonl scenario B01 item x
SCREEN S04d "zzpt Contract event line"
SCREEN S04e "-- zzpt a.*b (z)"
SCREEN S04f "zzpt say "hi" now"
SCREEN S04g "zzpt Menu line"

SHOT S05 0:35-0:45 mode TERMINAL
SCREEN S05a "zzpt Only a todo shot shows this"

SHOT S07 0:45-0:55 mode TITLE
SCREEN S07a "zzpt Dropped shot string"

SHOT S010 0:55-1:05 mode TITLE
SCREEN S010a "zzpt Ten string"
EOF
  shots
  commit "build"
  PIN="$(head_sha)"
}

run() {  # run <args>...: the checker in $CWD_RUN (default the scratch repo); OUT is its stdout, RC its exit code, $W/err its stderr
  set +e; OUT="$(cd "${CWD_RUN:-$R}" && "$CHECK" "$@" 2>"$W/err")"; RC=$?; set -e
  [ -z "$(ls -A "$W/tmp")" ] || fail run "the checker left a temporary folder behind: $(ls "$W/tmp")"
}
expect() {  # expect <case> <rc> <line>...: the last run printed exactly these stdout lines and exited with rc
  local c="$1" rc="$2" want; shift 2
  want="$(printf '%s\n' "$@")"
  [ "$OUT" = "$want" ] || fail "$c" "stdout differs. want: [$want] got: [$OUT] stderr: [$(cat "$W/err")]"
  [ "$RC" -eq "$rc" ] || fail "$c" "exit $RC, want $rc: [$OUT]"
}
OKLINE='PIN OK 3 shots 11 strings'   # S01 has 2 strings, S03 has 2, S04 has 7 (five SCREEN, one SCREEN-FMT, one SCREEN-DATA)
CAFE="web/src/caf$(printf '\303\251') menu.ts"   # a file name with a space and a non-ASCII letter (UTF-8 bytes)

# 1: unchanged files give PIN OK (later commits touch only the shots table and the script, which are not searched)
mk unchanged; shots "pin: $PIN S01 S03" "pin: $PIN S04"; commit "shots"
printf 'CAP S01d 0:06-0:09 [DESC] later caption\n' >> "$R/docs/video-script.md"; commit "script"
run; expect unchanged 0 "$OKLINE"
sed 's/$/\r/' "$R/video/shots.md" > "$W/crlf1"; sed 's/$/\r/' "$R/docs/video-script.md" > "$W/crlf2"   # CRLF line ends read the same
cp "$W/crlf1" "$R/video/shots.md"; cp "$W/crlf2" "$R/docs/video-script.md"
run; expect unchanged-crlf 0 "$OKLINE"
N=$((N + 1))

# 2: a change after the pin to a file that holds a captured shot's strings (two of them, one file) gives one PIN CHANGED line
mk changed; shots "pin: $PIN S01 S03" "pin: $PIN S04"; commit "shots"
w web/src/card.ts "export const T = ['zzpt Plan preview', 'zzpt Stamp one', 'more'];"; commit "edit card"
run; expect changed 1 'PIN CHANGED S01 web/src/card.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 3: a file that holds no captured string, a caption line that is no SCREEN line, and the only string of a todo shot give PIN OK
mk other; shots "pin: $PIN S01 S03" "pin: $PIN S04"; commit "shots"
w web/src/unrelated.ts "export const U = 'edited';"; w web/src/caption.ts "export const C = 'zzpt Caption decoy text, edited';"; commit "decoys"
run; expect other-decoys 0 "$OKLINE"
w web/src/todo.ts "export const O = 'zzpt Only a todo shot shows this, edited';"; commit "todo shot"
run; expect other-todo 0 "$OKLINE"
N=$((N + 1))

# 4: a captured shot (S03) on no pin line is NO PIN and exit 2, as the last line
mk nopin; shots "pin: $PIN S01 S04"; commit "shots"
run; expect nopin 2 'NO PIN S03'
N=$((N + 1))

# 5: two pin lines on two commits: a change between them to a file of the first line's shot fails, to the second line's passes
mk twopins1; P1="$PIN"; w web/src/card.ts "export const T = ['zzpt Plan preview', 'zzpt Stamp one', 'between'];"; commit "between"
shots "pin: $P1 S01" "pin: $(head_sha) S03 S04"; commit "shots"
run; expect twopins-first 1 'PIN CHANGED S01 web/src/card.ts' 'PIN FAIL 1 changed'
mk twopins2; P1="$PIN"; w scripts/news.ts "console.log('zzpt News headline'); // between"; commit "between"
shots "pin: $P1 S01" "pin: $(head_sha) S03 S04"; commit "shots"
run; expect twopins-second 0 "$OKLINE"
N=$((N + 1))

# 6: a pin that is no commit of the root is BAD PIN and exit 2: a made-up sha, an abbreviation, upper case hex, a tree sha
mk badpin
fake=0123456789abcdef0123456789abcdef01234567
for bad in "$fake" "${PIN:0:12}" "$(printf '%s' "$PIN" | tr 'a-f' 'A-F')" "$(git -C "$R" rev-parse 'HEAD^{tree}')"; do
  shots "pin: $bad S01 S03 S04"; run; expect "badpin-$bad" 2 "BAD PIN $bad"
done
N=$((N + 1))

# 7: a shot named on two pin lines is NO PIN (exactly one line is required); naming it twice on one line is one line
mk twice; shots "pin: $PIN S01 S03" "pin: $PIN S03 S04"; commit "shots"
run; expect twice-lines 2 'NO PIN S03'
shots "pin: $PIN S01 S01 S03 S04"; commit "shots again"
run; expect twice-one-line 0 "$OKLINE"
N=$((N + 1))

# 8: a SCREEN-FMT template is searched whole, placeholders included: a file that holds only the text before the first placeholder
# is no holder, the file with the template is
mk fmt; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/payprefix.ts "export const D = 'zzpt Pays 4 NEAR to bob? edited';"; commit "prefix decoy"
run; expect fmt-decoy 0 "$OKLINE"
w web/src/pay.ts "export const P = 'zzpt Pays {amount} {symbol} to {to}? edited';"; commit "template"
run; expect fmt-template 1 'PIN CHANGED S04 web/src/pay.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 9: a SCREEN-DATA file (written ./fixtures/world.jsonl in the script) is itself the file to compare, and no other data file is
mk data; shots "pin: $PIN S01 S03 S04"; commit "shots"
w fixtures/other.jsonl '{"scenario":"B02","item":"edited"}'; commit "other data"
run; expect data-other 0 "$OKLINE"
w fixtures/world.jsonl '{"scenario":"B01","item":"edited"}'; commit "world data"
run; expect data-named 1 'PIN CHANGED S04 fixtures/world.jsonl' 'PIN FAIL 1 changed'
N=$((N + 1))

# 10: status fallback-replay is captured (S03 is one), status dropped is not (S07, whose string is on no pin line)
mk status; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/dropped.ts "export const X = 'zzpt Dropped shot string, edited';"; commit "dropped shot"
run; expect status-dropped 0 "$OKLINE"
w scripts/news.ts "console.log('zzpt News headline'); // edited"; commit "fallback shot"
run; expect status-fallback 1 'PIN CHANGED S03 scripts/news.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 11: a cue belongs to a shot when it is the shot id plus one letter: S010a is not a cue of S01
mk cue; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/ten.ts "export const N = 'zzpt Ten string, edited';"; commit "ten"
run; expect cue 0 "$OKLINE"
N=$((N + 1))

# 12: the search is for a fixed string given with -e: a string with regex characters and a leading dash finds only its own file
mk fixed; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/meta2.ts "export const M2 = '-- zzpt axxb (z), edited';"; commit "regex decoy"
run; expect fixed-decoy 0 "$OKLINE"
w web/src/meta.ts "export const M = '-- zzpt a.*b (z), edited';"; commit "the string"
run; expect fixed-own 1 'PIN CHANGED S04 web/src/meta.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 13: a string in contracts/<crate>/src is found (the pathspec 'contracts/*/src' alone matches no file under it)
mk contract; shots "pin: $PIN S01 S03 S04"; commit "shots"
w contracts/x/src/lib.rs 'pub const E: &str = "zzpt Contract event line"; // edited'; commit "contract"
run; expect contract 1 'PIN CHANGED S04 contracts/x/src/lib.rs' 'PIN FAIL 1 changed'
N=$((N + 1))

# 14: a string edited out of its file after the pin, or its file moved out of the searched folders, is still a change
mk away1; shots "pin: $PIN S01 S03 S04"; commit "shots"
w scripts/news.ts "console.log('zzpt News title');"; commit "edited away"
run; expect away-edited 1 'PIN CHANGED S03 scripts/news.ts' 'PIN FAIL 1 changed'
mk away2; shots "pin: $PIN S01 S03 S04"; commit "shots"
git -C "$R" mv web/src/card.ts docs/card.ts; commit "moved away"
run; expect away-moved 1 'PIN CHANGED S01 web/src/card.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 15: an edit that is not committed yet is a change too
mk dirty; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/card.ts "export const T = ['zzpt Plan preview', 'zzpt Stamp one', 'uncommitted'];"
run; expect dirty 1 'PIN CHANGED S01 web/src/card.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 16: a file that holds strings of two captured shots is one PIN CHANGED line per shot, and the count is the number of lines
mk shared; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/shared.ts "export const S = 'zzpt Shared line'; // edited"; commit "shared"
run; expect shared 1 'PIN CHANGED S03 web/src/shared.ts' 'PIN CHANGED S04 web/src/shared.ts' 'PIN FAIL 2 changed'
N=$((N + 1))

# 17: --root and the inputs: --root works from another folder; a missing value, an unknown flag, a missing shots.md or script, a
# folder that is no git repository and a folder inside one are exit 2
mk root; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/card.ts "export const T = ['zzpt Plan preview', 'zzpt Stamp one', 'root'];"; commit "edit card"
CWD_RUN="$W" run --root "$R"; expect root-option 1 'PIN CHANGED S01 web/src/card.ts' 'PIN FAIL 1 changed'
run --root; expect root-novalue 2
run --bogus; expect root-unknown 2
git -C "$R" mv video/shots.md video/shots.old; run --root "$R"; expect root-no-shots 2 "INPUT MISSING $R/video/shots.md"
git -C "$R" mv video/shots.old video/shots.md; git -C "$R" mv docs/video-script.md docs/video-script.old
run --root "$R"; expect root-no-script 2 "INPUT MISSING $R/docs/video-script.md"
git -C "$R" mv docs/video-script.old docs/video-script.md
mkdir -p "$W/plain/video" "$W/plain/docs"; cp "$R/video/shots.md" "$W/plain/video/"; cp "$R/docs/video-script.md" "$W/plain/docs/"
run --root "$W/plain"; expect root-no-repo 2 "NOT A REPO $W/plain"
mkdir -p "$R/sub/video" "$R/sub/docs"; cp "$R/video/shots.md" "$R/sub/video/"; cp "$R/docs/video-script.md" "$R/sub/docs/"
run --root "$R/sub"; expect root-subfolder 2 "NOT A REPO $R/sub"
N=$((N + 1))

# 18: a string that holds quote marks is read to the last quote mark of its line, as scripts/video-script-check.ts reads it
mk quote; shots "pin: $PIN S01 S03 S04"; commit "shots"
w web/src/quote2.ts "export const Q2 = 'zzpt say , edited';"; commit "decoy with the text before the first inner quote"
run; expect quote-decoy 0 "$OKLINE"
w web/src/quote.ts "export const Q = 'zzpt say \"hi\" now, edited';"; commit "the string"
run; expect quote-own 1 'PIN CHANGED S04 web/src/quote.ts' 'PIN FAIL 1 changed'
N=$((N + 1))

# 19: file names with a space and a non-ASCII letter are matched (git quotes such names unless it is told to end them with NUL)
mk names; shots "pin: $PIN S01 S03 S04"; commit "shots"
w "$CAFE" "export const R = 'zzpt Menu line, edited';"; commit "menu"
run; expect names 1 "PIN CHANGED S04 $CAFE" 'PIN FAIL 1 changed'
N=$((N + 1))

# 20: a search that fails is exit 2 and no PIN OK (here git grep fails on a bad config value that the other git calls never read)
mk broken; shots "pin: $PIN S01 S03 S04"; commit "shots"
git -C "$R" config grep.lineNumber notabool
run; expect broken 2
N=$((N + 1))

[ "$N" -eq "$WANT" ] || fail count "ran $N cases, expected $WANT"
echo "VIDEO PIN TESTS OK ($N of $WANT)"
