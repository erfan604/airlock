# Prior art and what is new here

| Work | What it does | What AIRLOCK adds |
| --- | --- | --- |
| CaMeL (Debenedetti et al., 2025) | dual LLM, capability interpreter, deny-only banking policy | program-counter taint for trust, amount provenance, graded approvals, on-chain enforcement |
| FIDES (Microsoft, 2025) | information-flow control for planners | wallet setting, on-chain gate |
| FIDES as shipped in Microsoft Agent Framework (microsoft/agent-framework, MIT, merged 2026-05-05) | integrity and confidentiality labels on content, variable hiding so untrusted content never enters the planner context, a quarantined LLM tool and policy middleware on tool calls (281 tests) | pc taint, amount provenance and per-channel origin bits on every value, and enforcement at the signer (a contract that releases the signature) instead of agent middleware |
| Interbolt (deconvolute-labs/interbolt, Apache-2.0, 2026; benchmark in deconvolute-labs/interbolt-agentdojo) | provenance-gated tool calls: `taint()` marks untrusted strings, a YAML plus CEL policy allows, blocks or asks from the provenance of the arguments, no model in the decision path; self-reported AgentDojo banking attack success 0 of 144 under policy against 71 of 144 undefended (gpt-4o-mini, two repeats) | pc taint (control-flow influence, not documented in its README or ARCHITECTURE.md), amount provenance, a value-level interpreter over a plan DSL instead of marked strings that plain string operations can launder, and enforcement at the signer: a NEAR contract whose verdict is checked by Kani and Lean releases the signature |
| PACT (arXiv 2605.11039) | per-argument provenance | consensus-enforced signing authority |
| Sleeper Channels (arXiv 2605.13471) | owner-attested action digest | TEE-attested runtime, contract-built tx |
| ROPE (arXiv 2608.27496) | admission rule: values reach state-changing tools only if they trace to the user or user-named sources | enforcement in the signing authority (NEAR contract), contract-built tx, proofs |
| ToolFence (arXiv 2609.37196) | provenance-aware tool authorization | on-chain gate, wallet-specific cases |
| Bactrian (MoonBit, 2026-10-11) | CaMeL-style labelled interpreter, payee prompt | chain enforcement, NEAR, proofs |
| COBRA (arXiv 2610.03089) | branch-steering attacks, 89.5% ASR on vanilla dual-LLM agents | program-counter taint as a proven rule (Kani P1) |
| multi-CaMeL (arXiv 2610.05640) | CaMeL guarantees do not compose across agents | single signing authority on chain |
| IronClaw (NEAR AI) | content-based injection defenses, attested-signing plan (unmerged #6532) | origin-based release at the signing authority (the same prepare and spend split, with value-level provenance in the prepare plane; no IronClaw integration is shipped) |
| AP2 mandates, wallet policy engines (Privy, Turnkey, Crossmint, CDP, OutLayer, x402) | what was authorized in advance; content rules | where each value came from, at signing time |
| OutLayer Agent Custody (NEAR) | TEE-held keys with whitelists, limits and multisig; stateful limits live in the coordinator database (its CUSTODY.md) | limits and provenance enforced in the contract that releases the signature, ledgers on chain |
| Shade Agent guardrails (NEAR docs, security.md) | build the transaction inside the contract instead of signing agent-supplied payloads | the same rule plus value-level provenance on every field the contract builds |
| NEAR Intents and Bitte near-ca | signed intents and an agent wallet contract; chain-abstracted accounts for agents | which values an agent may set at all, decided from where they came from |
| "Approve What, Exactly?" (arXiv 2610.21063) | effect binding and trusted rendering for agent approvals; 4 of 8 runtimes fail binding, none caps floods | binding enforced by the signing contract itself; provenance decides which requests need approval at all |

TEE entries apply only if docs/EVIDENCE.md links a TEE registration transaction; otherwise the runtime is in local mode (unattested).

| Neighbour | What it checks | Difference |
| --- | --- | --- |
| GUARDDOG, Mandate, NearVault (NEAR HACKATHON security track) | caps, allowlists, blocklists, honeypots, human approval above a threshold | content-based; no value origin |
| Notary (2026-10-16) | provenance labels on values, a pure monitor | no chain enforcement, no proofs |
| NEAR Business (2026-10-20) | SputnikDAO threshold approval before an MPC signature | human vote on every action; AIRLOCK routes only tainted requests to a human |
| Pink Overspend Challenge (2026-10-10) | deterministic policy engine, public break-it bounty | content rules; its three paid bugs are pinned as AIRLOCK contract tests |

Verification precedent (the method is not new; applying all of it to an agent payment gate is, to our knowledge):

| Work | What it verifies | Relation to AIRLOCK |
| --- | --- | --- |
| Cedar (AWS, arXiv 2407.01688, FSE 2024) | Lean model with proofs plus differential random testing against the Rust implementation (verification-guided development) | the method AIRLOCK follows, at much smaller test volume, plus Kani on the deployed Rust |
| Kani (arXiv 2607.01504) | bounded model checking of Rust | used on the verdict and ledger crate; bounds stated per harness |
| LLMbda calculus (arXiv 2602.20064) | probabilistic noninterference for an agent calculus, mechanized in Lean 4 | the general mechanized result exists; AIRLOCK's theorem is scoped to its own plan interpreter model |
| PASS (arXiv 2604.22602) | Lean 4 model of wallet subaccounts; "provenance" means custody lineage of assets | AIRLOCK's provenance is the origin of each value an agent uses |
| L3M (Amazon, arXiv 2610.19591) | Lean 4 agent runtime: capability confinement, monotone authority, budget bounds | similar honesty about what each theorem rests on; no signing gate |
