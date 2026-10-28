# Evidence log

| What | Network | Id / hash / link | Date |
| --- | --- | --- | --- |
| Planner and vanilla model | NEAR AI Cloud | fixture-planner-model; results.md sha256 0123456789ab | 2026-10-30 |
| Quarantine model | NEAR AI Cloud | fixture-quarantine-model; results.md sha256 0123456789ab | 2026-10-30 |

## Deployed ids and hashes

| What | Network | Id / hash / link | Date |
| --- | --- | --- | --- |
| Policy contract account | NEAR testnet | policy.fixture-owner.testnet | 2026-11-06 |
| Code hash (base58) | NEAR testnet | 5iYSgYQBRpLQSFn28qKxNGAJ393zvQpysdZoNS3Q25XF | 2026-11-06 |
| Wasm sha256 | local build | 46131d04a43f818225fda0ae5b99e8f9d054cb57cb113fa6604c075fdf471402 | 2026-11-06 |
| Deploy transaction | NEAR testnet | https://testnet.nearblocks.io/txns/CxQTsmGLdVmoCyfqjUxbKNqwQceaYJbapGeo4czMZQKv | 2026-11-06 |
| Derived Base Sepolia address | Base Sepolia | 0x16c089aad87decf4eaaa4a4afeb5926bcd11b410 | 2026-11-06 |
| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-01 |
| MPC contract version | NEAR testnet | 3.17.0 | 2026-11-08 |
| MPC contract code hash | NEAR testnet | DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9 | 2026-11-01 |
| MPC contract code hash | NEAR testnet | DAE5ng4ZFR2ctMx9SizQBqmGkVbKUutgZ4ZECD4R8Sm9 | 2026-11-08 |

## Real MPC (AIR-102)

| What | Network | Id / hash / link | Date |
| --- | --- | --- | --- |
| Real MPC signature | NEAR testnet and Base Sepolia | https://testnet.nearblocks.io/txns/GDXXqKfrSwJ4gKvz44Mk5Yk1WaYVU3NucuRnF3Npq6fd then https://sepolia.basescan.org/tx/0xdb8e05108d6e649f83f02388cb0589d03a29f2c9a30d806f424e23cf5113e900 | 2026-11-07 |

## Testnet end to end (AIR-165)

| Date | Case | Outcome | Link | Request | Contract |
| --- | --- | --- | --- | --- | --- |
| 2026-11-08 | U01 | allowed | https://testnet.nearblocks.io/txns/5xjwv5gacRrgyxsrBYei7Y2QCmHrzqH4LRkVcac1snJk | u01:0 | policy.fixture-owner.testnet |

## Golden runs (AIR-166)

| Date | Run | Link |
| --- | --- | --- |
| 2026-11-09 | b01-escalate | https://testnet.nearblocks.io/txns/3TMfquuStXyWDQMBDcn4nPG3fRKwUkrdZsZdvS52z69d |
| 2026-11-09 | b01-approve | https://testnet.nearblocks.io/txns/Dh43rqMMwY9o4ipXRvhKuC9PRhRpz6NGVkJq7FDAU1o2 |
| 2026-11-09 | tamper (reverted) | https://testnet.nearblocks.io/txns/Ee4nQECExp2w4kqZztRq4DrgFoAn1CMupWDtrBE8TetJ |
| 2026-11-09 | twin | https://testnet.nearblocks.io/txns/HJJPZ79QMjuL99j4LvFRiSk8WuKZaRtyn8TVqNF8bAFa |

## Wallet matrix

| Wallet | Step | On-screen words | Screenshot |
| --- | --- | --- | --- |
| Intear | review | fixture words one | wallet-intear-review.png |
| Intear | signed | fixture words two | wallet-intear-signed.png |
| Meteor | review | fixture words three | wallet-meteor-review.png |
| Meteor | signed | fixture words four | wallet-meteor-signed.png |

## Toolchain

| tool | pinned | actual | status |
| --- | --- | --- | --- |
| rustc | 1.86.0 | 1.86.0 | ok |

## Differential

identical on 40000 cases

## Video links

- https://testnet.nearblocks.io/txns/GDXXqKfrSwJ4gKvz44Mk5Yk1WaYVU3NucuRnF3Npq6fd
- https://sepolia.basescan.org/tx/0xdb8e05108d6e649f83f02388cb0589d03a29f2c9a30d806f424e23cf5113e900
- https://testnet.nearblocks.io/txns/Ee4nQECExp2w4kqZztRq4DrgFoAn1CMupWDtrBE8TetJ

## Model choice

planner model: fixture-planner-model, chosen on benign task success first, then cost, latency, schema acceptance and the TEE flag.
quarantine model: fixture-quarantine-model.
vanilla models: fixture-vanilla-model.
