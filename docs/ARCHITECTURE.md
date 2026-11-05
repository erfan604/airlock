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

## MCP server (AIR-313)
`runtime/src/mcp/` lets any MCP client (Claude Desktop, Claude Code, Cursor, a NEAR AI agent) use an AIRLOCK policy over stdio. The client's model is an untrusted planner: it reads untrusted text and chooses the calls. So the server, never the model, decides every label, and `pay` goes through the same `submit_batch` path as the orchestrator and returns the contract's verdict.

```
owner config (file, written by `pnpm airlock init`)       MCP client (untrusted planner)
  request text, task bounds, accounts, inbox                     | tools/call over stdio
            |                                                    v
            +------------------------------------------>  airlock-mcp (runtime/src/mcp)
                                                           read tools: value + handle + label (TOOL_CHANNEL)
                                                           pay: labels from handles, grounding, book lookup
                                                             -> ActionRequest -> ChainClient.submitBatch
                                                             -> policy contract verdict (Allow, Escalate, Block)
```

Session. The owner's request and the task bounds come from the owner's config file at server start (`AIRLOCK_MCP_CONFIG`, default `~/.airlock/mcp.json`), never from a tool argument. No tool can change them. At the first `pay` the server signs one OwnerTask with the owner's local task key: the bounds of the config, `max_actions` of the config, a TTL of at most the contract's `max_task_ttl_ms`, and `plan_sha256` = sha256 of the session description (`airlock-mcp-session-v1`, the request text and the bounds). Every request of the session carries that hash. When the task expires or runs out of actions, `pay` answers `TaskExpired` or `NeedsNewTask` and the owner restarts the server; the server never widens or renews a task on its own.

Handles. Every string a read tool returns is wrapped as `{ h, text }`, and the server keeps the raw value and its labels under the handle id `h`. The label is the tool layer's channel (`runtime/src/tools/channels.ts`): `read_email` is `Untrusted:email` (the `read_inbox` channel), `fetch_page` is `Untrusted:web` (a page of the config, or a live https fetch of a host the owner lists in `fetch_hosts`, public addresses only, `runtime/src/mcp/fetch.ts`), `read_file` is `Untrusted:file` (the `read_attachment` channel), `book_list` is `Book`. Content never changes a label.

Arguments of `pay`. `payee` and `amount` are each one of three forms, and the server labels them as follows.
| Form | Labels | Mirrors |
| --- | --- | --- |
| `{ "handle": "h3" }`, the whole value of a handle | the handle's labels | R2 (a tool result keeps the tool's label) |
| `{ "handle": "h3", "quote": "4.2" }`, a substring of the handle's text (refused when it does not occur verbatim) | the handle's labels plus `Untrusted:quarantine` (a model chose the span) | R3 (extraction adds quarantine) |
| a plain string the client typed | `Owner` when the literal occurs in the owner's request (the product grounder, `runtime/src/interpreter/grounding.ts`, kind `name` or `address` for a payee, `amount` with the asset decimals for an amount); otherwise `Untrusted:quarantine` plus every untrusted label the session has returned so far | R1 and R8 (grounding), with the model's own text treated as derived from everything it read |

The payee is then looked up in the on-chain book with the alias rule of `resolveAlias` and labelled with `bookResult` (R5: `Book`, plus the key's labels when the key was untrusted). A payee the book does not know stays an address with its own labels. The pc is `Owner`: the trigger of the session is the owner's request, and the task bounds what any pay of the session can move (see the MCP client bullet in docs/THREAT_MODEL.md). The asset is `near` only in this version, so no data-derived asset argument exists.

Verdict. `pay` builds one ActionRequest (`labelsToBits` of the three label sets, `hints.plan_hash` from the task, `trace_digest` = sha256 of the label trace of that call) and submits it with `ChainClient.submitBatch`. The answer is the contract's outcome: `Allow` with the transaction hash, `Escalate` with the reason, the pending id and the owner's command `pnpm airlock approve <id>`, or `Block` with the reason. The server never retries a refused request under other labels.

## Decisions
- The task quick cap is a field of each registered asset (`quick_task_cap` in `asset_set`, AIR-042), not a flag: SPEC R3-09 says per asset, so `set_flags` carries only the task TTL and action maxima. SPEC 8.2 lists it under `set_flags`; the spec update of AIR-066 follows this line.
- An asset that is not in the registry can only block (verdict rule 0). Display symbols are unique across the registry and compared without letter case, so the approval screen never shows one symbol for two assets (AB6).
