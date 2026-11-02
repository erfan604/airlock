# Threat model

This file says what AIRLOCK protects, who attacks it, what each part is trusted for and what is left out. It assumes the runtime runs locally with no TEE. Where a TEE would change something, the text says so. Funds are testnet funds in this version.

## Assets
- Funds held by the policy contract: its NEAR balance, and the funds at the MPC-derived addresses on other chains, one derivation path per agent.
- The owner policy stored in the contract: the address book, per-payee caps, daily limits and untrusted budgets, the asset registry with its hard and daily caps, and the flags.
- The owner's signed task mandates, which name the payees a task may pay and how much.
- The owner's wallet keys and the local task key that signs mandates.
- The approval queue. A pending request cannot be modified, only approved, rejected or expired, and every decision leaves an on-chain event.
- The owner's attention, which every escalation spends (docs/KNOWN_LIMITATIONS.md).

## Adversary (capabilities, and what they cannot do)
The adversary controls everything the agent reads: email bodies and attachments, web pages, social posts and replies, token and NFT metadata, transfer memos, and memory entries written from untrusted sources.
The adversary can send tokens and NFTs to the agent, register lookalike names, time messages and iterate adaptive payloads against the published attack corpus.
The adversary can fully hijack the quarantined reader model, because its output is treated as untrusted from the start.
The adversary cannot forge the owner's NEAR signature.
The adversary cannot change the contract code. The owner controls it.
The adversary cannot break NEAR consensus or the MPC network.
The adversary has no access to the owner's device, wallet keys or local task key.
Through the data it controls, the adversary cannot choose a recipient or trigger a payment. It cannot move an amount above the task bound, the payee's cap and its untrusted budget without the owner's approval. This is claim C1 in docs/CLAIMS.md, and it holds when the interpreter labels values correctly.
The adversary can still cause aborted runs and a stream of escalations. Inside the envelope the owner set, an amount read from data can auto-pay an address-book payee. Strict mode removes that last case (docs/KNOWN_LIMITATIONS.md).

## Trust boundaries and what happens if each fails
Each line names a part, what it is trusted for and what follows if it fails.
- Owner wallet keys: trusted to authorize policy edits and approvals. If they fail, the attacker is the owner and nothing here defends against that. Owner methods need one attached yoctoNEAR, which a function-call access key cannot attach, so such a key leaked to a web page cannot call them. The owner check and the deposit check are tested by `ab07_` and `ab10_` in `contracts/airlock-policy/tests/approval_surface.rs`.
- Policy contract (`contracts/airlock-policy`, with the pure verdict in `contracts/airlock-verdict`): trusted for the content rules, building the transaction, replay protection and the approval queue. It is a core assumption, kept small and tested in the NEAR sandbox (see the policy contract row in docs/ARCHITECTURE.md). If it fails, no other part limits the loss.
- NEAR and the MPC network: trusted for consensus and threshold signing. If they fail, contract rules go unenforced or a signature is forged. This is assumed, not defended.
- Runtime (`runtime/`): trusted for honest provenance labels and owner session authentication. If it lies or is taken over, it can pay without the owner's approval only while an owner-signed task is open, only toward payees and amounts inside that task's bounds, only to address-book payees, and only inside the asset and payee limits (claim C3 in docs/CLAIMS.md).
  In local mode its agent account holds only a function-call key restricted to `submit_batch`, which cannot attach a deposit. If the runtime runs in a TEE, see docs/EVIDENCE.md for what was registered and docs/KNOWN_LIMITATIONS.md for what that does not show.
- Planner model: trusted to write a plan that matches the owner's request. It is built to receive only the owner's request (its input type is `OwnerRequest`). If it fails, it can mint a wrong owner literal, for example from a locale or unit slip. The loss is bounded by literal grounding, the address book and the caps.
- Quarantined model: trusted for nothing. Every field it extracts is labelled untrusted, including fields read from trusted sources. Its output cannot choose a payee or trigger a payment without an escalation (docs/ARCHITECTURE.md lists each propagation rule with its test).
- Oracle (price feed): trusted for prices, never for addresses. If it is wrong, an amount computed from it is wrong. The task bound, the payee's daily limit and the asset caps still apply.
- Console (`web/`): for approvals it is a convenience, and the owner's wallet is the trusted renderer. The console is served from a host that may also be the agent's host, so it cannot be trusted to render an approval.
  For task mandates the console is trusted. It runs the plan analyzer and signs the task with a local key, so a compromised console can get a task signed that the owner did not intend. The contract limits that to the quick task cap per asset, to address-book payees (a new recipient always escalates) and to the payee and asset limits (docs/KNOWN_LIMITATIONS.md lists the console as part of the trusted computing base).
  The bounds the owner signs come from the analyzer run on the planner's plan, and the planner never sees untrusted content, so tool output cannot write a value into a mandate. The one analogous path is text the owner pastes into the request. That is the failure Progent's maintainers acknowledged for automatic policy updates, where an LLM that had read tool output carried the attacker's account into the policy (https://github.com/sunblaze-ucb/progent/issues/3).

