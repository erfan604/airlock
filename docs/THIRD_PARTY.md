# Third-party code

Code copied or adapted into this repository (libraries installed through the lockfile are listed there, not here). Each row
matches a `// adapted from` comment in the source. Allowed licenses: MIT, Apache-2.0, BSD-2/3-Clause, ISC.

| Our file | Source repo | Commit or tag | Source path | License | What changed |
| --- | --- | --- | --- | --- | --- |
| contracts/airlock-policy (fork) | NearDeFi/shade-agent-template | 816b75b | agent-contract/ (src, tests, Cargo.toml, Cargo.lock) | Apache-2.0 (LICENSE and NOTICE.txt copied into the crate) | crate renamed to airlock-policy and `tests/helpers` to `tests/common`; every owner method is payable and guarded by `owner_call` (exactly 1 yoctoNEAR and the owner); state gains `paused` and `flags`; events use the `airlock` standard; `get_policy`, `pause` and `set_flags` added; template lint sites fixed; the upgrade test (tests/update_contract_tests.rs) and its precompiled tests/contracts/contract_update.wasm deleted. `request_signature` (with src/internal/chainsig.rs), `update_contract`, `update_owner_id`, `update_mpc_contract_id` deleted and `is_agent_valid` added (AIR-041); still to come: gate, ledgers, escalations |
