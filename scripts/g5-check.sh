#!/usr/bin/env bash
# The G5 check on the pushed candidate: a fresh clone of origin passes check.sh quick and full with an empty Cargo target directory,
# the result can be written into docs/EVIDENCE.md, and the last line names the commit that was tested.
# Usage: scripts/g5-check.sh [--record [--transcripts]]
# What AIR-281 built here: the --record flag, the clone step (scripts/fresh-clone-check.sh --keep <temp file>, run with the
# environment unchanged, its lines printed so the DURATION quick and DURATION full lines appear in this output), the variables
# CLONE and TARGET read from the keep file, the check that a skipped install can never end in G5 OK, the record writer and the
# last line. What AIR-254 added at the line "# G5 STEPS (AIR-254)": the steps (a) to (e) on the same clone, run in order from the
# clone's directory after its own scripts/env.sh is sourced and CARGO_TARGET_DIR is TARGET (the clone script exported it in its own
# process only):
#   env      source the clone's scripts/env.sh (node 24, pnpm, cargo), so the steps do not depend on the caller's PATH
#   demo     env -i PATH=<node folder>:<pnpm folder>:/usr/bin:/bin HOME=<new empty folder> pnpm demo --no-open --exit-when-ready, so
#            neither Rust nor a key file nor a warm cache of HOME can help it; DURATION demo <s>s. COREPACK_HOME is the one extra
#            variable passed, and only when that folder exists: pnpm is a corepack shim, and with an empty HOME corepack would download
#            pnpm again (network) or stop. The step refuses (G5 FAIL demo) when cargo, rustc or rustup can be found on that PATH,
#            because its pass would no longer show that the demo needs no Rust. web/dist is removed first (check.sh full built it in
#            this clone, a reader's first demo has none), so DURATION demo includes the console build
#   replay   scripts/bench-replay-check.sh, then git diff --exit-code docs/BENCH.md; DURATION replay <s>s
#   claims   scripts/claims-run.sh --offline
#   evidence pnpm tsx scripts/evidence-check.ts
#   privacy  REPO=<owner>/<repo> from the clone's origin, scripts/privacy-screen.sh in the clone: PRIVACY clean when it exits 0, else
#            PRIVACY HITS <n> with n the output lines that do not start with a space (at least 1 when it failed: it fails closed).
#            Those lines are printed as "  privacy: <line>", the matched text (indented) never. This step never fails the run:
#            AIR-252 gates on it.
# A step passes only when it exits 0 and its last line has the form its script documents (ready in <n>s, BENCH REPLAY OK <n> runs,
# block unchanged, CLAIMS OFFLINE OK <n> rows, EVIDENCE OK <n> links checked; n of at least 1 except for the demo, and except for
# claims while every row is pending: "CLAIMS OFFLINE OK 0 rows (6 pending)"): a script that exits 0 and says nothing proved nothing. A failing step prints the line "step <name> exited <rc>" (or "... exited 0 without its last
# line"), deletes everything and ends G5 FAIL <name>; the later steps do not run and nothing is recorded.
# Last line: G5 OK sha=<the 40 hex of the clone's HEAD> (exit 0) or G5 FAIL <reason> (exit 1), the reason being clone, record, tmp,
# env, demo, replay, claims, evidence or "install was skipped". The clone and target directories are deleted when the script exits,
# on every path. Exit 2 is a usage error. Output before the last line includes the clone script's own last line (FRESH CLONE OK
# elapsed=<s>, or FRESH CLONE FAIL <step> followed here by G5 FAIL clone), and the output of every step.
# Without --record the working repository is not touched (no file is written under it).
# --record, and only then: inserts a "## G5 fresh clone" section into docs/EVIDENCE.md directly above "## Model choice" (AIR-243:
#   that heading stays the last section of the file). The section holds the date, the clone SHA, the last line of check.sh quick
#   and full in the clone, the machine, every DURATION line the run printed (the clone script's two, and the ones that steps added
#   later through duration_line: demo and replay), the pins table of scripts/evidence-pins.sh run in the clone, and the warm
#   caches. No origin URL, no home path, no environment, no .env. A second --record replaces the section instead of adding
#   another. When the file has no "## Model choice" heading, prints "no ## Model choice heading" and ends G5 FAIL record before the
#   clone is made, with the file untouched. The commit of the record (docs(evidence): ...) is AIR-254's.
# --transcripts (only with --record; opt-in because AIR-285 is a Should ticket and AIR-254, which runs --record, is Floor: a plain
#   --record never needs the transcript scripts) also writes the five proof transcripts of AIR-285, after the steps and before the
#   section above: for each of kani
#   (scripts/kani-check.sh), lean-axioms (scripts/lean-axioms.sh, or the command in G5_LEAN_CMD, run through sh -c, for the day
#   checkpoint D1 cut AIR-030 and AIR-255 records the lake command), diff-verdict (scripts/diff-verdict.sh --commit), claims-offline
#   (scripts/claims-run.sh --offline) and check-full-tail (the last 40 lines of the clone step's own check.sh full output, cut out of
#   what it printed: no second full run), scripts/evidence-transcript.sh runs the command in the clone and writes <name>.txt with the
#   clone's sha in its header. The files are then copied to docs/evidence of the working repository, or to $EVIDENCE_DIR when that is
#   set (the helper's own variable; a relative path is taken from the directory this script was started in), replacing the five files
#   of an earlier record. A command that exits nonzero ends the run as G5 FAIL record after the line "record: transcript <name>
#   exited <rc>": its transcript is still written and copied with the ones before it, nothing after it runs, and docs/EVIDENCE.md is
#   not touched. A script the commands need that is missing (or not executable) ends G5 FAIL record naming it, checked in the working
#   tree before the clone is made and again in the clone before the first step, so nothing slow has run yet; nothing is written then.
# G5_TEST_MODE=1 lets a run pass after FRESH_CLONE_SKIP_INSTALL=1 (the fixture tests of scripts/test-fresh-clone.sh have no
#   lockfile). Without it, "SKIP install (test mode)" in the clone script's output ends the run as G5 FAIL install was skipped.
# BSD tools only, bash 3.2.
set -uo pipefail

