---
name: airlock-invariants
description: Use before committing any change to the AIRLOCK security core (contract verdict or execution, interpreter propagation, planner input, quarantine extraction, tools labels, approval UI). A checklist that blocks the commit if any security invariant could be broken.
---

# Security invariants gate

Run through every item. If any answer is "no" or "not sure", stop and fix or add a test first.

## Contract
- [ ] I1 Nothing is signed unless the verdict is ALLOW or the owner approved that exact stored request.
- [ ] I2 Request ids are used at most once.
- [ ] I3 Only the owner edits policy, book, limits, measurements, PPIDs, MPC contract id.
- [ ] I4 Only a registered, unexpired, attested (or local-whitelisted) agent can submit.
- [ ] I5 The signed bytes encode exactly the certified recipient and amount (test decodes the unsigned tx from the event).
- [ ] I6 Caps, daily limits, fee cap hold under any labels (Kani P5).
- [ ] I7 Pending requests cannot be modified.
- [ ] I8 A forged, expired or used-up owner task signature, or an agent-chosen request id, is rejected.
- [ ] I9 An unknown label channel reverts the transaction; an empty pc blocks.
- [ ] I10 The exported method set equals the list in SPEC 8.2 (no `request_signature`).
- [ ] Every Allow and every approval charges every ledger before the next request is evaluated (Kani ledger harnesses pass).
- [ ] `cargo kani` reports 0 failures; no harness was weakened or deleted in this diff.

## Runtime
- [ ] The planner's input is only the owner request and the static tool list. No new path from tool output or extraction results to any planner call (grep for planner call sites).
- [ ] Every tool returns a fixed label chosen in code. No LLM output decides a label.
- [ ] New interpreter operations propagate the union of input labels plus the pc; branches and loops add their condition to the pc.
- [ ] Quarantine output is schema-validated (zod), length-limited, type-checked; nothing in it is executed or used as a tool name or URL without taint.
- [ ] Property test (fast-check noninterference) still passes with at least 1000 runs.

## UI
- [ ] Untrusted text renders only inside the quoted untrusted box, escaped, never as a title, button label, or instruction.
- [ ] The approval card shows each value's source, the book diff, and defaults to Reject.

## Repo hygiene
- [ ] No secrets, no `.env`, no submission payload staged. gitleaks clean.
- [ ] Attack payloads only in data files. Nothing addresses a reviewer.
- [ ] Docs and CLAIMS.md updated if behavior changed.