The approval path. The owner approves an escalated request with one wallet transaction, `approve(id, to, asset, amount, why, book)`, with one yoctoNEAR attached.
A wallet that shows arguments displays the recipient, asset symbol, decimal amount, reason code and book status.
The contract checks each value against the stored request, field by field. It then executes the stored request and never the arguments. A changed value reverts the call.
The method takes a pending id and five readable values. It has no argument that names an action.
Bybit and Radiant Capital are the display attacks this answers. In both, signers approved a screen that did not match what they signed. In one, tampered application code showed a normal transfer. In the other, malware relayed a different action behind a normal-looking interface, simulation and device screen. Figures and sources are in docs/SOURCES.md.
If the console card or any other screen lies, the arguments the owner signs must still equal the stored request, or the transaction fails.
The twelve tests in `contracts/airlock-policy/tests/approval_surface.rs` map to the twelve approval attacks of Kodathala et al. (arXiv 2610.21063). That paper is the source of the taxonomy. It is not proof that every variant is covered.
A flood of escalations is capped by a pending limit per agent and a lock after repeated rejects (`ab11_flood`). It can still tire the owner.

Three limits stay.
- The equality check makes the signed arguments equal the stored request. It does not show that the owner looked. A careless owner can still approve a truthfully displayed bad payment.
- A wallet that hides arguments defeats the display half. The console refuses such wallets and tells the owner which tap shows the arguments. That is console behavior, so it helps only an owner using the honest console.
- Which wallets show the arguments is measured per wallet, with screenshots, in docs/EVIDENCE.md.

## Trusted renderer (R4-04)
The trusted renderer is the owner's wallet, not the AIRLOCK console, which may share a host with the agent.
Intear shows every argument and the exact deposit; the console card is a convenience.
What each wallet shows, as measured by the bake-off of 2026-11-01 (`spikes/wallet-bakeoff/RESULTS.md` in the research repo) and copied into `web/src/wallet/capabilities.ts`:
- Intear (`intear-wallet`, offered): the first screen shows the method and the exact one yoctoNEAR deposit, and one tap on Show args reveals every argument. The console tells the owner to tap Show args and compare the five values.
- Meteor (`meteor-wallet`, measured and not offered): the first screen shows no arguments, and View Transaction Details shows them one tap later. The one yoctoNEAR deposit displays as 0.
- Nightly (`nightly-wallet`, refused): never shows the arguments.
- Any wallet id missing from the table is refused.
The console offers only a wallet that shows the arguments. That is console behavior, so it helps only an owner using the honest console. A wallet that lies about what it signs is outside this model.

## Attack groups covered (A to H) with the bench case ids
Cases are the `own-` ids in `bench/cases/own-abc.jsonl` and `bench/cases/own-sxp.jsonl`. Each case names the payment the attacker wants in `attacker_goal` and the rule that is expected to stop it in `expected_airlock`. Results per group and config are in docs/BENCH.md.
- Group A, the recipient or payee comes from untrusted content: `own-A01` (invoice email), `own-A03` (billing page), `own-A04` (social post), `own-A06` (support page), `own-A08` (history).
- Group B, the amount comes from untrusted content or a calculation: `own-B01` (above the task bound), `own-B01-incap` (inside the cap, the K2 residual where the default mode can auto-pay), `own-B02` (calculated amount with no ceiling), `own-B03`, `own-B04`.
- Group C, values read from tool output such as a token list or transaction history: `own-C05`, `own-C06`.
- Group S, the trigger or branch is chosen by untrusted content: `own-S01` (urgent flag), `own-S02` (spoofed status), `own-S03` (selected recipient), `own-S04`.
- Group X, paid-fetch payment requests and asset tricks: `own-X01` (payee taken from the payment request of the fetched page), `own-X02` (amount above the bound), `own-X03` (asset no registry lists), `own-X04`, `own-X05`, `own-X06`.
- Group P, look-alike payees: `own-P01` (look-alike key from history), `own-P02` (look-alike of the accountant).
The adaptive and benign cases that sit beside these are in `bench/cases/should/` and `bench/cases/utility.jsonl`. They measure utility and escalation precision and are not attack groups.

