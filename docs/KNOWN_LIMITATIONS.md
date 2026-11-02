# Known limitations (honest non-fixes)

- An owner who is socially engineered into typing an attacker's address is out of scope: AIRLOCK trusts the owner's own words.
- Labels are only as correct as the runtime code. The runtime is unattested (local mode) unless a TEE registration tx is linked in docs/EVIDENCE.md. Either way the contract's content limits (book, caps) still hold if it lies.
- Side channels acknowledged by CaMeL (timing, exceptions) are not closed.
- Host-delivered env vars (API keys) are visible to the TEE host. Live model calls go only to NEAR AI Cloud's TEE models (`TEE_MODELS` in `runtime/src/llm/models.ts`), but AIRLOCK does not check their enclave quotes per call, so the privacy of the owner's requests and the inbox text rests on NEAR AI's own checks; no security property depends on it, because the planner and the reader are treated as untrusted, and each recording names the route that made it.
- Approval fatigue: escalations are rate-limited and batched, but a determined attacker can still generate approval requests. The only auto-executions an attacker can influence are amounts read from data to an address-book payee inside that payee's cap, its daily untrusted budget and the task bound (the K2 envelope; strict mode removes it).
- A local task key authorizes unattended spending up to the quick cap.
- The console is in the trusted computing base.
- Tools are fixtures (no real connectors); testnet only.
- No cancel (an issued but unbroadcast signature blocks later nonces for that path; use set_nonce or a new path); no owner transfer.
- A signing or transfer callback that runs out of gas leaves its request `Executing` and charged: no owner method clears it in this version, and the task ledger never resets, so that request's amount stays counted against its task. The lane reserves the callback's gas and AIR-107 measures the real burn on both the success and the refund path.
- An answer the contract cannot read after the signer's receipt succeeded (it does not parse, it is too long, or an EVM recovery id is above 1) keeps the request charged and `Failed`, because the signature may still be usable; the owner sees it in the `failed` event (`MpcBadResponse`, `retryable` false). Only a failed signer receipt, a failed transfer and an uncovered payment release the charges.
- Lean covers semantic models of the gate and the interpreter, not the shipped TypeScript (the TypeScript interpreter is covered by a property test).
- Future work, not attempted: extracting the Lean model from the Rust verdict crate with Aeneas (AeneasVerif/aeneas) so that the code-to-model link is itself a proof. Today the link is the differential test and Kani on the shipped Rust. The Aeneas Lean backend pins Lean v4.35.0 like we do, but it needs Mathlib, OCaml 5.3 and a pinned Charon, which this build does not carry.
- Local mode is unattested; host powers (a host can stop, delay or read the runtime) are not removed by any check here; oracle dust moves; plan_hash and evidence are unauthenticated hints; UTC-boundary burst.
- Wallet manifest pinning fixes which wallets the console offers, not the wallets' code: a wallet executor such as Intear's is a
  remote script that can change; the contract's recheck of the six approve arguments is the control.
- The console CSP allows inline styles and lists a per-wallet executor origin, because NEAR Connect 0.11.4 injects styles and loads wallet scripts from remote origins; scripts stay `'self'` plus a per-response nonce.
- The runtime's evidence store is in memory and is lost when the runtime restarts.
- The session cookie is `Secure`, so a demo over plain `http://<LAN address>` cannot log in; use localhost or HTTPS.
- near-api-js `FailoverRpcProvider` is not used; the runtime has a sequential `RpcPool` instead, so its failover behaviour is our own code.
- If the TEE lane ships, shade-attestation 0.2.0 pins dcap-qvl 0.4.0, which is inside advisory GHSA-6q6c-vvf9-fj3w (low: TCB
  component list truncation, patched in 0.4.1); AIR-201 asserts 16 SGX and 16 TDX components when parsing TCB info.
- Sandbox gas numbers come from neard 2.11.0 (protocol 83); testnet runs protocol 88, so published gas figures are the testnet
  measurements of AIR-107.
- Evidence injection: fabricated facts that steer a decision inside the owner's limits (for example a fake price or
  news item that makes a legitimate payee's in-cap payment look due) are out of scope; AIRLOCK bounds where values come
  from and how much can move, not whether a trusted-looking fact is true (arXiv 2610.26438).
- Untrusted text never enters planner memory; carryover memory attacks (arXiv 2610.28425) are blocked only because
  memory is always labelled untrusted.

## TEE mode is defense in depth, not a root of trust
Intel TDX and AMD SEV-SNP do not protect against an attacker with physical access. Since 2025, researchers have shown
that a memory bus interposer costing under 1000 dollars (TEE.fail) or under 200 dollars (DDRop) can extract the
key that signs TDX quotes or forge a launch measurement on a fully patched TDX machine, yielding a quote that verifies as
UpToDate. Intel and AMD call this out of scope and offer no fix. A host operator or insider could therefore run a
modified agent that passes our quote checks and reads its secrets. We pin the one approved CPU by PPID, which
narrows this to the machine the owner approved. What still holds is the contract: caps, budgets, the address book and
the owner-signed task bound what any registered agent can get signed. Signing also assumes fewer than the threshold of
NEAR MPC nodes are compromised; NEAR's own MPC threat model lists a physically probed TDX node as an open item.

## Upstream code we own
The contract's agent registration and verification code derives from NEAR's Shade Agent template (commit 816b75b) and the
`shade-attestation` 0.2.0 crate. NEAR stopped maintaining the Shade Agent Framework as standalone developer tooling
after April 19, 2026, and its repositories state it has not had a formal audit. We pin both, own the fork, and track
upstream security fixes ourselves.

