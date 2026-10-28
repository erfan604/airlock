---
name: airlock-contract
description: Use when building, testing, changing, or deploying the AIRLOCK NEAR contracts (contracts/airlock-verdict and contracts/airlock-policy) on macOS. Covers the toolchain quirks, the TDD and proof order for new rules, sandbox tests, gas checks, and wasm release.
---

# Working on the AIRLOCK contracts

## Toolchain (macOS arm64, verified 2026-10-21)
- `source scripts/env.sh` first. It points `CC_wasm32_unknown_unknown` at Homebrew llvm clang and sets `CFLAGS_wasm32_unknown_unknown=-mcpu=mvp`. Apple clang has no wasm target, and clang 23 without `-mcpu=mvp` emits post-MVP features that fail validation ("Failed to validate wasm").
- rustc 1.86.0 via `rust-toolchain.toml` in contracts/airlock-policy. cargo-near 0.22 rejects newer rustc for near-sdk 5.26 ("max rustc allowed: 1.86.0").
- Build: `cargo near build non-reproducible-wasm --no-abi` (about 15 s warm). Output `target/near/*.wasm`.
- Tests: `cargo test` runs unit tests and near-sandbox integration tests natively (no Docker). First run downloads the sandbox binary.
- Proofs: `cd contracts/airlock-verdict && cargo kani` (Kani 0.68 has its own nightly, do not override it).

## Adding or changing a verdict rule (order is mandatory)
1. Write the property as a Kani harness in `contracts/airlock-verdict/src/lib.rs` (`#[kani::proof]`), run `cargo kani --harness <name>`, see it fail or be vacuous.
2. Add a unit test with concrete values.
3. Change `verdict`. Re-run all harnesses: `cargo kani` must report 0 failures. If Kani prints a counterexample, decode it with `-Z concrete-playback --concrete-playback=print` before deciding whether the code or the property is wrong.
4. Add or update a sandbox test in `contracts/airlock-policy/tests/` that exercises the rule through `submit_batch`.
5. Update the rule table in docs/ARCHITECTURE.md and the claim row in CLAIMS.md.

## Contract rules
- The contract is the only place that builds signed bytes. Never accept a payload hash from the runtime; build the tx (omni-transaction, `default-features = false, features = ["evm"]`) and hash it in the contract.
- Every state-changing owner method calls `require_owner()` first; every agent method calls `require_valid_agent()` first and returns its failure promise if any.
- Request ids are single use. Pending requests are immutable: only `approve` or `reject`.
- Overflow checks are on in release; still use `checked_*` for any arithmetic on amounts and daily totals.
- After a change that affects gas, log `total_gas_burnt` in the sandbox test; keep a clean submit under 30 Tgas.

## Release
`cargo near build non-reproducible-wasm --no-abi`, copy the wasm to `contracts/airlock-policy/res/`, record its sha256 and the deployed code hash in docs/EVIDENCE.md.