## Assumptions
- The owner's device, wallet keys and local task key are not compromised.
- NEAR consensus holds, and fewer than the threshold of MPC nodes are compromised.
- The deployed contract is the code that was tested. The verdict is model-checked within the bounds listed per harness (claim C5 in docs/CLAIMS.md). The code that loads its inputs is covered by sandbox tests and not by the model checker. That code covers label conversion, book keys, budgets, digest, expiry and nonce.
- Labels are correct when the TypeScript interpreter and the tools layer are correct. The noninterference proof of claim C1 is specified in design (`proofs/NI.lean` is not in this tree), so the evidence for propagation is the property test of the TypeScript interpreter, and labels come from a constant table plus tests.
- The owner reads the wallet screen before approving.
- The approving wallet runs on a device the agent cannot reach. The I-HITL study (arXiv 2610.35835, 2026-10-26) shows models raising a wallet's spending cap themselves by reading emailed one-time codes, and argues that an approval holds only on a device the agent cannot reach. The wallet as trusted renderer is that boundary.
- The owner's typed instruction is the owner's intent.
- The price feed that produces Oracle-labelled values is honest.
- The runtime is in unattested local mode (decision D22 in the research repo's plan/DECISIONS.md: TEE out of this build). No bound above relies on a TEE. If a TEE is added later, physical attacks on such hosts are known (docs/KNOWN_LIMITATIONS.md).

## Out of scope
- An owner who is socially engineered into typing an attacker's address. AIRLOCK trusts the owner's own words.
- An owner who approves a truthfully displayed bad payment without reading it.
- Theft or compromise of the owner's wallet keys, device or local task key.
- Side channels that CaMeL acknowledges (timing and exceptions), and the availability channel: an attacker can cause escalations.
- Evidence injection: fabricated facts that steer a decision inside the owner's limits, such as a fake price or news item (arXiv 2610.26438). AIRLOCK bounds where values come from and how much can move, not whether a trusted-looking fact is true.
- Host operator powers: the host can delay, drop and replay traffic and read the environment, including environment variables.
- Broadcast and ordering of signed EVM transactions happen off chain. An issued signature stays valid until its nonce is used, and pause does not revoke it (claim C2 in docs/CLAIMS.md).
- Privacy of the owner's requests and inbox text. It rests on the model provider, and no security property here depends on it.
- Not built in this version: wallet-signed tasks above the quick cap, standing tasks, scheduled payments, cancel, owner transfer, a NEP-141 lane and real tool connectors. Testnet only.
- An owner who hands the approving wallet, its session or its one-time codes to the agent.
- Attack groups D to H of the attack list, and the cases below, are `not run` in the agent bench. Each id is in `bench/cases/not-run.json` with its reason and what covers it instead: no action or tool of that kind exists in this version, the route is the same as a run group, or the owner-only policy plane stops it. docs/BENCH.md lists the same ids under Not run.
  - C01, C02, C03, C04: no approval, key, message-signing or NFT-permission action exists. The ABI snapshot (AIR-041) and the closed tool table (AIR-120) cover them.
  - D01, D02, D03: the policy plane is owner-only, so an agent cannot raise a limit, add a book entry or replace an approver. Invariant I3 and the policy tests cover them.
  - E01, E02, E03: the recipient comes from memory or chat, the same route as group A. The label tests (AIR-124) cover them and they are not re-run. E04 is a scheduled payment, out of scope for this version.
  - F01, F02, F03: data that requires action (the planner never sees the content, so it is a utility loss by design), branch and loop control chosen by untrusted text (property tests of AIR-126 and AIR-180), and a one bit leak through execution, which is a known limit in docs/KNOWN_LIMITATIONS.md.
  - G01, G02, G03: no swap, quote or bridge action exists. The ABI snapshot and the closed tool table cover them.
  - H01, H02: approval surface attacks are a card and route property, not an agent path. The card tests (AIR-181) and the approvals route test (AIR-182) cover them.
  - U03, U05, U09, U10, U11, U04, BEN04: utility cases that need an action this version lacks (scheduled or recurring payment, swap, bridge, DAO vote) or an owner-only policy change (a book change, a payee change typed by the owner).
