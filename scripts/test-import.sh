#!/usr/bin/env bash
# AIR-006: offline tests of scripts/import-tickets.sh with a fake `gh` on PATH that records its arguments and fails on demand.
# Fixtures: four tickets (a `#` comment in the front matter, `depends_on: []`, one E13, one `status: cut`).
# Last line: IMPORT TESTS OK (<n> cases)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMPORT="$here/import-tickets.sh"
fail() { echo "FAIL $1: $2"; exit 1; }
[ -x "$IMPORT" ] || fail setup "scripts/import-tickets.sh is missing or not executable"
CASES=0
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT

mkdir -p "$W/bin"
cat > "$W/bin/gh" <<'GH'
#!/usr/bin/env bash
# fake gh: logs argv, answers issue create with a growing issue number, fails on demand (FAKE_GH_* variables)
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "api repos/"*)
    case "${FAKE_GH_MILESTONE:-ok}" in
      exists) echo '{"message":"Validation Failed","errors":[{"resource":"Milestone","code":"already_exists","field":"title"}]}' >&2; exit 1 ;;
      broken) echo 'HTTP 404: Not Found (https://api.github.com/repos/x/airlock/milestones)' >&2; exit 1 ;;
    esac
    echo '{}' ;;
  "label create") [ "${FAKE_GH_LABEL:-ok}" = broken ] && { echo 'HTTP 403: Resource not accessible' >&2; exit 1; }; true ;;
  "issue create")
    n=$(( $(cat "$GH_STATE/created" 2>/dev/null || echo 0) + 1 ))
    if [ "${FAKE_GH_RATELIMIT:-0}" -gt 0 ]; then
      left=$(cat "$GH_STATE/ratelimit" 2>/dev/null || echo "$FAKE_GH_RATELIMIT")
      if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$GH_STATE/ratelimit"; echo 'was submitted too quickly' >&2; exit 1; fi
    fi
    echo "$n" > "$GH_STATE/created"
    echo "https://github.com/x/airlock/issues/$n" ;;
  "issue close") true ;;
  *) echo "fake gh: unexpected $*" >&2; exit 1 ;;
esac
GH
chmod +x "$W/bin/gh"

ticket() {   # ticket <dir> <id> <epic> <status> <extra front matter line>
  printf -- '---\nid: %s\ntitle: Title %s\nepic: %s\ntier: Floor\ngate: G1\nday: 2026-11-01\nestimate_h: 1\nowner: claude\nstatus: %s\n%s\n---\n## Goal\ng\n' \
    "$2" "$2" "$3" "$4" "$5" > "$1/$2-x.md"
}
fresh() {    # fresh <name>: a ticket folder, a gh log and a gh state folder
  T="$W/$1"; mkdir -p "$T/tickets" "$T/state"; : > "$T/gh.log"
  ticket "$T/tickets" AIR-101 E03 todo 'depends_on: [AIR-102]   # a comment in the front matter'
  ticket "$T/tickets" AIR-102 E03 todo 'depends_on: []'
  ticket "$T/tickets" AIR-103 E13 todo 'depends_on: []'
  ticket "$T/tickets" AIR-104 E04 cut 'depends_on: []'
}
imp() {      # imp <args...>: runs the import on $T, sets OUT and RC
  set +e
  OUT="$(PATH="$W/bin:$PATH" GH_LOG="$T/gh.log" GH_STATE="$T/state" TICKETS="$T/tickets" REPO=x/airlock \
         IMPORT_SLEEP=0 IMPORT_RETRY_WAIT=0 "$IMPORT" "$@" 2>&1)"
  RC=$?; set -e
}
last() { printf '%s\n' "$OUT" | tail -1; }

