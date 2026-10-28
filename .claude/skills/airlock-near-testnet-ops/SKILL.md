---
name: airlock-near-testnet-ops
description: Use for NEAR testnet operations in AIRLOCK: deploying the policy contract, calling and viewing methods, whitelisting or registering the agent, bootstrapping the address book, deriving Chain Signatures addresses, broadcasting Base Sepolia transactions, and recording evidence links. Never for mainnet without explicit human approval.
---

# NEAR testnet operations

Hard rules: testnet only. Mainnet deploys, mainnet transactions, and spending tokens need Erfan's explicit yes for that exact action. Never print or commit keys; near-cli-rs keeps them in the macOS keychain or a credentials file referenced by env var.

## Ids (verify live before use)
- MPC signer: `v1.signer-prod.testnet` (mainnet `v1.signer`), `sign` with `{"request": {"payload_v2": {"Ecdsa": "<32-byte hex>"}, "path": "<path>", "domain_id": 0}}`, attach 1 yoctoNEAR, about 15 Tgas for the MPC leg (the template uses `Gas::from_tgas(15)` for the cross-contract call).
- RPC: https://rpc.testnet.near.org or https://test.rpc.fastnear.com. Explorer: https://testnet.nearblocks.io/txns/<hash>.
- Base Sepolia: chain id 84532, RPC https://sepolia.base.org, explorer https://sepolia.basescan.org/tx/<hash>.

## near-cli-rs patterns (binary `near`, install `npm i -g near-cli-rs@latest`)
- View: `near contract call-function as-read-only <contract> get_policy json-args '{}' network-config testnet now`
- Call: `near contract call-function as-transaction <contract> <method> json-args '<json>' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <account> network-config testnet sign-with-keychain send`
- Deploy with init: `near contract deploy <contract> use-file <wasm> with-init-call new json-args '<json>' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send`
- Storage: about 1 NEAR per 100 KB of wasm (the policy contract is about 850 KB, so about 8.6 NEAR locked).

## Derived addresses (chainsig.js 1.1.16)
Derive the EVM address for (policy contract account, path) off chain with chainsig.js `contracts.ChainSignatureContract` + `chainAdapters.evm.EVM` `deriveAddressAndPublicKey(contractId, path)`. Fund that address from a Base Sepolia faucet (human step). Record the address in docs/EVIDENCE.md.

## After every successful on-chain action
Append a row to docs/EVIDENCE.md: what, network, tx hash link, date. The README links to these rows.
