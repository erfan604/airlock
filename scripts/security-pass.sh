#!/usr/bin/env bash
# AIR-167: the mechanical half of the runtime and console security pass. Re-run before the Freeze and before the submission.
#   scripts/security-pass.sh              build web, run every check, print `PASS <name>` or `FAIL <name>: <reason>`, then
#                                         `SECURITY PASS OK (<n> checks)` (exit 1 on any FAIL)
#   scripts/security-pass.sh --selftest   run the static checks against a planted bad tree in a temp directory and require every one
#                                         to FAIL: `SELFTEST ok (<n> planted failures caught)`
# Text scans are `git grep --no-index --exclude-standard`: plain git grep exits 128 outside a repository and skips untracked files. A scan
# whose directory is missing is a FAIL. The findings table is docs/SECURITY_PASS.md.
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
source "$HERE/scripts/env.sh"
unset -f grep 2>/dev/null || true

SECRET_RE='NEARAI_API_KEY|private_key|AGENT_CREDENTIALS|ed25519:[1-9A-HJ-NP-Za-km-z]{80,}'
SECRET_RE_NO_SIG='NEARAI_API_KEY|private_key|AGENT_CREDENTIALS'
SINK_RE='dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write'

# each check takes the root directory as $1, prints reasons on stdout and returns 1 on failure
gg() { local root=$1; shift; git -C "$root" grep --no-index --exclude-standard "$@"; }
need_dir() { [ -d "$1/$2" ] || { echo "directory $2 is missing"; return 1; }; }

c_no_cors() {
  need_dir "$1" runtime/src/server || return 1
  local hit; hit=$(gg "$1" -niE 'access-control-' -- runtime/src/server)
  [ -z "$hit" ] || { echo "CORS header in the server: $(echo "$hit" | head -1)"; return 1; }
}

c_log_secrets() {
  need_dir "$1" runtime/src || return 1
  local hit; hit=$(gg "$1" -nE 'console\.(log|error|warn|info)\(.*(cookie|signature|nonce|private_key|credentials)' -- runtime/src)
  [ -z "$hit" ] || { echo "secret in a log line: $(echo "$hit" | head -1)"; return 1; }
}

c_mode_branch() {
  local f="$1/runtime/src/server/session.ts"
  [ -f "$f" ] || { echo "runtime/src/server/session.ts is missing"; return 1; }
  grep -n 'mode' "$f" | sed 's/^/    mode: /'
  local body; body=$(awk 'index($0, "export const requireSession") { on = 1 } on { print } on && /^};/ { exit }' "$f")
  [ -n "$body" ] || { echo "requireSession not found"; return 1; }
  if printf '%s\n' "$body" | grep -q 'mode'; then echo "requireSession reads mode"; return 1; fi
  # `mode` may branch only in the GET /session issuance route: every use of deps.mode must sit inside that handler
  local uses; uses=$(grep -c 'deps\.mode' "$f")
  local inroute; inroute=$(awk "/app\\.get\\('\\/session'/ { on = 1 } on && /deps\\.mode/ { n++ } on && /^  \\}\\);/ { exit } END { print n + 0 }" "$f")
  [ "$uses" = "$inroute" ] || { echo "deps.mode is used outside GET /session ($uses uses, $inroute inside)"; return 1; }
}

c_html_sinks() {
  need_dir "$1" web/src || return 1
  local hit; hit=$(gg "$1" -nE "$SINK_RE" -- web/src)
  [ -z "$hit" ] || { echo "HTML sink: $(echo "$hit" | head -1)"; return 1; }
}

c_wrap_allow() {
  need_dir "$1" web/src || return 1
  local hit; hit=$(gg "$1" -lE 'wrapUntrusted' -- web/src | grep -vE '^web/src/(approvals/evidence\.ts|task/traceStore\.ts|challenge/model\.ts|try/model\.ts|components/untrusted\.ts|fixtures/)')
  [ -z "$hit" ] || { echo "wrapUntrusted outside its allow-list: $(echo "$hit" | head -1)"; return 1; }
}

c_reveal_allow() {
  need_dir "$1" web/src || return 1
  local hit; hit=$(gg "$1" -lE 'revealUntrusted' -- web/src | grep -vE '^web/src/components/(Specimen\.tsx|untrusted\.ts)$')
  [ -z "$hit" ] || { echo "revealUntrusted outside Specimen: $(echo "$hit" | head -1)"; return 1; }
}

# href, src and action JSX attributes with an expression: each line must match a pattern of scripts/security-pass.allow
c_jsx_urls() {
  need_dir "$1" web/src || return 1
  local allow="$1/scripts/security-pass.allow"
  [ -f "$allow" ] || allow="$HERE/scripts/security-pass.allow"
  local lines; lines=$(gg "$1" -nE '(href|src|action)=\{' -- web/src ':!web/src/fixtures')
  local bad=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "    attr: $line" | cut -c1-200
    local ok=0
    while IFS= read -r pat; do
      case "$pat" in ''|'#'*) continue;; esac
      if printf '%s' "$line" | grep -qE -- "$pat"; then ok=1; break; fi
    done <"$allow"
    [ "$ok" -eq 1 ] || bad="${bad:-$line}"
  done <<<"$lines"
  [ -z "$bad" ] || { echo "non-constant URL attribute not in security-pass.allow: $bad" | cut -c1-240; return 1; }
}