usage() { echo "usage: scripts/g5-check.sh [--record [--transcripts]]" >&2; exit 2; }

RECORD=0
TRANSCRIPTS=0
for a in "$@"; do
  case "$a" in
    --record) RECORD=1;;
    --transcripts) TRANSCRIPTS=1;;
    *) usage;;
  esac
done
[ "$TRANSCRIPTS" = 0 ] || [ "$RECORD" = 1 ] || usage

SELF=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$SELF/.." && pwd -P)
EVID="$ROOT/docs/EVIDENCE.md"
TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
KEEP=""        # keep file of the clone script
OUTF=""        # the clone script's output
SECF=""        # the new section
NEWF=""        # the new EVIDENCE.md before it replaces the old one
CLONE=""
TARGET=""
DURATIONS=""   # every DURATION line of the run, one per line, each with its newline
STEPF=""       # the output of the step that is running
DEMO_HOME=""   # the empty HOME of the demo step
EVSTAGE=""     # --record: the folder the helper writes the five transcripts into, before they are copied to $EVOUT
FULLTAIL=""    # --record: the last 40 lines of the clone's check.sh full output
# --record: where the five transcripts end up. EVIDENCE_DIR is the helper's own variable; a relative one is read from the directory
# this script was started in, because the script changes directory below
if [ -n "${EVIDENCE_DIR:-}" ]; then
  case "$EVIDENCE_DIR" in /*) EVOUT=$EVIDENCE_DIR;; *) EVOUT="$PWD/$EVIDENCE_DIR";; esac
else
  EVOUT="$ROOT/docs/evidence"
fi

# only ever delete what the clone script made: its folder names carry the marker
safe_rm() { case "$1" in */fresh-clone.*) rm -rf "$1";; esac; }
rmf() { [ -z "$1" ] || rm -f "$1"; }
cleanup() {
  cd / || true
  rmf "$KEEP"; rmf "$OUTF"; rmf "$SECF"; rmf "$NEWF"; rmf "$STEPF"; rmf "$FULLTAIL"
  safe_rm "$CLONE"; safe_rm "$TARGET"; safe_rm "$DEMO_HOME"; safe_rm "$EVSTAGE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

g5_fail() { # reason: delete the temp files and directories, then the last line
  cleanup
  printf 'G5 FAIL %s\n' "$1"
  exit 1
}

# duration_line <name> <seconds>: print DURATION <name> <seconds>s and keep it for the record. The demo and replay steps print theirs
# through this function.
duration_line() {
  printf 'DURATION %s %ss\n' "$1" "$2"
  DURATIONS="$DURATIONS$(printf 'DURATION %s %ss' "$1" "$2")"$'\n'
}

# warm_line <label> <folder under HOME>: one bullet for the record, with the size in MB or "absent"
warm_line() {
  local label=$1 rel=$2 kb
  if [ -d "${HOME:-/nonexistent}/$rel" ]; then
    kb=$(du -sk "$HOME/$rel" 2>/dev/null | awk '{print int($1 / 1024)}')
    printf '%s\n' "- $label: ~/$rel (${kb:-0} MB)"
  else
    printf '%s\n' "- $label: ~/$rel (absent)"
  fi
}

# the pnpm store is at the first of these that exists
pnpm_store_line() {
  local rel
  for rel in Library/pnpm/store .local/share/pnpm/store .pnpm-store; do
    if [ -d "${HOME:-/nonexistent}/$rel" ]; then warm_line "pnpm store" "$rel"; return 0; fi
  done
  printf '%s\n' "- pnpm store: not found (looked in ~/Library/pnpm/store, ~/.local/share/pnpm/store and ~/.pnpm-store)"
}

# write_record: build the section, then put it into docs/EVIDENCE.md above "## Model choice" in place of an older one. The file is
# only written when the new text has exactly one section; every failure leaves it as it was.
write_record() {
  local pins prc table os cpu sysctl_bin qline fline
  [ -f "$EVID" ] || { echo "no docs/EVIDENCE.md"; return 1; }
  grep -q '^## Model choice' "$EVID" || { echo "no ## Model choice heading"; return 1; }
  pins=$("$CLONE/scripts/evidence-pins.sh" 2>&1)
  prc=$?
  if [ "$prc" -ne 0 ]; then
    printf '%s\n' "$pins" | grep MISMATCH
    echo "scripts/evidence-pins.sh exited $prc in the clone"
    return 1
  fi
  table=$(printf '%s\n' "$pins" | grep '^|')
  [ -n "$table" ] || { echo "scripts/evidence-pins.sh printed no table"; return 1; }
  [ -n "$DURATIONS" ] || { echo "no DURATION lines to record"; return 1; }
  qline=$(grep '^ALL GREEN (quick' "$OUTF" | tail -1)
  fline=$(grep '^ALL GREEN (full' "$OUTF" | tail -1)
  os=$(sw_vers -productVersion 2>/dev/null) || os=unknown
  sysctl_bin=/usr/sbin/sysctl
  [ -x "$sysctl_bin" ] || sysctl_bin=sysctl
  cpu=$("$sysctl_bin" -n machdep.cpu.brand_string 2>/dev/null) || cpu=unknown
  SECF=$(mktemp "$TMP_BASE/fresh-clone.section.XXXXXX") || return 1
  NEWF=$(mktemp "$TMP_BASE/fresh-clone.evidence.XXXXXX") || return 1
  {
    printf '%s\n' '## G5 fresh clone' ''
    printf '%s\n' "- Date: $(date '+%Y-%m-%d %H:%M %Z')"
    printf '%s\n' "- Clone SHA: $SHA"
    printf '%s\n' "- check.sh quick in the clone: ${qline:-no ALL GREEN line}"
    printf '%s\n' "- check.sh full in the clone: ${fline:-no ALL GREEN line}"
    printf '%s\n' "- Machine: macOS $os, $cpu"
    printf '%s\n' '' 'Durations printed by the run:' '' '```'
    printf '%s' "$DURATIONS"
    printf '%s\n' '```' '' 'Toolchain pins (scripts/evidence-pins.sh, run in the clone):' ''
    printf '%s\n' "$table"
    printf '%s\n' '' 'Warm on this Mac before the run, so the run did not download them. A reader pays these downloads on the first run and needs network:' ''
    warm_line "cargo registry" .cargo/registry
    pnpm_store_line
    warm_line "Lean toolchains (elan)" .elan
    warm_line "NEAR sandbox binaries (neard)" .cache/airlock-sandbox
  } > "$SECF"
  awk -v secfile="$SECF" '
    BEGIN { while ((getline l < secfile) > 0) sec = sec l "\n"; close(secfile) }
    /^## / {
      if ($0 ~ /^## G5 fresh clone/) { skip = 1; next }
      skip = 0
      if ($0 ~ /^## Model choice/ && !done) { printf "%s\n", sec; done = 1 }
    }
    skip { next }
    { print }
    END { if (!done) exit 3 }
  ' "$EVID" > "$NEWF" || { echo "could not place the section above ## Model choice"; return 1; }
  [ "$(grep -c '^## G5 fresh clone' "$NEWF")" = 1 ] || { echo "the new EVIDENCE.md would not have exactly one G5 fresh clone section"; return 1; }
  cat "$NEWF" > "$EVID" || { echo "could not write docs/EVIDENCE.md"; return 1; }
  echo "recorded the G5 fresh clone section in docs/EVIDENCE.md"
  return 0
}

# record_preflight <repository folder>: --record runs five transcripts, so the helper and the scripts they call must be there. Said
# before anything slow runs. lean-axioms.sh may be absent when G5_LEAN_CMD stands in for it (the D1 lake command).
record_preflight() {
  local dir=$1 s
  [ -x "$SELF/evidence-transcript.sh" ] || { echo "record: scripts/evidence-transcript.sh is missing or not executable next to g5-check.sh"; return 1; }
  for s in scripts/kani-check.sh scripts/diff-verdict.sh scripts/claims-run.sh; do
    [ -x "$dir/$s" ] || { echo "record: $s is missing or not executable in $dir"; return 1; }
  done
  if [ -z "${G5_LEAN_CMD:-}" ] && [ ! -x "$dir/scripts/lean-axioms.sh" ]; then
    echo "record: scripts/lean-axioms.sh is missing or not executable in $dir (AIR-030 writes it; if checkpoint D1 cut it, set G5_LEAN_CMD to the lake command AIR-255 records)"
    return 1
  fi
  return 0
}

# run_transcript <name> <label> <command...>: scripts/evidence-transcript.sh in the clone, writing $EVSTAGE/<name>.txt; the label (or
# nothing) is what its cmd= line says. A nonzero exit is reported here and returned; the transcript was written all the same.
run_transcript() {
  local name=$1 label=$2 rc
  shift 2
  printf '\n== record %s\n' "$name"
  EVIDENCE_DIR="$EVSTAGE" EVIDENCE_CMD_LABEL="$label" "$SELF/evidence-transcript.sh" "$name" -- "$@"
  rc=$?
  if [ "$rc" -ne 0 ]; then echo "record: transcript $name exited $rc"; return 1; fi
  return 0
}

# record_transcripts: the five files of --record, in $EVSTAGE, from inside the clone. Stops at the first command that fails.
record_transcripts() {
  EVSTAGE=$(mktemp -d "$TMP_BASE/fresh-clone.transcripts.XXXXXX") || { echo "could not make a temp directory"; return 1; }
  FULLTAIL=$(mktemp "$TMP_BASE/fresh-clone.fulltail.XXXXXX") || { echo "could not make a temp file"; return 1; }
  # the clone step printed check.sh full between its "== check.sh full" header and its ALL GREEN (full line; that is the whole output
  awk '/^== check\.sh full$/ { f = 1; next } f { print } f && /^ALL GREEN \(full/ { exit }' "$OUTF" | tail -n 40 > "$FULLTAIL"
  [ -s "$FULLTAIL" ] || { echo "record: no check.sh full output in the clone step's output"; return 1; }
  run_transcript kani '' scripts/kani-check.sh || return 1
  if [ -n "${G5_LEAN_CMD:-}" ]; then
    run_transcript lean-axioms "$G5_LEAN_CMD" sh -c "$G5_LEAN_CMD" || return 1
  else
    run_transcript lean-axioms '' scripts/lean-axioms.sh || return 1
  fi
  run_transcript diff-verdict '' scripts/diff-verdict.sh --commit || return 1
  run_transcript claims-offline '' scripts/claims-run.sh --offline || return 1
  run_transcript check-full-tail 'scripts/check.sh full | tail -n 40' cat "$FULLTAIL" || return 1
  return 0
}

# publish_transcripts: copy the files in $EVSTAGE to $EVOUT, replacing the ones of an earlier record
publish_transcripts() {
  local f
  [ -n "$EVSTAGE" ] && [ -d "$EVSTAGE" ] || return 0   # nothing was written (an empty name would make the glob below read /)
  mkdir -p "$EVOUT" || { echo "record: could not create $EVOUT"; return 1; }
  for f in "$EVSTAGE"/*.txt; do
    [ -e "$f" ] || continue
    cp "$f" "$EVOUT/$(basename "$f")" || { echo "record: could not write $EVOUT/$(basename "$f")"; return 1; }
  done
  return 0
}

# --record needs its anchor: say so before a clone that takes minutes, not after it
if [ "$RECORD" = 1 ]; then
  if [ ! -f "$EVID" ]; then echo "no docs/EVIDENCE.md"; g5_fail record; fi
  if ! grep -q '^## Model choice' "$EVID"; then echo "no ## Model choice heading"; g5_fail record; fi
  if [ "$TRANSCRIPTS" = 1 ]; then record_preflight "$ROOT" || g5_fail record; fi
fi

KEEP=$(mktemp "$TMP_BASE/fresh-clone.keep.XXXXXX") || g5_fail tmp
OUTF=$(mktemp "$TMP_BASE/fresh-clone.out.XXXXXX") || g5_fail tmp

# the clone step: the environment is unchanged, every line of the clone script is printed and kept
"$SELF/fresh-clone-check.sh" --keep "$KEEP" 2>&1 | tee "$OUTF"
RC=${PIPESTATUS[0]}
if [ "$RC" -eq 0 ]; then
  CLONE=$(sed -n 's/^CLONE=//p' "$KEEP" | head -n 1)
  TARGET=$(sed -n 's/^TARGET=//p' "$KEEP" | head -n 1)
fi
if grep -q '^SKIP install (test mode)$' "$OUTF" && [ "${G5_TEST_MODE:-}" != 1 ]; then g5_fail "install was skipped"; fi
[ "$RC" -eq 0 ] || g5_fail clone
if [ ! -d "$CLONE" ] || [ ! -d "$TARGET" ]; then echo "the keep file does not name two directories"; g5_fail clone; fi
SHA=$(git -C "$CLONE" rev-parse HEAD 2>/dev/null)
if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then echo "no commit in the clone"; g5_fail clone; fi
DURATIONS=$(grep -E '^DURATION (quick|full) [0-9]+s$' "$OUTF")
[ -z "$DURATIONS" ] || DURATIONS="$DURATIONS"$'\n'
# the clone is what the record commands run in, and it holds what was pushed: look again, before the first step
if [ "$TRANSCRIPTS" = 1 ]; then record_preflight "$CLONE" || g5_fail record; fi

# AIR-254's steps (a) to (e) are below this comment, before the record and the last line. They run in "$CLONE" with "$TARGET" as
# the Cargo target directory (export CARGO_TARGET_DIR="$TARGET" for them: the clone script exported it in its own process only).
# Each duration is printed with duration_line, so that --record lists it. A failing step ends the run with: g5_fail <step>.
# G5 STEPS (AIR-254)

# run_g5_step <stream|file> <name> <pattern> <command...>: a header, the command with its output shown and kept in $STEPF, then
# g5_fail <name> unless it exited 0 and its last line fits the pattern. stream shows the output while the command runs; file writes it
# to $STEPF and shows it afterwards, for the demo: a server it leaves behind keeps a pipe open, and a pipe into tee would then wait
# for that server instead of ending with the demo
run_g5_step() {
  local mode=$1 name=$2 pat=$3 rc last
  shift 3
  printf '\n== %s\n' "$name"
  if [ "$mode" = file ]; then
    "$@" > "$STEPF" 2>&1
    rc=$?
    cat "$STEPF"
  else
    "$@" 2>&1 | tee "$STEPF"
    rc=${PIPESTATUS[0]}
  fi
  if [ "$rc" -ne 0 ]; then echo "step $name exited $rc"; g5_fail "$name"; fi
  last=$(tail -1 "$STEPF")
  if ! printf '%s\n' "$last" | grep -Eq -e "$pat"; then
    echo "step $name exited 0 without its last line (last line: $last)"
    g5_fail "$name"
  fi
}

cd "$CLONE" || g5_fail clone
set +u   # nvm.sh reads variables it never set
source scripts/env.sh || g5_fail env
set -u
export CARGO_TARGET_DIR="$TARGET"
STEPF=$(mktemp "$TMP_BASE/fresh-clone.step.XXXXXX") || g5_fail tmp

# (a) the demo with nothing on the PATH but the node and pnpm folders and an empty HOME (AIR-246 check 1)
DEMO_HOME=$(mktemp -d "$TMP_BASE/fresh-clone.demohome.XXXXXX") || g5_fail tmp
NODE_BIN=$(command -v node)
PNPM_BIN=$(command -v pnpm)
if [ -z "$NODE_BIN" ] || [ -z "$PNPM_BIN" ]; then echo "step demo: node or pnpm is not on the PATH"; g5_fail demo; fi
DEMO_PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN"):/usr/bin:/bin"
for tool in cargo rustc rustup; do
  found=$(env -i PATH="$DEMO_PATH" /bin/sh -c 'command -v "$1"' sh "$tool" 2>/dev/null)
  if [ -n "$found" ]; then
    echo "step demo: $tool is reachable on the demo PATH ($found), so a pass would not show that the demo needs no Rust"
    g5_fail demo
  fi
done
DEMO_ENV=(PATH="$DEMO_PATH" HOME="$DEMO_HOME")
COREPACK_DIR=${COREPACK_HOME:-${HOME:-/nonexistent}/.cache/node/corepack}
[ ! -d "$COREPACK_DIR" ] || DEMO_ENV[${#DEMO_ENV[@]}]=COREPACK_HOME="$COREPACK_DIR"
# check.sh full built web/dist in this clone; a reader's first pnpm demo has none and builds it, inside the 60 seconds (AIR-246 check 1
# removes it for the same reason), so DURATION demo must include that build
safe_rm "$CLONE/web/dist"
T0=$SECONDS
run_g5_step file demo '^ready in [0-9]+s$' env -i "${DEMO_ENV[@]}" pnpm demo --no-open --exit-when-ready
duration_line demo "$((SECONDS - T0))"

# (b) the bench replay and the table it regenerated
T0=$SECONDS
run_g5_step stream replay '^BENCH REPLAY OK [1-9][0-9]* runs, block unchanged$' scripts/bench-replay-check.sh
if ! git --no-pager diff --exit-code docs/BENCH.md; then
  echo "step replay: docs/BENCH.md differs from the committed table after the replay"
  g5_fail replay
fi
duration_line replay "$((SECONDS - T0))"

# (c) the offline CLAIMS commands, (d) the evidence check (it reads the network). claims-run.sh appends " (<p> pending)" to its last
# line while a row is pending (AIR-254 runs before AIR-255 clears the markers), and then 0 rows is a valid count, but only then
CLAIMS_LAST='^CLAIMS OFFLINE OK ([1-9][0-9]* rows( \([1-9][0-9]* pending\))?|0 rows \([1-9][0-9]* pending\))$'
run_g5_step stream claims "$CLAIMS_LAST" scripts/claims-run.sh --offline
run_g5_step stream evidence '^EVIDENCE OK [1-9][0-9]* links checked$' pnpm tsx scripts/evidence-check.ts

# (e) the privacy dry run: reported, never gating (AIR-252 gates on it). REPO is the owner and name of the clone's origin; a token in
# the URL goes with everything before github.com
printf '\n== privacy dry run\n'
PRIVACY_REPO=$(git -C "$CLONE" remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
PRIVACY_OUT=$(REPO="$PRIVACY_REPO" scripts/privacy-screen.sh 2>&1)
PRIVACY_RC=$?
if [ "$PRIVACY_RC" -eq 0 ]; then
  echo "PRIVACY clean"
else
  [ -n "$PRIVACY_OUT" ] || PRIVACY_OUT="the screen exited $PRIVACY_RC and printed nothing"
  printf '%s\n' "$PRIVACY_OUT" | grep -v '^ ' | sed 's/^/  privacy: /'
  PRIVACY_N=$(printf '%s\n' "$PRIVACY_OUT" | grep -vc '^ ')
  [ "$PRIVACY_N" -ge 1 ] || PRIVACY_N=1
  printf 'PRIVACY HITS %s\n' "$PRIVACY_N"
fi

if [ "$RECORD" = 1 ]; then
  # the transcripts first: they are the slow part, and a failing command still leaves its transcript, copied out before the run ends
  if [ "$TRANSCRIPTS" = 1 ]; then record_transcripts || { publish_transcripts; g5_fail record; }; fi
  write_record || g5_fail record
  if [ "$TRANSCRIPTS" = 1 ]; then
    publish_transcripts || g5_fail record
    echo "recorded the five transcripts in $EVOUT"
  fi
fi
cleanup
printf 'G5 OK sha=%s\n' "$SHA"
exit 0
