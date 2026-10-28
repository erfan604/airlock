# Architecture

_To fill during the build: Fill from plan/SPEC.md sections 5 to 10 as each part lands. Keep diagrams ASCII so machine readers parse them._

## Components and trust
| Component | Path | Trusted for | Enforced by |
| --- | --- | --- | --- |
| Verdict (pure, proven) | contracts/airlock-verdict | ALLOW / ESCALATE / BLOCK from labels and limits | Kani harnesses, Lean `allow_iff` and theorems, Lean vs Rust differential test |
| Interpreter semantics (proven) | proofs/NI.lean | labels propagate soundly | Lean noninterference theorem |
| Policy contract | contracts/airlock-policy | book, caps, replay, queue, tx construction, MPC call | NEAR consensus, sandbox invariants I1 to I10 |
| Runtime | runtime/ | honest labels, owner session auth | TDX attestation and approved measurements if registered; otherwise local mode (whitelisted function-call key, unattested) |
| Planner LLM | runtime/src/planner | plan matches owner intent | never sees untrusted text (type + test) |
| Quarantined LLM | runtime/src/quarantine | nothing (outputs are tainted) | schema validation |

## Provenance propagation rules
| Rule | Where | Test |
| --- | --- | --- |
_To fill during the build: one row per rule from SPEC section 6_

## Data flow
_To fill during the build: owner request to planner to plan to interpreter to ActionRequest to contract to MPC to broadcast to receipt_
