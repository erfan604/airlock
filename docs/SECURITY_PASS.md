# Security pass (AIR-167)

Surfaces: the owner session (AIR-161), the console CSP with NEAR Connect (AIR-183, AIR-182), untrusted text on screen (AIR-181, AIR-184).
Mechanical half: `source scripts/env.sh && scripts/security-pass.sh` (14 checks, builds `web` first; `--selftest` plants 15 failures and requires each to fail).
Dependencies: `scripts/audit-check.sh`, exceptions in `docs/AUDIT_EXCEPTIONS.md`. CSP lint: `web/scripts/csp-check.mjs`.

Hand review, no finding: the `Secure` rule (dropped for `localhost` and `127.0.0.1` only); `changeOrigin: false` on the proxy (`previewProxy`, `web/test/csp.test.ts`);
the replay `GET /session` self-issue is the only use of `deps.mode` (check `mode-branch`) and `createApp` refuses `replay` with a contract id not ending `.test.near`;
the executor iframe is the only place a script nonce is needed: the page carries one nonce meta tag and no inline script (`csp-header`); `Specimen` takes `source` only from
`model.ageText`, a system string built from a number. Two accepted limits are in `docs/KNOWN_LIMITATIONS.md` (Host-header rebinding, a non-GET with no `Origin`).

| id | area | finding | fix commit | test |
| --- | --- | --- | --- | --- |
| F1 | session | a login for a wrong account id was refused before its nonce was spent, so that challenge stayed usable (Low) | see git log (AIR-167) | runtime/test/session.test.ts "a nonce is also spent by a login for another account id" |
| F2 | approvals card | `lookalikeOf` caught every throw and answered "flags nothing": one malformed book key switched the lookalike warning and the forcing step off for a new payee, and a malformed payee read as unflagged (Medium, fail open) | see git log (AIR-167) | web/test/forcing.test.ts "lookalikeOf: ..." (two tests) |
