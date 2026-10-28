#!/usr/bin/env bash
# Clones the pushed origin into an empty directory and runs the whole gate there, so a hidden dependency on this machine's local
# state (an untracked file, ~/.airlock-research.env, a warm ~/.cache/airlock-target, .env, an uncommitted vector file, an absolute
# path) fails here and not on a judge's machine (AIR-281; the specification is the text of the cut ticket AIR-008).
# Usage: scripts/fresh-clone-check.sh [--keep <file>]
# Steps, in order (the name after "FRESH CLONE FAIL" is the step that failed):
#   origin        read the URL of the working repository's origin (it is never printed: it can carry a token)
#   clone         git clone of origin into a new temp directory (the pushed commit, not the working tree)
#   env           source the clone's own scripts/env.sh, then export CARGO_TARGET_DIR as a second new, empty temp directory. env.sh
#                 keeps a CARGO_TARGET_DIR that is already exported, so the export comes after it: a value the caller's shell
#                 exported never reaches the clone and the target directory really is empty
#   corepack, pnpm, cargo-fetch
#                 corepack enable; pnpm i --frozen-lockfile; cargo fetch --locked in contracts/airlock-verdict (online here: the
#                 replay builds the verdict CLI with --offline, which fails on an empty registry cache)
#   quick, full   scripts/check.sh quick, then full, in the clone. Each must exit 0 and end with an ALL GREEN (<mode> line (a
#                 skipped list is allowed). Each prints DURATION <mode> <s>s when it passed
# Last line: FRESH CLONE OK elapsed=<s> (exit 0) or FRESH CLONE FAIL <step> (exit 1). The temp directories are deleted before that
# line on success and on failure, and also on INT or TERM. Exit 2 is a usage error or a refused option.
# --keep <file>: write CLONE=<dir> and TARGET=<dir> to <file> and leave both directories on success, so scripts/g5-check.sh can run
#   its later steps in the same clone; the caller deletes them. On failure they are always deleted and the file is not written.
# FRESH_CLONE_SKIP_INSTALL=1: skips the three install steps and prints "SKIP install (test mode)". For scripts/test-fresh-clone.sh
#   only, because its fixtures have no lockfile; refused (exit 2) when CI is set, and scripts/g5-check.sh never reports G5 OK after it
#   unless G5_TEST_MODE=1.
# Works under env -i HOME="$HOME" PATH="$PATH" (the clone's env.sh puts cargo, elan and node on PATH). BSD tools only, bash 3.2.
# What stays warm on this Mac (cargo registry, pnpm store, ~/.elan, the cached neard) is not cleared: g5-check.sh --record lists it
# in docs/EVIDENCE.md, because a reader's machine pays those downloads.
set -uo pipefail

usage() { echo "usage: scripts/fresh-clone-check.sh [--keep <file>]" >&2; exit 2; }

KEEP_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) [ "$#" -ge 2 ] || usage; KEEP_FILE=$2; shift 2;;
    *) usage;;
  esac
done
case "$KEEP_FILE" in ''|/*) ;; *) KEEP_FILE="$PWD/$KEEP_FILE";; esac   # the script changes directory below

SKIP_INSTALL=0
case "${FRESH_CLONE_SKIP_INSTALL:-}" in ''|0) ;; *) SKIP_INSTALL=1;; esac
if [ "$SKIP_INSTALL" = 1 ] && [ -n "${CI:-}" ]; then
  echo "fresh-clone-check.sh: FRESH_CLONE_SKIP_INSTALL is for the tests only and is refused when CI is set" >&2
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
START=$SECONDS
TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
WORK=""      # log files of this run, always deleted
CLONE=""
TARGET=""
KEPT=0

# only ever delete what this script made: the folder name carries the marker
safe_rm() { case "$1" in */fresh-clone.*) rm -rf "$1";; esac; }
cleanup() {
  cd / || true
  safe_rm "$WORK"
  if [ "$KEPT" != 1 ]; then safe_rm "$CLONE"; safe_rm "$TARGET"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { # step: delete the temp directories, then the last line
  KEPT=0
  cleanup
  printf 'FRESH CLONE FAIL %s\n' "$1"
  exit 1
}

# run_step <name> <command...>: a header, the command in the clone, FAIL <name> when it exits nonzero
run_step() {
  local name=$1
  shift
  printf '\n== %s\n' "$name"
  "$@" || { echo "step $name failed (exit $?)"; fail "$name"; }
}

cargo_fetch() { ( cd contracts/airlock-verdict && cargo fetch --locked ); }

# run_check <quick|full>: scripts/check.sh in the clone, output shown and kept in $WORK for its last line
run_check() {
  local mode=$1 t0 rc last
  t0=$SECONDS
  printf '\n== check.sh %s\n' "$mode"
  scripts/check.sh "$mode" 2>&1 | tee "$WORK/$mode.log"
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then echo "check.sh $mode exited $rc"; fail "$mode"; fi
  last=$(tail -1 "$WORK/$mode.log")
  case "$last" in
    "ALL GREEN ($mode"*) ;;
    *) echo "check.sh $mode exited 0 without an ALL GREEN ($mode line (last line: $last)"; fail "$mode";;
  esac
  printf 'DURATION %s %ss\n' "$mode" "$((SECONDS - t0))"
}

# a CHECK_ROOT left in the environment would make check.sh test another tree instead of the clone
unset CHECK_ROOT

[ -z "$KEEP_FILE" ] || rm -f "$KEEP_FILE"
WORK=$(mktemp -d "$TMP_BASE/fresh-clone.work.XXXXXX") || fail tmp
CLONE=$(mktemp -d "$TMP_BASE/fresh-clone.clone.XXXXXX") || fail tmp
TARGET=$(mktemp -d "$TMP_BASE/fresh-clone.target.XXXXXX") || fail tmp

ORIGIN=$(git -C "$ROOT" remote get-url origin 2>/dev/null) || fail origin
[ -n "$ORIGIN" ] || fail origin
# a relative path remote is relative to the working repository
case "$ORIGIN" in /*|*://*|*@*:*) ;; *) [ -e "$ROOT/$ORIGIN" ] && ORIGIN="$ROOT/$ORIGIN";; esac

printf '== clone of origin\n'
git clone -q "$ORIGIN" "$CLONE" || fail clone
cd "$CLONE" || fail clone
echo "clone HEAD $(git rev-parse HEAD 2>/dev/null)"

[ -f scripts/env.sh ] || { echo "no scripts/env.sh in the clone"; fail env; }
set +u   # nvm.sh reads variables it never set
source scripts/env.sh || fail env
set -u
export CARGO_TARGET_DIR="$TARGET"

if [ "$SKIP_INSTALL" = 1 ]; then
  echo "SKIP install (test mode)"
else
  run_step corepack corepack enable
  run_step pnpm pnpm i --frozen-lockfile
  run_step cargo-fetch cargo_fetch
fi

run_check quick
run_check full

ELAPSED=$((SECONDS - START))
if [ -n "$KEEP_FILE" ]; then
  printf 'CLONE=%s\nTARGET=%s\n' "$CLONE" "$TARGET" > "$KEEP_FILE" || fail keep
  KEPT=1
fi
cleanup
printf 'FRESH CLONE OK elapsed=%s\n' "$ELAPSED"
exit 0
