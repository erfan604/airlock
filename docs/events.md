# Contract events

The policy contract logs one line per event. The closed list below has 26 names. A name outside it is an error for every reader: the
TypeScript chain client (AIR-160) and the approval verifier (AIR-085) refuse an event they do not know. Each row names the data fields
of the event as the ticket that emits it fixes them. `tests/events.rs` runs a mixed scenario in the sandbox and checks every emitted
event against this file: the name, and the exact set of data field names.

## Format

Each log line is `EVENT_JSON:` followed by one JSON object:

```
EVENT_JSON:{"standard":"airlock","version":"1.0.0","event":"<snake_case name>","data":[{ ... }]}
```

- `standard` is `airlock` and `version` is `1.0.0` on every event. The template used another standard name; AIR-040 replaced it.
- `data` is an array with exactly one element, and that element is the object of the fields in the table. A reader takes `data[0]`.
- One event is one log line. A call that emits several events logs several lines, in the order the contract emitted them.
- Numbers that can exceed 2^53 (`u128` amounts, `u64` times and block heights) are decimal strings. Counters of at most 32 bits are
  plain JSON numbers. An optional value is `null` when it is absent, and the key is always present.

## Rules

1. No agent free text (RT-24). An event carries only values the contract derived or validated: the task hash, the request id,
   registry asset ids, canonical payee keys, account ids, closed reason names and numbers. The task id, the plan hash, the trace
   digest, the label masks and the EVM parameters an agent sends in a request are never copied into an event.
2. `request_id` is the derived id `<64 lowercase hex task hash>:<decimal action index>`. Every lane event (`evm_unsigned`, `signed`,
   `paid`, `failed`) and every gate event names the request `request_id`.
3. `id` is the decimal pending number of an escalation, the value `approve` and `reject` take. It appears in `escalated`, `approved`,
   `rejected` and `expired`, and in no other event.
4. `reason` is a closed name. In `escalated` and `blocked` it is a verdict reason: `UnknownAsset`, `Paused`, `AmountOutOfBounds`,
   `DailyLimit`, `FeeTooHigh`, `MissingProvenance`, `BookLabelNotInBook`, `OutsideTask`, `OverTaskBound`, `UntrustedTrigger`,
   `UntrustedRecipient`, `NewRecipient`, `OverPayeeLimit`, `UntrustedAmount`, `PendingFull`, `EscalationsLocked` or
   `EscalationBudget`. In `failed` it is `MpcFailed`, `MpcBadResponse`, `TransferFailed`, `InsufficientBalance` or `AuthorizationExpired`.
5. The list grows only by a ticket that adds the emitting code and its row here in the same change (AIR-080, AIR-081, AIR-083, AIR-100,
   AIR-101, AIR-104 and AIR-105 add the rows that no code emits yet).

## The closed list

Types: `string`, `number`, `boolean`, `object`, `array of strings`; `string or null` is a decimal string or `null`.

### Gate (AIR-061)

| Event | Data fields | Emitted by |
| --- | --- | --- |
| `submitted` | `task_hash: string`, `count: number`, `agent: string` | `submit_batch`, once per call after the task verified. `task_hash` is 64 lowercase hex, `count` the number of requests of the call, `agent` the caller. |
| `allowed` | `request_id: string`, `asset: string`, `payee: string`, `amount: string`, `asset_day_remaining: string`, `payee_day_remaining: string`, `task_remaining: string or null` | `submit_batch`, once per new Allow, after its charge. The three remaining values are what is left of the asset day, payee day and task ledgers; `task_remaining` is `null` when the task has no bound for the payee. |
| `escalated` | `request_id: string`, `id: string`, `reason: string` | `submit_batch`, once per new escalation. `id` is the pending number. |
| `blocked` | `request_id: string`, `reason: string` | `submit_batch`, once per new Block. |

### Escalation lifecycle and flood control (AIR-080, AIR-081, AIR-083)

| Event | Data fields | Emitted by |
| --- | --- | --- |
| `approved` | `request_id: string`, `id: string`, `digest: string`, `approver: string`, `block_height: string` | `approve` (AIR-080). `digest` is 64 lowercase hex, `approver` the owner account, `block_height` a decimal string. |
| `rejected` | `request_id: string`, `id: string` | `reject` (AIR-081), emitted before `escalations_locked`. |
| `expired` | `request_id: string`, `id: string` | `expire` (AIR-081), any caller, after the escalation's time to live. |
| `escalations_locked` | `agent: string`, `consecutive: number`, `today: number` | `reject` when it newly locks the agent's per-agent counters (AIR-083), the counters of requests that name no origin. `consecutive` and `today` are the counters after the reject, plain JSON numbers. A lock of one origin (AIR-315) emits nothing, because the origin is text the runtime chose; `get_escalation_state(agent, origin)` shows it. |
| `escalations_reset` | `agent: string` | `reset_escalations` (AIR-081), owner only, with or without its optional origin (AIR-315); the origin is not in the event. |

