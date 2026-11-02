# Architecture

The diagrams are ASCII so machine readers can parse them. The README holds the overview diagram.

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
| R1 literal: Owner, or Owner and Unresolved when the literal is not grounded in the owner's words | `runtime/src/interpreter/value.ts:33` (`lit`), `runtime/src/interpreter/interpreter.ts:78` (the three grounding sites) | `R1: an ungrounded literal is Owner plus Unresolved on both values and the pc stays Owner` |
| R2 tool output: the tool's label, the labels of the arguments and the pc taint, and the origin `call:<n>` | `runtime/src/interpreter/interpreter.ts:94` (the call step), `runtime/src/interpreter/value.ts:48` (`derive`) | `R2: a call result is labelled by the tool and has no Owner, with origin call:1` and `R2: a call under an untrusted pc carries the pc taint but never Owner` |
| R3 extraction: every field gets the source labels, Untrusted:quarantine and the pc taint, also from an Oracle or Owner source | `runtime/src/interpreter/interpreter.ts:120` (the extract step) | `R3: regression, extracting from an Oracle value is Oracle plus quarantine and not a trusted amount` |
| R4 calc and comparison: the union of the input labels and the pc taint | `runtime/src/interpreter/interpreter.ts:152` (the calc step), `runtime/src/interpreter/value.ts:48` (`derive`) | `R4: calc sum of an Owner literal and an email-extracted amount carries the union` |
| R5 address-book lookup: Book, plus the key labels when the key came from untrusted data; a miss keeps the raw key with Unresolved | `runtime/src/interpreter/interpreter.ts:137` (the lookup step), `runtime/src/interpreter/value.ts:60` (`bookResult`) | `R5b: a lookup keyed by an extracted vendor keeps the key labels (selection taint)` and `R5c: an alias that is not in the book keeps the raw key with Owner and Unresolved` |
| R6 branch and loop: the pc joins the labels of the condition or the list, a condition must be a boolean, a loop is bounded, the pc is restored after | `runtime/src/interpreter/interpreter.ts:167` (if), `runtime/src/interpreter/interpreter.ts:177` (for), `runtime/src/interpreter/value.ts:55` (`extendPc`) | `R6: an action inside an if on an extracted email bool has the untrusted pc, and the pc is restored after` and `R6b: a for over the inbox puts the email label in the pc of every action in the body` |
| R7 declassifiers: nothing in the interpreter removes a label, the owner caps and the owner approval live in the contract | `runtime/src/interpreter/value.ts:38` (`taint` leaves out only the Owner of the pc), `runtime/src/interpreter/value.ts:48` (`derive` only adds) | `rule 7: no step removes a label: derive keeps every input label and the pc taint, and only the Owner of the pc is left out` |
| R8 literal grounding: a hook with three sites, the default accepts everything until the grounding ticket wires the real check | `runtime/src/interpreter/interpreter.ts:78` (the hook call), `runtime/src/interpreter/types.ts` (`Grounder`) | `R1: the ground hook decides at exactly three sites, with the kind, the owner text and the decimals` |
| R9 root and sticky pc: every run starts with pc Owner, and a failing step stops the whole run with the step path and the labels | `runtime/src/interpreter/value.ts:25` (`ROOT_PC`), `runtime/src/interpreter/interpreter.ts:253` (`run`) | `abort: a failing step returns ok false with no proposed, the step path, the offending labels and an error event` |
| R10 tool arguments with untrusted labels are refused | `runtime/src/interpreter/toolargs.ts:5` (`defaultToolArgPolicy`), `runtime/src/interpreter/interpreter.ts:99` (the policy call) | `defaultToolArgPolicy aborts RefusedToolArg for a fetch_url whose argument came from an extraction` |
| R11 recipient trust: Owner, Book and Policy only, an Oracle value never vouches for an address | `runtime/src/interpreter/value.ts:60` (`bookResult` uses `isTrusted`), `runtime/src/interpreter/interpreter.ts:205` (the proposed labels) | `R11: an Oracle value never vouches for an address` |
| R12 single assignment and branch scoping: checked before the run, and `run` takes only a checked plan | `runtime/src/dsl/rule12.ts` (`checkRule12`), `runtime/src/interpreter/interpreter.ts:253` (the `CheckedPlan` parameter) | `R6: the same let name binds again in every iteration without error` and the type test `runtime/test/interpreter.typetest.ts` |

## Data flow
The owner request goes to the planner, which returns a plan in the DSL. The checked plan runs in the interpreter, which labels every value by origin and proposes ActionRequests. The runtime sends them to the policy contract with `submit_batch`. The contract applies the verdict and the ledgers, builds the transaction, asks the MPC signer for a signature, and the runtime broadcasts it and reads the receipt. A request the verdict escalates waits for the owner's `approve`.

## Decisions
- The task quick cap is a field of each registered asset (`quick_task_cap` in `asset_set`, AIR-042), not a flag: SPEC R3-09 says per asset, so `set_flags` carries only the task TTL and action maxima. SPEC 8.2 lists it under `set_flags`; the spec update of AIR-066 follows this line.
- An asset that is not in the registry can only block (verdict rule 0). Display symbols are unique across the registry and compared without letter case, so the approval screen never shows one symbol for two assets (AB6).
