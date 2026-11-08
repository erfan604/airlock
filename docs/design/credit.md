# Decision AIR-327 and AIR-328: AIRLOCK Credit

Status: AIR-327 (the roles) is built; the AIR-328 design (the pool contract) follows in this file and waits for the coordinator's OK.

## AIR-327: the card policy has three roles

A credit line funds an AIRLOCK policy, the card. Three accounts stand around it:

| Role | Account | What it can do |
| --- | --- | --- |
| issuer | `owner_id` (the pool's issuer) | everything the owner could do before: book (`book_set_root`), assets, flags, pause, task key, agents, `reset_escalations`, and `sweep` |
| borrower | `approver` (set at init) | `approve` and `reject` of held payments, nothing else |
| pool | `sponsor` (set at init) | the only account `sweep` can pay |

`approver` and `sponsor` are `Option<AccountId>` arguments of `new`, last fields of the state, fixed for the life of the account: no method
changes them. With neither set, nothing changes: the owner approves and rejects with the same guard text (`Caller is not the owner`), there
is no sweep, and an init call without the two keys is the init call of before (a missing option key is None).

- `approve`, `reject` and `approve_and_remember` run `approver_call`: exactly one yoctoNEAR, then the predecessor must be the approver
  (the owner when none is set). With an approver the owner is refused (`Caller is not the approver`), because the person who tops up or
  rules the card must not be the one who taps for it.
- `approve_and_remember` is refused when an approver is set (`approve_and_remember is refused when an approver is set: the owner adds
  merchants with book_set_root`): the borrower cannot add a payee, so a line can only reach merchants the issuer put in the book.
- `sweep(amount)`, owner only, one yocto, only with a sponsor. Reverts, in order: `no sponsor`, `sweep amount must be positive`,
  `sweep refused: escalations are pending` (a held payment the approver may still tap must stay funded; escalations expire after their TTL
  and anyone may `expire` them), `sweep exceeds the spendable balance` (balance minus the storage cost). It sends one function call,
  `on_card_return({card: <this account>})`, with `amount` as its deposit, to the sponsor and nowhere else; then the private callback
  `on_sweep` logs `sweep_result`. If the sponsor's credit fails, the deposit returns to the card and `sweep_result` says `ok: false`.
  A request already paying is not tracked: if a sweep leaves it short, its transfer fails and the contract refunds its ledgers (AIR-105).
- `get_roles` reads the three. Events `swept` and `sweep_result` are in `docs/events.md`.
- No other path sends funds to an account outside a payment through the verdict: the code that moves NEAR is the verdict-gated transfer
  and `sweep`.

Not changed: `contracts/airlock-verdict` and the proofs (no diff). The roles are access control around the verdict, tested, not part of
Kani or Lean.

Trust assumptions, stated once: the pool checks off chain that a card was created with the issuer as owner, the borrower as approver and
the pool as sponsor (AIR-328 registers cards on that statement); an owner key that is stolen can still change the book and sweep, as an
owner key always could.

### Mutation check

Each mutant was applied alone and the library tests run (cargo test on the library target, 327 tests including the unit tests of `src/roles.rs` and the
three red-team cases RT-CON-14 to RT-CON-16); the sandbox suite `tests/roles.rs` covers the same rules against the wasm.

| Mutant | Killed by |
| --- | --- |
| the approver gate lets the owner pass (guard ignores the approver) | `roles_approver_approves_and_rejects_and_the_owner_cannot`, `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_owner_cannot_approve_when_approver_set`, `rt_con_approver_cannot_add_a_payee` |
| the approver gate accepts the owner as well as the approver | `roles_approver_approves_and_rejects_and_the_owner_cannot`, `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_owner_cannot_approve_when_approver_set` |
| `approve_and_remember` allowed with an approver | `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_approver_cannot_add_a_payee` |
| `sweep` pays the owner instead of the sponsor | `roles_sweep_sends_only_a_function_call_to_the_sponsor_with_the_card_id`, `rt_con_sweep_pays_only_the_sponsor` |
| `sweep` without the owner guard | `roles_sweep_is_owner_only_with_one_yocto`, `roles_approver_cannot_change_policy`, `rt_con_sweep_pays_only_the_sponsor` |
| `sweep` ignores pending escalations | `roles_sweep_refuses_zero_more_than_spendable_and_pending_escalations` |
| `sweep` ignores the spendable balance | `roles_sweep_never_goes_below_the_storage_cost` |

## AIR-328: the credit pool contract (design, waiting for approval)

A new crate `contracts/airlock-credit` (near-sdk =5.26.1, rustc 1.86.0, its own `Cargo.lock`, same layout as `contracts/mock-mpc`). LPs stake
NEAR and hold shares; the pool's issuer opens credit lines that fund cards (AIRLOCK policies, AIR-327); what a card spends comes back through
`sweep` and `repay`, with a fee that raises the share price. No oracle, no price feed: one asset (NEAR), integer math only.

### State

| Field | Meaning |
| --- | --- |
| `owner_id` | the issuer: registers cards, opens lines, sets the pool parameters; trusted by LPs (see limits) |
| `collateral_bps: u32` | collateral a line needs, in basis points of its limit (default 3000, owner may set 0 to 10000) |
| `total_shares: u128`, `idle: u128`, `lent: u128`, `staked: u128` | shares issued; liquid NEAR the pool holds for LPs; principal outstanding on open lines; NEAR out earning yield (0 until AIR-332) |
| `fees_earned: u128`, `losses: u128`, `collateral_held: u128` | fees credited to LPs; losses not covered by collateral; collateral of open lines (never part of LP assets) |
| `lps: LookupMap<AccountId, u128>` | shares per LP |
| `cards: IterableMap<AccountId, Card>` | `{ borrower, line: Option<Line> }`; one line per card at a time |
| `Line` | `{ limit, returned, fee_bps, due_ms, collateral, state: Collecting | Open | Repaid | Defaulted }` |

`assets = idle + lent + staked` (principal at cost; fees and losses enter when they are realised, never as a mark to market). The share price is
`assets * 10^24 / total_shares` (yoctoNEAR per share scaled by 10^24, a decimal string in views).
`staked` stays 0 in this ticket, no call moves it. Pool accounting uses these fields only, never the contract's balance, so a plain transfer to the contract cannot move the share price (no
donation attack). The invariant `contract balance >= idle + collateral_held + refunds in flight` is a property test.

