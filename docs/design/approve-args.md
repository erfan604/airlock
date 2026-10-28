# Decision R4-12: the arguments of `approve`

The owner approves an escalation with one call to the policy contract. A Ledger device shows the arguments of a call only when the
minified JSON stays under 200 bytes, so the names and the id of that call are fixed here, and the asset registry refuses any asset
whose worst-case arguments could reach 200 bytes.

## The decision

1. The method is `approve(id, to, asset, amount, why, book)`.
2. `id` is the short pending number `no` that the contract assigns when it stores the escalation: a decimal string of a u32, at most
   10 digits. It is not the request id (`<64 hex characters>:<action index>`, 66 or 67 characters), which stays the key of the stored
   request and the value of the `request_id` field of every event and view. `get_request` accepts either form.
3. The five values after `id` are the five things the owner's screen shows and the contract compares byte for byte with the stored
   card: the payee key, the asset symbol, the amount in its canonical decimal text, the reason code and the book status.
4. The old names of SPEC 8.2 are gone from the call. They are listed here only as quoted keys, so that nobody looks for them: `"request_id"`,
   `"recipient"`, `"asset_symbol"`, `"amount_decimal"`, `"reason"`, `"book_status"`. The console card prints the same five values
   with the same labels (`to`, `asset`, `amount`, `why`, `book`).

## Measurements

Every row is the length in bytes of the real minified JSON (`serde_json`, measured by `contracts/airlock-verdict/tests/approve_args_size.rs`,
which prints each row as `ROW <n> <description> <bytes>` and checks it against `approve_args_len`).

| row | names | id | key | symbol | amount text | why | book | bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | long (SPEC 8.2) | 66 character request id | `evm:84532:0x` plus 40 hex (52) | `ETH.base` | `0.000000000000000001` (1 base unit, 20) | `UntrustedRecipient` | `new` | 266 |
| 2 | as row 1 | 66 | `near:` plus a 64 character account (69) | as row 1 | as row 1 | as row 1 | as row 1 | 283 |
| 3 | short | 66 character request id | as row 1 (52) | `ETH.base` | `0.000000000000000001` | `UntrustedRecipient` | `new` | 226 |
| 4 | short | 66 | as row 2 (69) | as row 1 | as row 1 | as row 1 | as row 1 | 243 |
| 5 | short | `1234` | as row 1 (52) | `ETH.base` | `0.000000000000000001` | `UntrustedRecipient` | `new` | 164 |
| 6 | short, all maxima | `4294967295` (10) | `near:` plus 64 (69) | 12 characters | `3.40282366920938463463374607431768211455` (u128::MAX at 38 decimals, 40) | `UntrustedRecipient` | `in_book` | 215 |

Rows 3 and 4 with a 67 character id (an action index from 10 to 99) are 227 and 244. The figure of 164 bytes in R4-12 appears only for
row 5, whose amount is one base unit (20 characters); an amount of one whole ETH is `1` and gives 145.

Renaming alone does not meet the limit: with the request id as `id`, even the short names give 226 to 244 bytes (rows 3 and 4). That
is the reason for decision 2.

## The registry guard

`asset_set` computes the worst case over every amount up to the hard cap and reverts `approve arguments could exceed 200 bytes` unless

```
approve_args_len(MAX_ID_DIGITS, MAX_TO, symbol length, amount_text_len(hard_cap, decimals), MAX_WHY, MAX_BOOK) < 200
```

with `approve_args_len` the 59 bytes of minified JSON overhead (`{"id":"","to":"","asset":"","amount":"","why":"","book":""}`) plus the
six lengths, `MAX_ID_DIGITS` 10, `MAX_TO` 69 (`near:` plus a 64 character account; the longest EVM key is `evm:`, a 20 digit chain id, `:0x`
and 40 hex digits, 67 characters), `MAX_WHY` 18 (`UntrustedRecipient`, the longest reason that escalates), `MAX_BOOK` 7 (`in_book`),
and `amount_text_len(hard_cap, decimals)` the digits of `hard_cap / 10^decimals` (at least 1) plus, when `decimals` is above 0, the point and
every fraction digit. That is an upper bound on the longest `decimal::format` text of any amount up to the cap, checked on every cap
below 3,000 at 0 to 3 decimals and on 20,000 random caps and decimals. It is one character high when the cap is an exact power of ten
above one unit: a cap of 10,000 NEAR gives 30, and the longest real text is 29. The formatted cap itself is too short a measure: a
round cap `10000` has 5 characters, while the amount just below it, `9999.999999999999999999999999`, has 29.

The guard runs after the cap checks and before the EVM checks. Its consequences:

| asset | guard length | registers |
| --- | --- | --- |
| `NEAR` (4 characters, 24 decimals), hard cap 10,000 NEAR (the demo) | 197 | yes |
| `ETH.base` (8 characters, 18 decimals), hard cap 1 ETH (the demo) | 191 | yes |
| `NEAR`, hard cap 1,000,000 NEAR | 199 | yes |
| `NEAR`, hard cap 10,000,000 NEAR | 200 | no |
| symbol `A`, 33 decimals, hard cap one whole unit | 199 | yes |
| symbol `A`, 34 decimals, hard cap one whole unit | 200 | no |
| symbol `ABCDEFGHIJKL`, 38 decimals, hard cap 10^38 | 215 | no |

- The effective decimals ceiling of the registry is 33. `decimal::parse` and `decimal::format` still handle up to 38 places (the
  F13 bound, and the check `decimals above 38` still runs first), but an asset with more than 33 decimals cannot be registered,
  because its approve arguments could not be shown on a Ledger device.
- A NEAR hard cap must stay below 10,000,000 NEAR.
- A hard cap of the largest u128 does not register at any number of decimals.

## What is accepted

- The guard is pessimistic by up to 4 bytes, because a payee in the book approves with `in_book` (7) and a new payee with `new` (3), and
  by one more byte for a hard cap that is a power of ten.
- Intear, the primary wallet, has no argument limit. The claim is that a Ledger device can show the call, which needs the limit.
- The wallet bake-off of the spike used the long names and a 207 byte payload; its screenshots stay valid as evidence of how a wallet
  renders a six argument call. Console and wallet code must use the names above.
- Removing an asset leaves pending escalations in place; their approve fails at the recheck. A stored card keeps its own display
  strings, so removing and registering an asset again with other decimals cannot change what a stored card shows or what is paid.
