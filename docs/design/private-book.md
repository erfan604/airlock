# Decision AIR-326: the address book is a commitment, not a list

Status: design for the coordinator's approval, no code yet. Cut date 2026-11-11 23:59 MST.

## Problem

`get_book` and `get_book_entry` list every trusted payee with its label, cap, daily untrusted budget and daily limit, and the `book`
map, the `book_added` events and the ledger maps hold the same names in plain bytes (anyone can read raw contract state over the
`view_state` RPC, not only the views). For the doctored-amount attack that is a map: an attacker learns whom the owner trusts and how much
stays under each cap. The goal is that none of this is readable from the chain until a payment names a payee, and that the verdict, its
Kani harnesses and its Lean model do not change.

## The scheme in one paragraph (recommended: scheme A, a fixed-depth Merkle commitment)

The contract stores one 32 byte `book_root` and a counter `book_epoch`. The owner builds the book off chain as a Merkle tree of depth 8
(256 slots). Every slot is either an entry leaf or a random filler leaf. An entry leaf commits to a fresh 32 byte per-entry salt, the
canonical payee key and the entry's numbers. A request that pays a book payee carries the entry (salt, numbers) and its 8 sibling
hashes. The contract recomputes the leaf from the request's own payee, checks the path against `book_root`, and hands the verdict the
same `BookEntry` it gets today. A request with no proof, or a proof that does not verify, is a new payee (the verdict already escalates
`NewRecipient`), never a revert.

## Why not the plain "hash(salt, payee) as map key" of the ticket (scheme B)

The ticket's version is kept as the fallback (section "Fallback"). Three weaknesses decided against it as the main design:

1. One global salt is public the moment the first request carries it (request arguments are public in the transaction). Every
   other key could then be tested against a dictionary of account names. A per-entry salt fixes that, and is part of both schemes.
2. With keys in a map, the entry count is public (`len`), and every entry's numbers are public state, only unlinked from names. The
   distribution of caps is itself useful to the attacker (the largest cap bounds the best doctored amount for a guess).
3. Storage still grows per entry and is readable by prefix scan. With a root there is nothing to scan.

| Property | A: Merkle root | B: map keyed by H(salt_i, payee) |
| --- | --- | --- |
| Names readable from state or views | no | no |
| Cap, budget, limit values readable | no (until that entry is used) | yes, unlinked to names |
| Entry count readable | no (padded to 256 slots) | yes |
| Request size | about 0.8 KB more | about 0.1 KB more |
| Owner edit | one call, `book_set_root` | one call per entry |
| Revocation | next root, immediate | `book_remove`, immediate |
| Add-time checks in contract | none (moved off chain and to use time) | partial (asset known only if stored) |
| Estimated effort | 30 to 34 h | 20 to 24 h |

## Storage layout (new policy account, new Borsh layout)

Removed: `book: IterableMap<String, BookEntry>` and `StorageKey::Book`. Added, in the same place of the field table:

- `book_root: [u8; 32]`. Initial value: the root of 256 filler leaves (the owner's `init` or first `book_set_root` sets it; before that
  the empty root, so every payee is new, the strict default).
- `book_epoch: u64`, incremented by every `book_set_root` and `approve_and_remember`.

`BookEntry` loses `label`: `{ cap: Option<u128>, daily_untrusted_budget: u128, daily_limit: u128 }`. A label is a name, so it lives
only in the owner's vault. The verdict never read it.

Ledgers (`payee_spent`, `payee_untrusted_spent`, `task_spent`) stay keyed by the plain payee key. They are written only when a payment is
charged, so they name exactly the payees that a payment or an approved escalation already made public. No change.

`PendingInfo` (the stored record of an escalation) gains `payee_limit: Option<u128>` and `book_epoch: u64`: the entry's `daily_limit`
and the epoch seen when the escalation was stored. This replaces the read of the live book at approval time (see "Call sites").

## The leaf, the path and the proof

Hash: SHA-256 through `env::sha256` in the contract and `node:crypto` in the runtime (no new dependency on either side). Domain tags
make a leaf and an inner node distinct, so an inner node cannot be presented as a leaf.

```
leaf  = sha256( 0x00 || "airlock-book-v1" || salt[32] || u16be(len(payee)) || payee
                || u8(cap_is_some) || u128be(cap or 0) || u128be(daily_untrusted_budget) || u128be(daily_limit) )
node  = sha256( 0x01 || left[32] || right[32] )
filler leaf = sha256( 0x02 || random[32] )         (owner side only, never verified)
```