c_secrets_dist() {
  [ -d "$1/web/dist" ] || { echo "web/dist is missing: build first"; return 1; }
  local hit; hit=$(grep -rlE "$SECRET_RE" "$1/web/dist")
  [ -z "$hit" ] || { echo "secret pattern in the bundle: $(echo "$hit" | head -1)"; return 1; }
}

c_secrets_docs() {
  need_dir "$1" docs || return 1
  need_dir "$1" fixtures || return 1
  # docs/evidence/near holds saved public RPC answers: a transaction signature there looks like a key, so that folder is scanned for the named secrets only
  local hit; hit=$({ gg "$1" -nE "$SECRET_RE" -- docs fixtures ':!docs/evidence/near'; gg "$1" -nE "$SECRET_RE_NO_SIG" -- docs/evidence/near; } | cut -c1-120)
  [ -z "$hit" ] || { echo "secret pattern in docs or fixtures: $(echo "$hit" | head -1)"; return 1; }
}

c_csp_policy() { # $1 root, $2 optional planted policy
  if [ -n "${2:-}" ]; then
    (cd "$1/web" && node scripts/csp-check.mjs --policy "$2") >/tmp/sp167-csp.$$ 2>&1 || { head -1 /tmp/sp167-csp.$$; rm -f /tmp/sp167-csp.$$; return 1; }
    rm -f /tmp/sp167-csp.$$
    return 0
  fi
  local out; out=$(pnpm -C "$1/web" exec node scripts/csp-check.mjs 2>&1) || { echo "$out" | head -3; return 1; }
  printf '%s\n' "$out" | tail -1 | grep -qx 'CSP OK' || { echo "csp-check did not print CSP OK"; return 1; }
}

c_audit() { # $1 root; AUDIT_* hooks pass through
  local out; out=$("$1/scripts/audit-check.sh" 2>&1) || { echo "$out" | tail -1; return 1; }
  printf '%s\n' "$out" | tail -1 | grep -qx 'AUDIT OK' || { echo "audit-check did not print AUDIT OK"; return 1; }
}

c_session_tests() {
  local out; out=$(pnpm -C "$1/runtime" exec tsx --test test/server.test.ts test/session.test.ts test/sse.test.ts test/evidence.test.ts test/session.live-mode.test.ts 2>&1)
  local rc=$?
  [ "$rc" -eq 0 ] || { echo "server tests failed (exit $rc)"; return 1; }
  printf '%s\n' "$out" | grep -q 'SERVER_401 ok' || { echo "SERVER_401 ok not printed"; return 1; }
  printf '%s\n' "$out" | grep -q 'NEP413_VECTOR ok' || { echo "NEP413_VECTOR ok not printed"; return 1; }
}

c_e2e() { # $1 root, $2 e2e name
  local out; out=$(pnpm -C "$1/web" e2e "$2" 2>&1) || { echo "$out" | tail -3; return 1; }
  printf '%s\n' "$out" | tail -1 | grep -q "^E2E $2 OK" || { echo "E2E $2 OK not printed"; return 1; }
}

