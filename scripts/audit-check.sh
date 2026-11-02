#!/usr/bin/env bash
# AIR-167 check 5: production dependency audit. Passes when `pnpm audit --prod --audit-level=high` exits 0, or when every advisory it lists is a
# row of docs/AUDIT_EXCEPTIONS.md (id, package, reason, date). Prints `AUDIT OK` or `AUDIT FAIL: <advisories>`.
# Test hooks (scripts/security-pass.sh --selftest): AUDIT_FAKE_JSON=<file> and AUDIT_FAKE_RC=<n> replace the pnpm call, AUDIT_EXCEPTIONS=<file> the table.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
EXC="${AUDIT_EXCEPTIONS:-docs/AUDIT_EXCEPTIONS.md}"
[ -f "$EXC" ] || { echo "AUDIT FAIL: $EXC is missing"; exit 1; }
OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
if [ -n "${AUDIT_FAKE_JSON:-}" ]; then cp "$AUDIT_FAKE_JSON" "$OUT"; rc=${AUDIT_FAKE_RC:-1}
else pnpm audit --prod --audit-level=high --json >"$OUT" 2>/dev/null; rc=$?; fi
if [ "$rc" -eq 0 ]; then echo "AUDIT OK"; exit 0; fi
IDS=$(node -e '
const fs = require("fs");
let j; try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
const ids = new Set();
for (const [k, a] of Object.entries(j.advisories ?? {})) { ids.add(String(k)); for (const f of [a.github_advisory_id, a.id, a.cves?.[0]]) if (f) ids.add(String(f)); }
const lines = [];
for (const [k, a] of Object.entries(j.advisories ?? {})) lines.push([String(a.github_advisory_id ?? a.id ?? k), a.module_name ?? "", [String(k), String(a.github_advisory_id ?? ""), String(a.id ?? "")].join(",")].join("\t"));
console.log(lines.join("\n"));
' "$OUT"); nrc=$?
if [ "$nrc" -ne 0 ]; then echo "AUDIT FAIL: audit output is not JSON (exit $rc)"; exit 1; fi
if [ -z "$IDS" ]; then echo "AUDIT FAIL: pnpm audit exited $rc and listed no advisory"; exit 1; fi
bad=""
while IFS=$'\t' read -r main pkg alts; do
  [ -n "$main" ] || continue
  ok=0
  IFS=',' read -ra cand <<<"$alts"
  for id in "${cand[@]}"; do
    [ -n "$id" ] || continue
    if awk -F'|' -v id="$id" '/^\|/ { gsub(/^ +| +$/, "", $2); gsub(/^ +| +$/, "", $3); gsub(/^ +| +$/, "", $4); gsub(/^ +| +$/, "", $5); if ($2 == id && $3 != "" && $4 != "" && $5 != "") f = 1 } END { exit f ? 0 : 1 }' "$EXC"; then ok=1; break; fi
  done
  [ "$ok" -eq 1 ] || bad="$bad $main($pkg)"
done <<<"$IDS"
if [ -n "$bad" ]; then echo "AUDIT FAIL:$bad"; exit 1; fi
echo "AUDIT OK"
