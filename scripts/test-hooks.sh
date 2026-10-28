#!/usr/bin/env bash
# AIR-001: offline tests of scripts/hooks (pre-commit and commit-msg). Every case commits in its own throwaway repo with
# core.hooksPath pointing at HOOKS_DIR, passed per command with `git -c` (no git config is written anywhere), and is judged
# by the exit code of `git commit` (gitleaks prints nothing at --log-level error).
# HOOKS_DIR defaults to $PWD/scripts/hooks and is made absolute: a relative hooksPath is resolved inside each temp repo,
# where it names nothing, and git then silently runs no hook.
# The fake key and the em dash are built at run time, so this file never trips its own hooks or the history scan.
# Last line: HOOKS OK (6 refusals, 1 accept)
set -euo pipefail
HOOKS_DIR="${HOOKS_DIR:-$PWD/scripts/hooks}"
case "$HOOKS_DIR" in /*) ;; *) HOOKS_DIR="$PWD/$HOOKS_DIR" ;; esac
[ -x "$HOOKS_DIR/pre-commit" ] && [ -x "$HOOKS_DIR/commit-msg" ] || { echo "no executable pre-commit and commit-msg in $HOOKS_DIR"; exit 1; }

OK_NAME=erfan-7116; OK_MAIL=erfan@welcomeaide.com
key="sk-test-$(printf '%s' 1234567890 1234567890 1234)"
dash=$(printf '\xe2\x80\x94')
tmps=""
trap 'for d in $tmps; do rm -rf "$d"; done' EXIT

# attempt <case> <file name> <file content> <message> <author name> <author email> <committer name> <committer email>
# prints nothing; returns the exit code of git commit
attempt() {
  local d; d="$(mktemp -d)"; tmps="$tmps $d"
  git -C "$d" init -q
  printf '%s\n' "$3" > "$d/$2"
  git -C "$d" add -- "$2"
  ( cd "$d" && GIT_AUTHOR_NAME="$5" GIT_AUTHOR_EMAIL="$6" GIT_COMMITTER_NAME="$7" GIT_COMMITTER_EMAIL="$8" \
      git -c core.hooksPath="$HOOKS_DIR" -c commit.gpgsign=false commit -q -m "$4" > /dev/null 2>&1 )
}
refuse() {   # refuse <case> <attempt args...>
  local name="$1"; shift
  if attempt "$name" "$@"; then echo "FAIL $name: expected refusal but commit succeeded"; exit 1; fi
  echo "refused: $name"
}

refuse secret    notes.txt "api_key=$key"   "feat(scaffold): notes" "$OK_NAME" "$OK_MAIL" "$OK_NAME" "$OK_MAIL"
refuse env-file  prod.env  ""               "feat(scaffold): env"   "$OK_NAME" "$OK_MAIL" "$OK_NAME" "$OK_MAIL"
refuse em-dash   a.txt     "x"              "feat(scaffold): a $dash b" "$OK_NAME" "$OK_MAIL" "$OK_NAME" "$OK_MAIL"
refuse coauthor  a.txt     "x"              "$(printf 'feat(scaffold): x\n\nCo-Authored-By: Someone <s@example.com>')" "$OK_NAME" "$OK_MAIL" "$OK_NAME" "$OK_MAIL"
refuse author    a.txt     "x"              "feat(scaffold): x"     "stranger" "stranger@example.com" "$OK_NAME" "$OK_MAIL"
refuse committer a.txt     "x"              "feat(scaffold): x"     "$OK_NAME" "$OK_MAIL" "stranger" "stranger@example.com"
if ! attempt accept a.txt "x" "feat(scaffold): x" "$OK_NAME" "$OK_MAIL" "$OK_NAME" "$OK_MAIL"; then
  echo "FAIL accept: a clean commit with the right author and committer was refused"; exit 1
fi
echo "accepted: clean commit"
echo "HOOKS OK (6 refusals, 1 accept)"