### Calls

| Call | Who | Rule |
| --- | --- | --- |
| `deposit()` payable | anyone | `shares = amount` when `total_shares` is 0, else `floor(amount * total_shares / assets)`; at least `MIN_DEPOSIT` (0.001 NEAR); refuses when shares are 0 or `assets` is 0 with shares outstanding |
| `withdraw(shares)` | an LP | `amount = floor(shares * assets / total_shares)`; refuses above `idle` with the most shares that can leave now; burns, lowers `idle`, then transfers; `on_withdraw` restores the state if the transfer failed |
| `register_card(card, borrower)` | owner | asks the card `get_roles` and, in `on_card_roles`, requires `owner_id == pool owner`, `approver == borrower`, `sponsor == this pool`, and `borrower != owner`; then stores the card. The role check is on chain, so the trust assumption of AIR-327 is checked, not stated |
| `post_collateral(card)` payable | the card's borrower | adds to the card's collecting line |
| `open_line(card, limit, fee_bps, due_ms)` | owner | needs `collateral >= ceil(limit * collateral_bps / 10000)`, `idle >= limit`, `fee_bps <= 5000`, `now < due_ms <= now + 90 days`, no other line; moves `limit` from `idle` to `lent`, then transfers it to the card; `on_line_funded` restores the state if the transfer failed |
| `on_card_return(card)` payable (emits `swept`) | the card account itself | credits the open line: `credited = min(deposit, limit - returned)`; `idle += credited`, `lent -= credited`, `returned += credited`; the excess is sent back to the card. After a default it credits the loss recovery in the same way (losses fall, never below 0) |
| `repay(card)` payable | anyone | `outstanding = limit - returned`, `fee = ceil(outstanding * fee_bps / 10000)`, `owed = outstanding + fee`; needs `deposit >= owed`; `idle += owed`, `lent -= outstanding`, `fees_earned += fee`, the excess is refunded, the collateral goes back to the borrower, the line closes. Nothing is owed after a full sweep, so the fee is paid on what the card kept |
| `default(card)` | anyone, after `due_ms`, `owed > 0` | the collateral covers principal first, then fee: `seized = min(collateral, owed)`; the part of `outstanding` beyond `seized` is added to `losses`; what is left of the collateral goes back to the borrower; the line closes `Defaulted` |
| `set_collateral_bps(bps)` | owner | 0 to 10000; open lines keep the value they were opened with |

Rounding always favours the pool: shares floor on deposit, amounts floor on withdraw, fees ceil. Every state change happens before the
promise that moves NEAR, and every transfer that can fail has a callback that restores the state, so no path loses accounting on a failed
transfer.

After a default the pool cannot pause or sweep the card (the issuer owns it): the issuer pauses the card and sweeps what is left, and that
sweep is credited back as a recovery. The card's own funds are the pool's only recourse beyond the collateral.

### Views and events (the names the /credit page is built on)

Amounts are yocto decimal strings everywhere.