### Execution lanes (AIR-100, AIR-101, AIR-104, AIR-105)

| Event | Data fields | Emitted by |
| --- | --- | --- |
| `evm_unsigned` | `request_id: string`, `unsigned_hex: string` | The EVM lane (AIR-100), before the signature exists. `unsigned_hex` is lowercase hex without `0x`, first byte `02`. A retry emits it again with the same value. |
| `signed` | `request_id: string`, `unsigned_hex: string`, `big_r: string`, `s: string`, `recovery_id: number` | `on_signed` (AIR-105). `big_r` is 66 characters, `s` is 64 characters, `recovery_id` is 0 to 3. |
| `x402_signed` | `id: string`, `from: string`, `to: string`, `value: string`, `valid_after: string`, `valid_before: string`, `nonce: string`, `v: number`, `r: string`, `s: string` | `on_signed` (AIR-109) for an erc20 request, instead of `signed`. `id` is the request id, `from` and `to` are `0x` plus 40 lowercase hex, `value` and `valid_before` decimal strings (Unix seconds), `valid_after` is `"0"`, `nonce` is `0x` plus 64 hex, `v` is 27 or 28, `r` and `s` are 64 hex without `0x`. |
| `paid` | `request_id: string`, `payee: string`, `amount: string` | `on_transfer` (AIR-101), the NEAR lane. `payee` is the stored canonical key, `amount` decimal base units. |
| `failed` | `request_id: string`, `reason: string`, `retryable: boolean` | The failure path (AIR-105, AIR-101). `reason` is one of the failed reasons of rule 4. `MpcFailed`, `TransferFailed`, `InsufficientBalance` and `AuthorizationExpired` (AIR-109: the retry of an x402 request whose stored authorization has expired signs nothing) refund the request's charges; `MpcBadResponse` (the signer answered, but the answer is unusable) keeps them, and `retryable` is then always false. |
| `nonce_set` | `path: string`, `nonce: string` | `set_nonce` (AIR-104), owner only. `nonce` is a decimal string. |

### Owner and agent plane (AIR-040, AIR-042, AIR-043, AIR-045, AIR-046, template)

| Event | Data fields | Emitted by |
| --- | --- | --- |
| `agent_allowed` | `account_id: string`, `fingerprint: string` | `allow_agent` (AIR-046). |
| `agent_revoked` | `account_id: string` | `revoke_agent` (AIR-046). |
| `task_key_set` | `public_key: string` | `set_task_key` (AIR-045). `public_key` is `ed25519:` and base58. |
| `task_revoked` | `task_hash: string` | `revoke_task` (AIR-045). 64 lowercase hex. |
| `asset_set` | `asset: string`, `symbol: string`, `decimals: number`, `hard_cap: string`, `daily_cap: string`, `quick_task_cap: string`, `path: string or null` | `asset_set` (AIR-042). `path` is the EVM signing path, `null` for NEAR. |
| `asset_removed` | `asset: string` | `asset_remove` (AIR-042). |
| `book_root_set` | `old: string`, `new: string`, `epoch: string` | `book_set_root` and `approve_and_remember` (AIR-326). The two roots are 64 hex characters; the event names no payee, label or number. `epoch` is the count of root changes after this one, a decimal string. |
| `flags_set` | `flags: object` | `set_flags` (AIR-040). The object holds the seven flags listed below. |
| `paused` | `paused: boolean` | `pause` (AIR-040). |
| `agent_registered` | `account_id: string`, `measurements: object`, `ppid: string`, `advisory_ids_truncated: array of strings`, `number_of_advisory_ids: number`, `current_time_ms: string`, `valid_until_ms: string` | `register_agent` (the template's event, payload kept by AIR-040). At most 8 advisory ids are listed; `number_of_advisory_ids` is the true count. |
| `agent_removed` | `account_id: string`, `reasons: array of strings` | `remove_agent` (owner) and the lazy removal of an invalid agent inside `submit_batch` (AIR-046). Reasons: `ManualRemoval`, `ExpiredAttestation`, `InvalidMeasurements`, `InvalidPpid`, `NotWhitelistedForLocal`. |

## Field notes

- `flags_set.flags` holds `max_pending_per_agent`, `pending_ttl_ms` (decimal string), `hourly_escalation_budget`,
  `lock_consecutive_rejects`, `lock_rejects_per_day`, `max_task_ttl_ms` (decimal string) and `max_task_actions`. The counters are
  plain JSON numbers.
- `agent_registered.measurements` is the agent's full measurements object as `get_agent` shows it. The attestation itself is too large
  to log and is not in the event.
- Decoders read `data[0]` and key on `event`. They treat a name outside the closed list as an error and a missing field of a listed
  event as an error.