# 1. dry run: nothing written, nothing sent; one planned create per non-E13 ticket; labels and milestones planned
fresh dry; imp
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail dry "exit $RC: $OUT"
[ ! -e "$T/tickets/github_map.json" ] || fail dry "a dry run wrote github_map.json"
[ ! -s "$T/gh.log" ] || fail dry "a dry run called gh: $(cat "$T/gh.log")"
[ "$(printf '%s\n' "$OUT" | grep -c '^+ gh issue create')" -eq 3 ] || fail dry "want 3 planned creates (E13 skipped): $OUT"
printf '%s\n' "$OUT" | grep -q '^+ gh issue create \[AIR-103\]' && fail dry "the E13 ticket was planned"
printf '%s\n' "$OUT" | grep -q '^+ gh issue close .*AIR-104' || fail dry "the cut ticket's close is not planned: $OUT"
printf '%s\n' "$OUT" | grep -q '^+ gh label create cut --repo x/airlock --force$' || fail dry "label cut not planned"
printf '%s\n' "$OUT" | grep -q '^+ gh label create E03 --repo x/airlock --force$' || fail dry "label E03 not planned"
printf '%s\n' "$OUT" | grep -q '^+ gh api repos/x/airlock/milestones -f title=G1b -f due_on=2026-11-05T23:59:00Z$' || fail dry "milestone G1b not planned with its due date"
[ "$(last)" = "IMPORT SUMMARY created 0 skipped_mapped 0 skipped_e13 1 closed_cut 0" ] || fail dry "summary: $(last)"

# 2. live run: three issues, the map, the cut ticket closed as not planned with label cut, the comment stripped from the labels
fresh live; imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail live "exit $RC: $OUT"
[ "$(grep -c '^issue create' "$T/gh.log")" -eq 3 ] || fail live "want 3 creates: $(cat "$T/gh.log")"
python3 -c "import json,sys; m=json.load(open(sys.argv[1])); sys.exit(0 if sorted(m)==['AIR-101','AIR-102','AIR-104'] else 1)" "$T/tickets/github_map.json" || fail live "map: $(cat "$T/tickets/github_map.json")"
grep -q '^issue close 3 --repo x/airlock --reason not planned$' "$T/gh.log" || fail live "the cut ticket (issue 3) was not closed as not planned: $(cat "$T/gh.log")"
grep '^issue create' "$T/gh.log" | grep 'AIR-104' | grep -q -- '--label E04,Floor,claude,cut' || fail live "the cut ticket lacks the cut label: $(cat "$T/gh.log")"
grep '^issue create' "$T/gh.log" | grep 'AIR-101' | grep -q -- '--label E03,Floor,claude --milestone G1 ' || fail live "front matter comment leaked into labels or milestone: $(cat "$T/gh.log")"
[ "$(last)" = "IMPORT SUMMARY created 3 skipped_mapped 0 skipped_e13 1 closed_cut 1" ] || fail live "summary: $(last)"

# 3. a re-run with the map creates nothing
imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail rerun "exit $RC: $OUT"
[ "$(grep -c '^issue create' "$T/gh.log")" -eq 3 ] || fail rerun "a re-run created issues"
[ "$(last)" = "IMPORT SUMMARY created 0 skipped_mapped 3 skipped_e13 1 closed_cut 0" ] || fail rerun "summary: $(last)"

# 4. milestone already exists: treated as success
fresh exists; FAKE_GH_MILESTONE=exists imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail milestone-exists "already_exists must count as success: $OUT"

# 5. any other milestone failure exits 1 before any issue is created
fresh broken; FAKE_GH_MILESTONE=broken imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 1 ] || fail milestone-broken "exit $RC, want 1: $OUT"
grep -q '^issue create' "$T/gh.log" && fail milestone-broken "issues were created after a milestone failure"

# 6. a label failure is fatal
fresh label; FAKE_GH_LABEL=broken imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 1 ] || fail label "exit $RC, want 1: $OUT"

# 7. one secondary rate limit answer is retried once after the (stubbed) wait; a second one exits 1
fresh rate1; FAKE_GH_RATELIMIT=1 imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail rate-once "one rate limit answer must be retried: $OUT"
[ "$(last)" = "IMPORT SUMMARY created 3 skipped_mapped 0 skipped_e13 1 closed_cut 1" ] || fail rate-once "summary: $(last)"
fresh rate2; FAKE_GH_RATELIMIT=2 imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 1 ] || fail rate-twice "exit $RC, want 1 after a second rate limit answer: $OUT"

# 8. IMPORT_LIMIT stops after n creations
fresh limit; IMPORT_LIMIT=2 imp --yes
CASES=$((CASES + 1))
[ "$RC" -eq 0 ] || fail limit "exit $RC: $OUT"
[ "$(grep -c '^issue create' "$T/gh.log")" -eq 2 ] || fail limit "IMPORT_LIMIT=2 must stop after two creations"

echo "IMPORT TESTS OK ($CASES cases)"
