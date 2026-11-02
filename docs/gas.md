# Gas (AIR-107)

What a batch of three EVM requests costs in gas, and why the batch limit is three. A `submit_batch` call is sent with 300 Tgas. The
cap is justified when a batch of three EVM requests, with every promise reserved, fits in 225 Tgas, which leaves 25 percent headroom.
The prepaid gas of `approve` is set from the measured minimum plus 30 percent.

## Method

A call must carry at least `need = burnt_first + reserved`:

- `burnt_first` is the gas burnt by the receipt of the call itself (`receipt_outcomes()[0]`).
- `reserved` is the gas the call attaches to the promises it creates: `GAS_MPC_SIGN` plus `GAS_ON_SIGNED` for each `evm_unsigned`
  event, and `GAS_ON_TRANSFER` for each NEAR payment.
- A call with less than `need` fails with `Exceeded the prepaid gas.` and changes nothing (measured on the sandbox by
  `callback_gas_headroom` and by the approve sweep below).
- `burnt_total` is the gas of the transaction and every receipt. It is a cost, not a requirement.

All numbers are Tgas with three decimals.

## Constants

| Constant | Value | Where |
| --- | --- | --- |
| `GAS_MPC_SIGN` | 15 Tgas | `contracts/airlock-policy/src/exec.rs`, attached to the signer call with `with_unused_gas_weight(0)` |
| `GAS_ON_SIGNED` | 20 Tgas | the same file, the callback that stores the signature or refunds the charge |
| `GAS_ON_TRANSFER` | 5 Tgas | the same file, the callback of a NEAR payment |
| per EVM request | 35 Tgas | `GAS_MPC_SIGN` plus `GAS_ON_SIGNED` |
| batch of three | 105 Tgas | three EVM requests |

Live signer configuration (`v1.signer-prod.testnet`, near/mpc 3.17.0, REUSE_near.md R1.1): `sign` needs 15 Tgas prepaid and its own
return callback takes 7 Tgas out of that 15, which is why 15 is the floor. Since protocol 85 the signer buys all attached gas up
front at 1e9 yocto per gas, so 300 Tgas needs 0.3 NEAR free on the agent account and 150 Tgas needs 0.15 NEAR on the owner account.

## Sandbox table

Measured by `contracts/airlock-policy/tests/gas.rs` with the mock signer in `ok` mode:

```
cd contracts/airlock-policy
cargo near build non-reproducible-wasm --no-abi
cargo test --test gas -- --nocapture --test-threads=2
```

```
GAS TABLE
GAS ROW near_allow burnt_total=9.111 burnt_first=5.551 reserved=5.000 need=10.551
GAS ROW evm_allow burnt_total=11.335 burnt_first=6.310 reserved=35.000 need=41.310
GAS ROW evm_batch3 burnt_total=24.371 burnt_first=9.997 reserved=105.000 need=114.997
GAS ROW worst_case_batch3 burnt_total=24.889 burnt_first=10.441 reserved=105.000 need=115.441
GAS ROW escalate3 burnt_total=7.422 burnt_first=6.815 reserved=0.000 need=6.815
GAS ROW mixed burnt_total=12.938 burnt_first=7.864 reserved=35.000 need=42.864
GAS ROW approve_evm burnt_total=10.809 burnt_first=5.808 reserved=35.000 need=40.808
GAS ROW reject burnt_total=3.833 burnt_first=3.301 reserved=0.000 need=3.301
GAS ROW expire burnt_total=3.822 burnt_first=3.290 reserved=0.000 need=3.290
```

`worst_case_batch3` is three EVM Allows under a task with 16 bounds on distinct 52 character EVM keys, with recipient labels Owner,
Book and Policy together and amount and pc labels Owner and Oracle together. Its first receipt logs 2277 bytes in 7 entries, under
the protocol 88 limits of 16384 bytes and 100 entries.

Assertions that hold: `evm_batch3` and `worst_case_batch3` need at most 225 Tgas (they need about 115), and `evm_allow` burns
11.335 Tgas in total, under 30.

Callback headroom (`callback_gas_headroom`, the NEAR audit detector `prepaid-gas`): each callback fits its static reservation with
25 percent headroom, on the success path and on the refund path.

```
CALLBACK GAS on_signed_ok=2.923 on_signed_fail=3.499 on_transfer_ok=2.768 on_transfer_fail=3.479 Tgas
```

`on_signed` reserves 20 Tgas and burns at most 3.499. `on_transfer` reserves 5 Tgas and burns at most 3.479, which is 70 percent
of its reservation, the tightest of the four. A call sent 5 Tgas below its `need` reverts whole: no ledger charge, no nonce, no record.

## Approve sweep on the sandbox

One EVM escalation (`UntrustedAmount`), then `approve` as the owner with 30, 40, ... 150 Tgas on the same pending request. Every
failure carried `Exceeded the prepaid gas.` and left the request pending. The first success was at 50 Tgas, and 40 Tgas failed, which
agrees with a `need` of 40.808.

```
APPROVE_MIN_TGAS=50 sandbox
APPROVE_PREPAID_TGAS_SANDBOX=65
```

## Testnet

Sandbox neard 2.11.0 is protocol 83 and testnet runs protocol 88, so the sandbox column is a pre-check and the testnet column is
authoritative. The testnet numbers come from `scripts/gas-testnet.ts` (read only) after `scripts/mpc-smoke.ts --batch3` and
`scripts/gas-sweep-approve.sh` (the owner runs the sweep and types one `yes`).

TESTNET NOT MEASURED: the live batch and the live approve sweep need signed testnet transactions, which this build step did not send.
The coordinator runs them (commands in the ticket notes) and replaces this section with the `GAS TESTNET` rows `batch3`,
`approve_evm` and `single_evm` and the line `APPROVE_MIN_TGAS=<n> testnet`.

One real testnet row exists already, from the signed payment of AIR-102 (a single EVM request, saved as
`scripts/fixtures/gas/tx_status_single_evm.json` and read by `scripts/gas-testnet.test.ts`):

```
GAS TESTNET single_evm burnt_total=18.643 burnt_first=6.648 receipts=8 reserved=35.000 need=41.648
```

The sandbox said 41.310 for the same request, so the skew between protocol 83 and 88 is about 0.3 Tgas on the first receipt.

## Decisions

The batch cap stays at three on the sandbox pre-check only. Three EVM requests need about 115 Tgas of the 225 Tgas ceiling, and the
cap of three also matches the three request cumulative Kani harness. The testnet batch will confirm or change it.

BATCH CAP 3 CONFIRMED

The prepaid gas of `approve` stays at the value it had, 150 Tgas, until the testnet sweep measures a minimum. The sandbox minimum is
50 Tgas, and the published value will be the testnet minimum times 1.3 rounded up (the larger of the two when they differ).

APPROVE_MIN_TGAS=50 sandbox

APPROVE_PREPAID_TGAS=150

The same number is set in `scripts/approve-cli.sh` (the `APPROVE_PREPAID_TGAS` line) and in `web/src/wallet/approve.ts`
(`APPROVE_PREPAID_TGAS`); the wallet test reads the script's line and requires the same number.