- `get_pool` returns `{ assets, shares, idle, staked, lent, fees_earned, losses, share_price, lines: [{ card, borrower, limit, drawn, returned, fee_bps, due_ms, state }] }`. `assets = idle + lent + staked`; `staked` is 0 until AIR-332 (idle liquidity sent to earn yield), so
  the share price formula already has its slot. `drawn` is the principal funded when the line opened (equal to `limit`), `returned` what
  sweeps credited, `state` one of `Collecting`, `Open`, `Repaid`, `Defaulted`. `lines` is the same list as `list_lines(0, 50)`.
- `get_lp(account)` returns `{ shares, value }`, `get_line(card)` one line or null, `list_lines(from_index, limit)` clamped to 50, `get_card(card)`.
- `deposit()` is payable, `withdraw({ shares })`.
- Events use the NEP-297 envelope with standard `airlock-credit`, version `1.0.0`: `deposit` `{ account, amount, shares }`, `withdraw`
  `{ account, amount, shares }`, `card_registered` `{ card, borrower }`, `collateral_posted` `{ card, amount }`, `line_opened`
  `{ card, borrower, limit, fee_bps, due_ms }`, `swept` `{ card, amount }` (the pool credited a return from the card, emitted by
  `on_card_return`), `repaid` `{ card, amount, fee }`, `defaulted` `{ card, seized, loss }`, `params_set` `{ collateral_bps }`. The card
  policy's own `swept` event (standard `airlock`, emitted when the card sends the funds) is a different standard and carries `sponsor` and
  `amount`; the two together show both ends of a sweep.

#### Card payment events: the policy's events are enough, the page maps them

The card policy needs no new events. Its existing ones (docs/events.md, standard `airlock`, emitted by the card account) cover the three the page shows:

| Page event | Built from | Notes |
| --- | --- | --- |
| `card_paid {chain, amount}` | `allowed` `{request_id, asset, payee, amount}`, confirmed by `paid` (NEAR lane, same `request_id`) or `signed` / `x402_signed` (EVM lane) | `chain` is the asset id of `allowed`: `near`, or `evm:<chain id>:...` (and the Solana id of AIR-325); `amount` is in the asset's base units, so the page divides by the decimals of `get_asset`. The card is the account that emitted the event. `allowed` alone means the verdict allowed it; `paid` or `signed` means the money moved or the signature exists. `failed` (same id) cancels it. |
| `card_held` | `escalated` `{request_id, id, reason}` | the amount and payee are on `get_request(request_id)` |
| `card_refused` | `blocked` `{request_id, reason}` | the policy calls it blocked; the page shows "refused" |

The payee of an `allowed` event is public at payment time (docs/design/private-book.md); a page that wants to keep merchants private shows
only chain and amount.

### Tests

Failing tests first for each rule. Unit: share math and rounding (first deposit, price after a fee, a withdraw at a price that is not
1), every refusal text, the donation case, the invariants. Property test (proptest, no new network dependency): random sequences of
deposit, withdraw, open, return, repay, default keep `assets == idle + lent + staked`, `sum of LP claims <= assets`, the share price never falls
except through `losses`, and a withdraw never pays more than the pro rata share. Sandbox with the real airlock-policy wasm (AIR-327): the
issuer creates a card with the pool as sponsor and the borrower as approver, the pool funds it, the agent pays a book merchant through
the verdict, an injected payee is held, the issuer sweeps, the borrower repays with the fee, an LP withdraws more than deposited; a default
case with collateral seized and a recovery sweep. Mutation check of the money paths (share math, fee, collateral seizure, caller checks).

### What this does not do

- LPs trust the issuer: the issuer picks the borrowers, the limits, the collateral ratio and owns the card policy. A malicious issuer can open a line to an
  account it controls. AIRLOCK removes the agent as the risk (a steered agent pays no one outside the book) and the borrower as the person
  who can add himself to the book; it does not remove credit risk (spent, not repaid) or issuer risk.
- One asset, no interest accrual over time (a fixed fee per line), no liquidations before the due date, no partial default,
  no secondary market for shares, no governance.
- Mainnet needs Erfan's yes; everything here is testnet.

### Effort against the cut date

Hours after approval: contract and unit tests 5, property test 1, sandbox suites with the policy wasm 3, `check.sh` stages (committed alone)
0.5, design and evidence updates 1, `check.sh full` 1: about 11 hours for 2026-11-09 to 2026-11-11, which fits with about one day of slack if
the approval comes on 2026-11-08. Decisions I need: D1 on chain role check at `register_card` (the ticket says off chain; this removes a
trust assumption for one cross-contract view call), D2 fee on the net outstanding at repay (the ticket's formula), D3 `MIN_DEPOSIT` 0.001 NEAR,
D4 excess of a return or a repay is sent back, D5 a sweep after a default is credited as recovery.