`payee` is the request's own `payee` string, so a proof cannot be reused for another payee: the leaf changes. The path is the 8 bit
slot index plus 8 siblings; the contract folds from the leaf up and compares with `book_root`. The depth is a constant in the contract
(8), so a proof of another length is rejected and there is no second-preimage shortcut through a shorter tree.

`SubmitRequest` gains one optional field, `book: Option<BookProof>` with `BookProof { salt: Hex32, cap: Option<U128>,
daily_untrusted_budget: U128, daily_limit: U128, index: u8, siblings: Vec<Hex32> }`. The Borsh and JSON shape change with the new
account; `abi_expected.txt` and `owner_methods.txt` are regenerated and reviewed.

Salt rules: 32 random bytes per entry, generated by the owner's vault on add, never reused after removal. The salt makes the leaf
unguessable even when the payee name and the cap are both guessable (a 100 NEAR cap on `accountant.near` is).

Duplicates: the contract cannot see two leaves for one payee. The owner is the only party who builds the tree, and the vault refuses a
second entry for the same canonical payee key. A request could pick either proof only if the owner committed two; this is an owner
trusted invariant, stated in THREAT_MODEL, not a contract check.

## How the verdict stays unchanged

The verdict function receives `Option<Payee>` from `verdict_inputs(asset, payee, bound, spent)` in `ledgers.rs`. `payee` is today
`self.payee(&req.payee)`; it becomes `self.book_entry(&req.payee, req.book.as_ref())`, which returns `Some(BookEntry)` only for a
verified proof and `None` otherwise. Everything after that call (caps, remaining, the verdict) is the same code on the same types.

- `contracts/airlock-verdict/` has no diff. Acceptance: `git diff main contracts/airlock-verdict proofs` prints nothing.
- Kani: the count `cargo kani` prints stays at its current number (36). Lean: `Verdict.lean`, `NI.lean`, `NI_recipients.lean` check as
  now; `scripts/diff-verdict.sh` runs unchanged.
- The new part (the membership check) is a pure function in `contracts/airlock-policy/src/book.rs` and is covered by unit and property
  tests, not by Kani: its soundness is SHA-256 collision resistance, which Kani cannot model. CLAIMS gets a row that says so.

## Call sites and views that change

Contract (`contracts/airlock-policy/src/`):

| Where | Today | Change |
| --- | --- | --- |
| `policy.rs` `BookEntry`, `BookEntryView`, `book_add`, `book_remove`, `get_book_entry`, `get_book`, `payee()` | map, label, listing views | `BookEntry` loses `label`; `book_add`, `book_remove`, `get_book_entry`, `get_book` removed; new owner call `book_set_root(expected_old: Hex32, new_root: Hex32)` (compare and swap, epoch plus one, emits `book_root_set` with both roots); new views `get_book_root()` and `get_book_epoch()`; `payee()` becomes `book_entry(payee, proof)` |
| `request.rs` `SubmitRequest` | no book data | `book: Option<BookProof>`; the request hash and the `trace_digest` rules are unchanged (the proof is not part of the label trace); the stored `RequestRecord` does not keep the proof except the two `PendingInfo` fields above |
| `gate.rs` `evaluate` (line 165), `preview_at` | `self.payee(&req.payee)` | `self.book_entry(&req.payee, req.book.as_ref())`; `EvalCtx.payee` keeps its type |
| `escalation.rs` `book_in` at store time (130), `preimage_of`, `book_status` | `ctx.payee.is_some()` | unchanged expression, now fed by the verified entry; the approve digest still holds `in_book`/`new` |
| `escalation.rs` approve charge (317) | reads the live book for the payee limit | uses `PendingInfo.payee_limit` if `book_epoch` equals the current epoch, otherwise `None` (no limit, which is the existing "left the book" behaviour: the payment is still recorded in the day ledger) |
| `escalation.rs` `remember_payee` (341 to 392), `approve_and_remember` | inserts `BookEntry` with label | takes `expected_old: Hex32`, `new_root: Hex32` and a `BookProof` for the remembered entry; checks the proof verifies against `new_root` for the stored payee and that cap and daily limit satisfy the existing rules (`CapBelowAmount`, `CapAboveAssetCap`, `DailyBelowCap`); then compare and swap of the root. `AlreadyInBook` becomes: the old root must equal `expected_old`, and the owner's vault is what stops a duplicate. The `label` argument is removed |
| `ledgers.rs` `get_ledgers` (309) | looks up `self.book` for caps | takes an optional `book: Option<BookProof>`; without a proof the caps read 0, as for an unknown payee today |
| `internal/events.rs` `BookAdded`, `BookRemoved` | key, label, caps in clear | replaced by `BookRootSet { old, new, epoch }`; `docs/events.md` updated |
| `lib.rs` field table, `StorageKey::Book` | | the layout table and `tests/storage_layout.rs` change |
| `redteam.rs`, in-file tests in `gate.rs`, `ledgers.rs`, `callback.rs`, `escalation.rs`, `policy.rs` | `c.book.insert(...)` | a `testutil` helper `with_book(entries) -> (root, proofs)` replaces the inserts |
| `views.rs`, `agents.rs`, `x402.rs`, `exec.rs`, `callback.rs` production code | no book reads (checked by grep) | none |

