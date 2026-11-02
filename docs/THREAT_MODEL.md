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

## Attack groups covered (A to H) with the bench case ids
<!-- AIR-242 fills this section from bench/cases/*.jsonl and bench/cases/not-run.json. -->

## Assumptions
- The owner's device, wallet keys and local task key are not compromised.
- NEAR consensus holds, and fewer than the threshold of MPC nodes are compromised.
- The deployed contract is the code that was tested. The verdict is model-checked within the bounds listed per harness (claim C5 in docs/CLAIMS.md). The code that loads its inputs is covered by sandbox tests and not by the model checker. That code covers label conversion, book keys, budgets, digest, expiry and nonce.
- Labels are correct when the TypeScript interpreter and the tools layer are correct. The Lean noninterference theorem (`proofs/NI.lean`, claim C1) covers a model of the interpreter, not the TypeScript. The TypeScript interpreter is covered by a property test, and labels come from a constant table plus tests.
- The owner reads the wallet screen before approving.
- The owner's typed instruction is the owner's intent.
- The price feed that produces Oracle-labelled values is honest.
- If a TEE is used, the adversary has no physical access to its host. Physical attacks on such hosts are known (docs/KNOWN_LIMITATIONS.md), so no bound above relies on the TEE.

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
- Attack groups D to H of the attack list are outside the agent bench. Contract and card tests cover them, and docs/BENCH.md gives the reason.
