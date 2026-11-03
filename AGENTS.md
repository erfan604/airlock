# AGENTS.md

For any coding agent working in this repository. Same rules as `CLAUDE.md` (read it).

## Verify
The five commands and their last lines are in `docs/VERIFY.md`: `pnpm i && pnpm demo --no-open --exit-when-ready`, `scripts/claims-run.sh --tier node`, `pnpm bench:replay`, `scripts/check.sh full` and `scripts/claims-run.sh --network`. A missing tool prints `SKIP <id> needs <tool>`. To use the Lean language server, copy `.mcp.json.example` to `.mcp.json`.

## What this is
AIRLOCK gates signing for AI agent wallets on where each value came from. A planner model that never sees untrusted content writes a plan; a quarantined model extracts typed values from untrusted content; an interpreter tracks the origin of every value; a NEAR contract builds the transaction itself and acts only when the recipient and the decision to pay trace back to the owner or the owner's on-chain address book, and any amount taken from untrusted data is inside that payee's cap, its daily untrusted budget and the owner-confirmed task bound. Everything else waits for the owner's approval. Limits are in docs/KNOWN_LIMITATIONS.md.

## Where to look
| Question | File |
| --- | --- |
| What is enforced on chain | `contracts/airlock-verdict/src/lib.rs` (the verdict), `contracts/airlock-policy/src/gate.rs` (the gate), tests in `contracts/airlock-policy/tests/invariants.rs` |
| How provenance propagates | `runtime/src/interpreter/`, rules table in `docs/ARCHITECTURE.md` |
| Threats and assumptions | `docs/THREAT_MODEL.md` |
| Benchmark method and numbers | `docs/BENCH.md`, raw runs in `bench/runs/` |
| Deployed contract ids, code hashes, tx evidence | `docs/EVIDENCE.md` |

## How to verify quickly
1. `pnpm i && pnpm demo` then open the printed URL: watch a legit invoice auto-pay and an injected one escalate.
2. `scripts/check.sh full`: all suites green.
3. `pnpm bench:replay`: regenerates the README table from recorded transcripts.