The x402 lane builds its own request through the same `evaluate`, so it needs the proof field filled by its caller only.

Tests under `contracts/airlock-policy/tests/` that call `book_add` or `get_book` (about 20 files: `book.rs`, `common/mod.rs`,
`gate.rs`, `escalation.rs`, `remember.rs`, `views.rs`, `events.rs`, `gas.rs`, `invariants.rs`, `idempotency.rs`, `callback.rs`,
`exec_near.rs`, `x402.rs`, `approval_surface.rs`, `abi_*`): the shared `common` helper changes once, so most follow.

Runtime (`runtime/src/`):

- New `runtime/src/vault/` (pure TS, no Node import in the part the console shares): vault file format, tree build with random fillers,
  `proofFor(payee)`, `rootOf(vault)`, add, remove, uniqueness and canonical-key checks (the checks `book_add` made on chain, including
  the asset in the registry and `checkBookAdd` look-alike), label handling. File `~/.airlock/book.vault.json`, mode 0600 (same
  directory and trust as the task key and `mcp.json`), listing `{ payee, salt, cap, daily_untrusted_budget, daily_limit, label }` and
  the filler seeds so the root is reproducible.
- `chain/near.ts` `getBook()` and `chain/types.ts` `BookPageSchema`: `getBook()` now returns `BookRows` from the vault after checking
  that `rootOf(vault)` equals the chain's `get_book_root`; a mismatch is a `ChainError('BookStale')` and the run refuses to start. The
  `BookRows` type and `resolveAlias`, `bookResult`, `bookFromRows` (the analyzer ctx) are unchanged, so the interpreter, the plan
  analyzer and the look-alike code do not change. `submitBatch` adds `book: proofFor(payee)` for a payee that resolved through the book.
- `mcp/session.ts` (`bookList`, line 268; pay, line 357): `pay` reads the vault the same way. `book_list` stops returning keys (see
  decision D1): it returns the aliases the owner marked `listed` in the vault, none by default. A payee still resolves by alias or key
  for the server's own lookup, and the model never holds a salt, a proof or a cap.
- `server/main.ts` (line 139 and 197) and `demo/replay-server.ts`: the book snapshot comes from the vault; the replay server builds a vault
  from `fixtures/demo` so the recorded runs keep their book. The chain recordings under `runtime/recordings/chain/` that hold `get_book`
  answers are re-recorded or replaced by vault fixtures; the `submit_batch` argument goldens gain the proof field.
- `scripts/bootstrap-policy.sh` (lines 52, 128 to 132, 204 to 213): builds the vault from the policy file and sends one
  `book_set_root`; its verify step compares `get_book_root` with the vault instead of reading entries.

Console and hosted pages (`web/src/`):

- `chain/reads.ts` `getBook`: reads the vault (see below) and `get_book_root`, never `get_book`. `fixtures/preview.tsx` and
  `fixtures/wallet.tsx` keep their `getBook` stubs, now vault shaped.
- Local console (served by the runtime): the runtime serves `GET /book` behind the owner session that already guards the task routes; the console
  asks the runtime for the vault rows. No salt is written to browser storage.
- Hosted static approvals page (no server, wallet only): the escalation card is built from the contract's own record (`in_book` or
  `new` from `get_request`, the payee, the amount), so the owner's approval stays safe without the vault. The look-alike diff and the
  book label need the book: the owner may drop the vault file onto the page (kept in memory only, never sent anywhere, the CSP already
  blocks other origins). Without it the card says "Book not loaded: the look-alike check did not run", never "No close match in your
  book" (`BookDiff.tsx` line 37 would otherwise assure falsely over an empty list). A test pins this.
