# Evidence log

| What | Network | Id / hash / link | Date |
| --- | --- | --- | --- |
| Planner and vanilla model | NEAR AI Cloud | `z-ai/glm-5.3-flash` (providerType vllm, NEAR private TEE); results.md sha256 aa0fdca3570f | 2026-11-01 |
| Quarantine model | NEAR AI Cloud | `z-ai/glm-5.3-flash` (providerType vllm, NEAR private TEE); results.md sha256 aa0fdca3570f | 2026-11-01 |
| Mutation testing of the verdict crate | local | cargo-mutants 26.0.0 (`scripts/mutation.sh`): killed 452 of 464 viable mutants, 12 survivors, all equivalent and listed in `docs/mutation.md` | 2026-11-01 |
| Policy contract deploy | NEAR testnet | account `policy.erfan-airlock.testnet`, code_hash=2xJLysGG7zfXeu6aV1MQz7FjQMXHND199D9qYFkiX3WC (hex 1d063e2eee291efddc4d508e4b17626c993fe2e888f946bf4414e9f391b0d805), wasm_sha256=1d063e2eee291efddc4d508e4b17626c993fe2e888f946bf4414e9f391b0d805 (the on-chain code hash equals the sha256 of the committed res/airlock_policy.wasm), tx [5Fbin4xrdCx3yWdfPC11fYWSRjSsXz5NU9U9z35WHDgG](https://testnet.nearblocks.io/txns/5Fbin4xrdCx3yWdfPC11fYWSRjSsXz5NU9U9z35WHDgG), full_access_keys=1, commit dfbe646, wasm is over 900 KB (1044856 bytes) | 2026-11-02 |
_To fill during the build: contract account, code hash, wasm sha256, agent registration tx, measurements, MPC sign txs, Base Sepolia txs, escalation and approval txs_

## Model choice

planner model: z-ai/glm-5.3-flash, chosen on the criteria in order: benign task success first (the highest of the affordable models, with the fewest error rows), then cost per 1,000 calls from PRICES (USD 0.08 per million input tokens and 0.50 per million output tokens, measured about USD 0.06 per 1,000 calls), then mean latency (3.4 s per call at low reasoning effort), then JSON-schema acceptance (accepted, with the JSON in the answer and not in the reasoning), then the TEE flag (providerType vllm with attestation supported). Reasoning effort is low; the same model runs on both sides of the comparison.
quarantine model: z-ai/glm-5.3-flash, the same model as the planner, so one prompt cache and one budget line serve both roles; it passed the JSON-schema probe with finish reason stop, and it is a TEE model, which the quarantine role requires.
vanilla models: z-ai/glm-5.3-flash only, so the baseline shares the planner model. The default reasoning effort cost about eight times as much per call and ran at 26.5 s per call for the same safety, which is why low is recorded. Kimi K3, Qwen3.8 and Qwen3.6 were measured or priced and not chosen. The tables are in the research repository, found by the sha256 hashes in runtime/config/models.json.

## Real MPC (AIR-102)

| What | Network | Id / hash / link | Date |
| --- | --- | --- | --- |
| Real MPC signature | NEAR testnet and Base Sepolia | https://testnet.nearblocks.io/txns/B14u88m5jtGz4weD367zsdgt2HwGbFczztdjAxXJ5xrY https://sepolia.basescan.org/tx/0x7e094201ddc1afb386d1944d7bf35f5aafd3a3f9afe8212cb4b70263dd3ca1d0 | 2026-11-02 |

- 2026-11-02: contract policy.erfan-airlock.testnet, code hash 2xJLysGG7zfXeu6aV1MQz7FjQMXHND199D9qYFkiX3WC, derived address 0x16C089aAd87dEcf4eAaa4a4AFEB5926BcD11B410, SIGNER WEATHER GOOD n=116 p50=4.2s p90=4.6s failed=0 (0.0%) 2026-11-02 09:35Z

- 2026-11-02: LATENCY n=20 p50=9.1 p95=10.4 max=11.3, SIGNER WEATHER GOOD p50=4.2s 2026-11-02 09:40Z

## Testnet end to end (AIR-165)

| Date (UTC) | Case | Outcome | Tx | Request id | Contract |
| --- | --- | --- | --- | --- | --- |
| 2026-11-02 | U01 | allowed - | https://testnet.nearblocks.io/txns/Ez3TXJatuT7neuVkuLM2jSMHcC5xWmxwmK4vF8pdxcLF | 8bd7cd7be93a4eb78420b0092463a9293ebb6a2ac45375807520a0a73e9d5758:0 | policy.erfan-airlock.testnet |
| 2026-11-02 | B01 | escalated OverTaskBound | https://testnet.nearblocks.io/txns/C4t5K7EhKLR6aUfcHUbCbFb6at57WhtkF5EJJnRtSbCS | f282c39491bc821abcdff9937618acc826c0b117eb2a7ae3dcf4ac78e1ef7528:0 | policy.erfan-airlock.testnet |