selftest() {
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/runtime/src/server" "$tmp/web/src/approvals" "$tmp/web/src/components" "$tmp/web/dist" "$tmp/docs" "$tmp/fixtures" "$tmp/web/scripts" "$tmp/scripts"
  cp "$HERE/web/scripts/csp-check.mjs" "$tmp/web/scripts/"
  cp "$HERE/scripts/audit-check.sh" "$HERE/scripts/env.sh" "$tmp/scripts/" 2>/dev/null || true
  printf "res.header('Access-Control-Allow-Origin', '*');\n" >"$tmp/runtime/src/server/cors.ts"
  printf "console.log('cookie', cookie);\n" >"$tmp/runtime/src/server/log.ts"
  printf "export const requireSession = async (c, next) => {\n  if (deps.mode === 'replay') return next();\n};\n" >"$tmp/runtime/src/server/session.ts"
  printf "export const X = () => <div dangerouslySetInnerHTML={{ __html: x }} />;\n" >"$tmp/web/src/bad.tsx"
  printf "const u = wrapUntrusted(raw); const v = revealUntrusted(u);\nexport const L = () => <a href={user}>x</a>;\n" >"$tmp/web/src/approvals/bad.tsx"
  printf "const k = 'NEARAI_API_KEY';\n" >"$tmp/web/dist/app.js"
  printf "NEARAI_API_KEY=abc\n" >"$tmp/docs/leak.md"
  printf '{"private_key":"x"}\n' >"$tmp/fixtures/leak.json"
  printf '{"advisories":{"9":{"github_advisory_id":"GHSA-test-test-test","module_name":"evil","id":9}}}\n' >"$tmp/fake-audit.json"
  printf '# no rows\n' >"$tmp/exceptions.md"
  cp "$HERE/scripts/security-pass.allow" "$tmp/scripts/"
  git -C "$tmp" init -q 2>/dev/null || true # not needed for --no-index; harmless

  local caught=0 total=0
  expect_fail() { # name, command...
    local name=$1; shift
    total=$((total + 1))
    if "$@" >/dev/null 2>&1; then echo "SELFTEST MISS $name: the planted failure passed"; else caught=$((caught + 1)); fi
  }
  expect_fail no-cors c_no_cors "$tmp"
  expect_fail log-secrets c_log_secrets "$tmp"
  expect_fail mode-branch c_mode_branch "$tmp"
  expect_fail html-sinks c_html_sinks "$tmp"
  expect_fail wrap-allow c_wrap_allow "$tmp"
  expect_fail reveal-allow c_reveal_allow "$tmp"
  expect_fail jsx-urls c_jsx_urls "$tmp"
  expect_fail secrets-dist c_secrets_dist "$tmp"
  expect_fail secrets-docs c_secrets_docs "$tmp"
  expect_fail csp-unsafe-eval c_csp_policy "$tmp" "default-src 'self'; script-src 'self' 'unsafe-eval' 'nonce-AAAAAAAAAAAAAAAA'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
  expect_fail csp-unsafe-inline c_csp_policy "$tmp" "default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-AAAAAAAAAAAAAAAA'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
  expect_fail csp-wide-connect c_csp_policy "$tmp" "default-src 'self'; script-src 'self' 'nonce-AAAAAAAAAAAAAAAA'; style-src 'self' 'unsafe-inline'; connect-src *; frame-ancestors 'none'; object-src 'none'; base-uri 'none'"
  expect_fail audit-unlisted env AUDIT_FAKE_JSON="$tmp/fake-audit.json" AUDIT_FAKE_RC=1 AUDIT_EXCEPTIONS="$tmp/exceptions.md" bash -c "$(declare -f c_audit); c_audit '$HERE'"
  # a missing directory or build is a FAIL, never a pass
  mkdir -p "$tmp/empty"
  expect_fail missing-dist c_secrets_dist "$tmp/empty"
  expect_fail missing-src c_html_sinks "$tmp/empty"
  # the real tree must still pass the tests' good side: the checks accept a clean file
  mkdir -p "$tmp/clean/web/src" "$tmp/clean/web/dist" "$tmp/clean/docs" "$tmp/clean/fixtures" "$tmp/clean/runtime/src/server"
  printf 'export const A = () => <p>ok</p>;\n' >"$tmp/clean/web/src/a.tsx"
  printf 'x\n' >"$tmp/clean/docs/a.md"; printf 'x\n' >"$tmp/clean/fixtures/a.json"; printf 'x\n' >"$tmp/clean/web/dist/a.js"
  for c in c_html_sinks c_wrap_allow c_reveal_allow c_secrets_dist c_secrets_docs; do
    "$c" "$tmp/clean" >/dev/null 2>&1 || { echo "SELFTEST BAD $c: a clean tree failed"; return 1; }
  done
  [ "$caught" -eq "$total" ] || { echo "SELFTEST FAILED ($caught of $total planted failures caught)"; return 1; }
  echo "SELFTEST ok ($caught planted failures caught)"
}

if [ "${1:-}" = "--selftest" ]; then selftest; exit $?; fi
[ "$#" -eq 0 ] || { echo "usage: scripts/security-pass.sh [--selftest]" >&2; exit 2; }

cd "$HERE"
N=0; FAILS=0
run() { # name, command...
  local name=$1; shift
  N=$((N + 1))
  local out; out=$("$@" 2>&1); local rc=$?
  [ -z "$out" ] || printf '%s\n' "$out"
  if [ "$rc" -eq 0 ]; then echo "PASS $name"; else FAILS=$((FAILS + 1)); echo "FAIL $name: $(printf '%s\n' "$out" | grep -v '^    ' | tail -1)"; fi
}

if ! pnpm -C web build >/dev/null 2>&1; then echo "FAIL web-build: pnpm -C web build failed"; exit 1; fi
run session-tests c_session_tests "$HERE"
run no-cors c_no_cors "$HERE"
run mode-branch c_mode_branch "$HERE"
run log-secrets c_log_secrets "$HERE"
run csp-header c_csp_policy "$HERE"
run html-sinks c_html_sinks "$HERE"
run wrap-untrusted-allow c_wrap_allow "$HERE"
run reveal-untrusted-allow c_reveal_allow "$HERE"
run jsx-url-attributes c_jsx_urls "$HERE"
run e2e-task c_e2e "$HERE" task
run e2e-card c_e2e "$HERE" card
run secrets-in-bundle c_secrets_dist "$HERE"
run secrets-in-docs-fixtures c_secrets_docs "$HERE"
run dependency-audit c_audit "$HERE"

if [ "$FAILS" -gt 0 ]; then echo "SECURITY PASS FAILED ($FAILS of $N checks)"; exit 1; fi
echo "SECURITY PASS OK ($N checks)"