- `approvals/Card.tsx`, `BookDiff.tsx`, `ApprovalsRoute.tsx`: `bookKeys` and `bookLabels` come from the vault or are absent; an absent
  book is a typed state, not an empty array.
- `challenge/chainBoard.ts`: the public challenge reads the old challenge policy account, which stays as it is (its book is public by
  design, it is a staged demo). No change, and the page text says which account it reads.
- Try page (`web/src/try/`): runs the verdict as WASM on a stand-in world held in the page, and reads no chain. No change.

Docs: THREAT_MODEL, KNOWN_LIMITATIONS, README, CLAIMS (new rows), ARCHITECTURE (components table and data flow), events.md, QUICKSTART
(`pnpm airlock book add`), EVIDENCE after the testnet run.

## What stays readable, and why

| Leak | When | Why it cannot be closed here |
| --- | --- | --- |
| A paid payee, its salt, its cap, budget and daily limit | at every request that names it, including held and blocked ones, in the transaction arguments, and in the record, ledger keys and events | the contract must know the payee to build the transaction and the cap to run the verdict; a NEAR transfer or a signed Base transaction names its recipient anyway. Only that entry is exposed, not its neighbours. |
| The payees of a task | when its first request is submitted | the owner's signed task carries the payee keys it may pay (`bounds`), in the call arguments, even for payees never paid. A task that names three payees shows three. Mitigation: a task names only the payees the request needs (the console already builds it that way). |
| The approved payee of an escalation | at approval | it is the point of the card. |
| That a book exists, its size class | always | the root is 32 bytes either way; 256 slots are padded, so any count up to 256 looks the same. The depth 8 is public. |
| Edit timing and count | at each `book_set_root` | the call is public; its contents are two hashes. A burst of edits shows that the owner is changing the book. |
| Request volume and timing | always | the contract needs them for the flood counters and ledgers. |
| The cap distribution after many payments | over time | each used entry exposes its numbers; after the owner has paid most payees, most numbers are known. |

Not leaked: an unpaid payee's name, label or numbers; the count; the salt of any entry the owner has not used; which slot index is
real (fillers and entries are indistinguishable hashes). A dictionary attack on account names is stopped by the 32 byte per-entry salt,
because the commitment never contains the name alone.

New trust, stated plainly: the owner's vault now holds what the chain used to hold. A stolen vault file reveals the book (before, the
book was public, so this is no regression) but does not widen what a taken-over runtime can pay: it can only build proofs for leaves the
owner committed, so claim C3 is unchanged. The untrusted MCP client model gets no salts, no proofs and no caps.

## Migration

A new policy account runs the new wasm; the old accounts are not touched and keep their public book (their recorded evidence in
docs/EVIDENCE.md stays valid and the challenge keeps its account). Steps: `bootstrap-policy.sh` on the new account with the existing
`fixtures` policy file: registry as before, `set_task_key`, vault built from the file's `book`, one `book_set_root`, then the verify
step. No state is copied. Testnet only; a mainnet account needs the author's yes. The runtime picks the account from its config, so the
choice of old or new is a config value and nothing in the runtime branches on the contract version except `getBook()` (it checks for
`get_book_root`; a contract without it is read through `get_book` as today, so a still-running old demo keeps working).

## Test plan (failing tests first, each committed red, then green)

Contract, native in-process and sandbox:

1. `book_set_root` is owner only (1 yocto), compare and swap: a stale `expected_old` reverts, epoch increments, event has two roots.
2. Membership: a valid proof verifies and returns the exact `BookEntry`; the same proof with another payee string, another cap, a
   flipped sibling, another index, a shorter or longer path, or an old root is `None`; a proof never reverts a request.
3. Leaf and node are distinct: an inner node submitted as a leaf does not verify.
4. Property test (proptest): random trees of 1 to 256 entries; every committed entry verifies, no non-member does.
5. Gate equivalence: the existing gate, ledger, escalation, callback and x402 suites rerun with the helper that commits their book;
   every verdict outcome, reason and ledger value is identical (these are the old tests, unchanged in their assertions).
6. Approval: stored `payee_limit` is used at the same epoch; after a `book_set_root` between submit and approve the charge has no limit
   and the request still executes; `approve_and_remember` rejects a proof that is not in `new_root`, a stale `expected_old`, and the
   three cap rules.
7. Privacy sandbox test (`tests/private_book.rs`): deploy, commit a book of known names, labels and caps, run a payment to one
   entry, then (a) dump every view the ABI lists plus `get_book_root`, (b) read raw state with `view_state` over the empty prefix,
   (c) read every event log; assert that no unpaid payee's name, label or cap appears in any of them as text, hex, base64 or decimal,
   and that the paid one appears only where the payment put it. Add a dictionary pass: sha256 and keccak of 1000 candidate names,
   including every real one, with and without 16 and 32 byte guessed salts, never match any 32 byte value in state.
8. Removed methods: `get_book` and `get_book_entry` are absent from the ABI snapshot.
9. Gas: `tests/gas.rs` rerun; the 8 hashes per request must stay under its ceilings (expected to cost under 1 Tgas, to be measured).
10. `git diff main contracts/airlock-verdict proofs` is empty; `cargo kani` prints the same harness count; Lean files check with no
    `sorryAx`; `scripts/diff-verdict.sh` passes.

Runtime and web:

11. Vault: build, reload, same root; duplicate payee refused; non-canonical key refused; filler leaves differ per vault; `proofFor` of a
    removed entry is absent.
12. `getBook()` refuses a stale vault (root mismatch) and runs unchanged on an old account.
13. MCP: `book_list` result contains no key, no cap, no salt; `pay` by alias attaches the proof; a model-typed unknown payee carries
    none; existing `mcp.test.ts` and `mcp.guard.test.ts` pass with the new fixtures.
14. Console and approvals: with the vault the look-alike diff runs as before; without it the card says the check did not run; an
    approval of an `in_book` request works without the vault.
15. `scripts/check.sh quick` during work, `scripts/check.sh full` at the end, each written to a file and its exit code tested.
16. A recorded testnet run on a fresh account: one allowed payment to a vault payee, one escalation approved, one `book_set_root`, and
    the state dump of the privacy test run against that live account. Mainnet is not touched.

## Decisions I need from the coordinator

- D1: `book_list` over MCP returns aliases the owner marked `listed`, none by default, and never keys. Alternative: keep returning
  all aliases and keys (leaks the book to the untrusted model, which defeats the point).
- D2: depth 8 (256 payees). Depth 10 (1024) costs 2 more hashes and 64 more bytes per request. 256 covers every demo and owner so far.
- D3: approval charge uses the snapshot `payee_limit` with the epoch rule above. Alternative: the owner's approve call carries a proof;
  rejected because it changes the 200 byte `approve` arguments claim.
- D4: labels leave the chain (vault only).
- D5: scheme A as the main design, scheme B as the fallback (below).

## Fallback (scheme B)

If the contract suite is not green by 2026-11-10 12:00 MST, switch to B: `book: LookupMap<[u8;32], BookEntryNoLabel>` keyed by
`sha256("airlock-book-v1" || salt_i || payee)`, a per-entry salt in the request, `book_add(commit, ...)` and `book_remove(commit)`,
`get_book_count()`. It keeps the same call sites, vault and tests 1 to 15 with the Merkle items replaced; it hides names but exposes the
count and the unlinked caps. The README must say so in that case.

## Effort against the cut date

Hours of focused work after approval: contract and its unit tests 8; adapting about 20 contract test files, the common helper and
redteam 6; privacy sandbox test and gas 2; runtime vault, chain client, MCP, server and replay fixtures 8; web reads, approvals
states and fixtures 4; bootstrap script and one testnet run 3; docs 2; `check.sh full` cycles and fixes 3. Total 36 h (scheme B: 24 h).

The ticket says 12 h; that is the scheme B contract part only. Today is 2026-11-07 evening MST. If approval comes by 2026-11-08 09:00
and the lane works 10 h a day, the plan is: Nov 8 contract and tests green (M1), Nov 9 runtime and MCP (M2), Nov 10 web, bootstrap,
testnet run (M3), Nov 11 docs, `check.sh full`, fixes, with about 8 h of slack for the testnet signer and RPC weather. It fits
with little margin. Risks: re-recording the chain recordings and goldens, the sandbox suites at about 25 s each across 20 files, and
`check.sh full` (Kani, Lean, web build) being slow. If M1 slips past Nov 9 morning, cut to scheme B.

## Withheld proofs

In-book status comes from the request: the contract treats a payee as booked only when the request carries a proof that verifies for
its own payee string against the current root. A compromised agent can therefore leave the proof out for a payee that is in the book.

- What a compromised agent can do: hold a booked payment as new. The request becomes `NewRecipient` (or `BookLabelNotInBook` when it
  also claims the Book label), the card says `new`, and the owner is asked. That costs the owner attention, nothing more.
- What it cannot do: pay anyone without the owner's tap, and fake in-book status. A proof for payee A on a request to payee B, a proof
  of an earlier root, a tampered number and a proof of another slot all fail the same way (tests in `tests/withheld_proof.rs` and
  `tests/book.rs`).
- The residual: an owner-approved charge for a payee held as `new` is bounded by the asset caps and the task bound, not by that payee's
  daily limit (the approval path has no limit for a payee outside the book). The owner sees `new` on the card and the real payee
  and amount; the daily limit is a control on automatic payments, and an approval is the owner's decision.
- Duplicate leaves: `approve_and_remember` can add a second leaf for a payee when the escalated request carried no proof, because the
  contract cannot list its book. The runtime vault refuses a duplicate (M2), and the owner's approval surface says "in your book, but
  the agent sent no proof" when an escalation says `new` for a payee the vault holds, flagged as a sign the agent may be compromised.
- Why the contract cannot check non-membership today: proving that a payee is absent needs a sorted tree with adjacent-leaf proofs,
  which hides less (leaf order reveals ranges) and costs a different leaf design. That is a later option, not a claim of this version.

## Mutation check

Each mutant was applied alone to the committed M1 code, the named suites were run, and the file was restored with `git checkout`.
Each run is cargo test with the failing-test list kept, for the suites named, and the wasm is rebuilt for the sandbox ones.

| Mutant | Killed by |
| --- | --- |
| a. the proof check ignores the root (any path is in the book) | `book::tests::book_a_proof_fails_for_another_payee_number_index_path_or_root`, `book::tests::book_an_inner_node_is_not_a_leaf`, `policy::tests::book_root_starts_zero_and_every_payee_is_new`, `policy::tests::book_set_root_swaps_checks_the_old_root_and_counts_epochs` |
| b. the epoch is ignored on approve and on remember | `approve_after_the_payee_left_the_book` (both places at once); the remember part alone (b2) is killed by `remember_after_the_book_changed_is_not_already_in_book` |
| c. `book_set_root` without its compare and swap | `policy::tests::book_set_root_swaps_checks_the_old_root_and_counts_epochs` |
| d. `book_set_root` callable by the agent | `policy::tests::book_set_root_is_owner_only_with_one_yocto`, `redteam::rt_con_book_set_root_by_agent_reverts` |
| e. an approval ignores the payee limit stored with the escalation (the limit would have to come from somewhere other than the record) | `approve_at_the_same_epoch_saturates_the_payee_ledger_at_the_stored_limit` (added by this check; the old suites missed it) |
| f. `book_in` is true whatever the proof | `escalation::tests::store_pending_fills_display_digest_and_indexes`, `redteam::rt_appr_remember_cannot_set_cap_below_amount`, `redteam::rt_appr_remembered_payee_has_no_untrusted_budget`, and in the sandbox `a_withheld_proof_is_held_as_new_and_the_approval_ignores_the_payee_limit`, `another_payees_proof_does_not_make_a_payee_a_book_payee`, `a_proof_of_the_previous_root_is_not_in_the_book` |

Mutants b (remember part) and e survived the first run of the suites; the two tests named above were added and now kill them.

## Test helpers

`tests/common/mod.rs` keeps the old names `book_add` and `book_remove` as test vocabulary only. The contract has neither method: the
helpers compute the new root and the entry's proof off chain, the way the runtime vault does, and call `book_set_root`. A request
that must reach the contract without its proof carries `"book": "withhold"`.

## What the model can learn

The MCP server holds the vault; the model never gets a salt, a proof or a number. `book_list` returns only the aliases the owner marked
`listed`. `pay` resolves only listed aliases for the model: an unlisted alias takes the unknown-alias path and gets the same reply, and a
book payee is shown by its alias, never by its account (the owner's task bounds, which are owner text, still resolve every alias).

The residual: a model that types a raw account id it guessed can tell from the verdict whether that account is in the book (an
in-book payee within its cap is allowed, a stranger is held). Each successful probe is a real capped payment to that payee and shows
in the owner's ledger, so a probe costs money inside the envelope the owner already set and is visible. The payee becomes public at
that payment anyway.
