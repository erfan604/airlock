# Decision AIR-327 and AIR-328: AIRLOCK Credit

Status: AIR-327 (the roles) and AIR-328 (the pool contract, `contracts/airlock-credit`) are built; the coordinator approved the design and decisions D1 to D5 on 2026-11-08.

## AIR-327: the card policy has three roles

A credit line funds an AIRLOCK policy, the card. Three accounts stand around it:

| Role | Account | What it can do |
| --- | --- | --- |
| issuer | `owner_id` (the pool's issuer) | everything the owner could do before: book (`book_set_root`), assets, flags, pause, task key, agents, `reset_escalations`, `reject` (so a pending escalation never blocks `sweep`), and `sweep`; `approve` as an override for a payment to a payee that is not in the book (never for a booked one) |
| borrower | `approver` (set at init) | `reject` any held payment; `approve` a held payment only to a payee in the book at the current epoch; nothing else |
| pool | `sponsor` (set at init) | the only account `sweep` can pay |

`approver` and `sponsor` are `Option<AccountId>` arguments of `new`, last fields of the state, fixed for the life of the account: no method
changes them. With neither set, nothing changes: the owner approves and rejects with the same guard text (`Caller is not the owner`), there
is no sweep, and an init call without the two keys is the init call of before (a missing option key is None).

- `reject`, `approve` and `approve_and_remember` run `settle_call` (reject moves no money, so the issuer may reject too: otherwise a borrower
  who leaves an escalation pending would block `sweep`, which needs none pending): the approver or the owner may pass the gate, a stranger is refused
  (`Caller is not the approver or the owner`); with no approver only the owner, with the text of before. Which of the two may settle
  which escalation is the rule below.
- The borrower rule (found in review, tests RT-CON-14 and RT-CON-17 to RT-CON-20): the borrower controls the agent and holds the approver
  key, so he could ask his own account to be paid, see it held as a new payee and tap approve. With an approver set, `approve` settles
  an escalation only as follows: the approver may approve it only when its payee is in the book at the current epoch (the stored
  `in_book` status and an unchanged book epoch, which need a valid proof, AIR-326); the owner may approve it only when it is not (an
  explicit override by the issuer). So a new payee, a payee whose proof the agent withheld and a stale status are refused to the approver
  (`approve refused for the approver`), who can still reject them, and a booked payee is refused to the owner (`approve refused for
  the owner: ... the approver settles it`). The approver may therefore settle held payments to booked merchants (an amount read from
  untrusted text, or over the soft limit within the caps) and nothing else. `init` refuses an approver equal to the owner.
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

Trust assumptions, stated once (the borrower rule above is one of them: the borrower can never move pool money to an account the issuer did not put in the book, because only the issuer can settle such a payment, and a withheld or stale proof counts as not in the book): the pool checks off chain that a card was created with the issuer as owner, the borrower as approver and
the pool as sponsor (AIR-328 registers cards on that statement); an owner key that is stolen can still change the book and sweep, as an
owner key always could.

### Mutation check

Each mutant was applied alone and the library tests run (cargo test on the library target, 331 tests including the unit tests of `src/roles.rs` and the
three red-team cases RT-CON-14 to RT-CON-16); the sandbox suite `tests/roles.rs` covers the same rules against the wasm.

| Mutant | Killed by |
| --- | --- |
| the approver gate lets the owner pass (guard ignores the approver) | `roles_approver_approves_and_rejects_and_the_owner_cannot`, `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_owner_cannot_approve_when_approver_set`, `rt_con_approver_cannot_add_a_payee` |
| the approver gate accepts the owner as well as the approver | `roles_approver_approves_and_rejects_and_the_owner_cannot`, `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_owner_cannot_approve_when_approver_set` |
| `reject` refuses the owner when an approver is set (F2, the issuer could not clear a pending escalation, so `sweep` stayed blocked) | `roles_gates_with_an_approver_set`, `rt_con_owner_rejects_a_pending_escalation_so_the_sweep_is_not_blocked` |
| `approve_and_remember` allowed with an approver | `roles_approve_and_remember_is_refused_when_an_approver_is_set`, `rt_con_approver_cannot_add_a_payee` |
| `sweep` pays the owner instead of the sponsor | `roles_sweep_sends_only_a_function_call_to_the_sponsor_with_the_card_id`, `rt_con_sweep_pays_only_the_sponsor` |
| `sweep` without the owner guard | `roles_sweep_is_owner_only_with_one_yocto`, `roles_approver_cannot_change_policy`, `rt_con_sweep_pays_only_the_sponsor` |
| `sweep` ignores pending escalations | `roles_sweep_refuses_zero_more_than_spendable_and_pending_escalations` |
| `sweep` ignores the spendable balance | `roles_sweep_never_goes_below_the_storage_cost` |
| the approver may approve a payee that is not in the book (the hole: the borrower pays himself) | `rt_con_borrower_pays_himself_is_refused`, `rt_con_approver_cannot_approve_a_new_payee_of_anyone`, `rt_con_withheld_proof_makes_the_payee_new_for_the_approver`, `rt_con_stale_book_status_needs_the_owner`; sandbox `the_borrower_cannot_pay_himself_through_his_agent` |
| the owner may approve a booked payee | `rt_con_approver_approves_a_booked_merchant_and_the_owner_does_not` |
| the stored book epoch is ignored (a stale status counts as in the book) | `rt_con_stale_book_status_needs_the_owner` |
| the role split is not applied at all | five red-team tests above |
| the gate lets anyone settle | `rt_con_approver_approves_a_booked_merchant_and_the_owner_does_not`, `roles_gates_with_an_approver_set` |
| `book_in` is true whatever the proof | `store_pending_fills_display_digest_and_indexes`, `rt_con_borrower_pays_himself_is_refused`, `rt_con_withheld_proof_makes_the_payee_new_for_the_approver` |

## AIR-328: the credit pool contract

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

`assets = idle + lent + staked - impaired` (principal at cost, an overdue line impaired to 0; fees and losses enter when they are realised, never as a mark to market). The share price is
`assets * 10^24 / total_shares` (yoctoNEAR per share scaled by 10^24, a decimal string in views).
`staked` stays 0 in this ticket, no call moves it. Pool accounting uses these fields only, never the contract's balance, so a plain transfer to the contract cannot move the share price (no
donation attack). The invariant `contract balance >= idle + collateral_held + refunds in flight` is a property test.

### Calls

| Call | Who | Rule |
| --- | --- | --- |
| `deposit()` payable | anyone | `shares = amount` when `total_shares` is 0, else `floor(amount * total_shares / assets)`; refused while any open line is past its due date (`deposits are paused while a line is past due`) or any card carries an unrecovered loss (`deposits are paused while a defaulted line is being recovered`), F1 below; sets the LP's lock to `now + min_hold_ms`; at least `MIN_DEPOSIT` (0.001 NEAR); refuses when shares are 0 or `assets` is 0 with shares outstanding |
| `withdraw(shares)` | an LP | `amount = floor(shares * assets / total_shares)`; refuses above `idle` with the most shares that can leave now; burns, lowers `idle`, then transfers; `on_withdraw` restores the state if the transfer failed |
| `register_card(card, borrower)` | owner | asks the card `get_roles` and, in `on_card_roles`, requires `owner_id == pool owner`, `approver == borrower`, `sponsor == this pool`, and `borrower != owner`; then stores the card. The role check is on chain, so the trust assumption of AIR-327 is checked, not stated |
| `post_collateral(card)` payable | the card's borrower | adds to the card's collecting line |
| `open_line(card, limit, fee_bps, due_ms)` | owner | needs `collateral >= ceil(limit * collateral_bps / 10000)`, `idle >= limit`, `fee_bps <= 5000`, `now < due_ms <= now + 90 days`, no other line; moves `limit` from `idle` to `lent`, then transfers it to the card; `on_line_funded` restores the state if the transfer failed |
| `on_card_return(card)` payable (emits `swept`) | the card account itself | credits the open line: `credited = min(deposit, limit - returned)`; `idle += credited`, `lent -= credited`, `returned += credited`; the excess is sent back to the card. After a default it credits the loss recovery in the same way (losses fall, never below 0) |
| `repay(card)` payable | anyone | `outstanding = limit - returned`, `fee = ceil(outstanding * fee_bps / 10000)`, `owed = outstanding + fee`; needs `deposit >= owed`; `idle += owed`, `lent -= outstanding`, `fees_earned += fee`, the excess is refunded, the collateral goes back to the borrower, the line closes. Nothing is owed after a full sweep, so the fee is paid on what the card kept |
| `default(card)` | anyone, after `due_ms`, `owed > 0` | the collateral covers principal first, then fee: `seized = min(collateral, owed)`; the part of `outstanding` beyond `seized` is added to `losses`; what is left of the collateral goes back to the borrower; the line closes `Defaulted` |
| `withdraw_collateral(card, amount)` | the card's borrower | while the card has no open line (collateral posted but the line never opened, or a failed funding left it): lowers `collateral` and `collateral_held` first, then pays the borrower. Refused with an open line (the collateral secures the draw) |
| `write_off(card)` | owner | clears an unrecovered loss of a defaulted card: the loss stays in `losses` (the share price does not move) and the card is free for a new line; later sweeps are not credited as recoveries |
| `set_collateral_bps(bps)` | owner | 0 to 10000; open lines keep the value they were opened with |

Rounding always favours the pool: shares floor on deposit, amounts floor on withdraw, fees ceil. Every state change happens before the
promise that moves NEAR, and every transfer that can fail has a callback that restores the state, so no path loses accounting on a failed
transfer.

After a default the pool cannot pause or sweep the card (the issuer owns it): the issuer pauses the card and sweeps what is left, and that
sweep is credited back as a recovery. The card's own funds are the pool's only recourse beyond the collateral.

Three rules came out of the security review of the contract (each has a failing test first and its mutants in the table below):
- **A loss cannot be erased.** The unrecovered loss of a defaulted card lives on the card (`Card.loss`), not on its line. A card with a
  loss is terminal: `post_collateral` and `open_line` refuse it (`the card has an unrecovered loss`). Recoveries (sweeps, D5) lower it;
  the owner's `write_off` clears it and keeps it in the pool's `losses`.
- **Overdue lines are impaired in the share price.** `assets` counts the outstanding principal (drawn minus returned) of an open line as 0
  once `now > due_ms`, whether or not anyone has called `default` (`get_pool.impaired` shows the amount). So the price drops at the due
  time for withdrawals and LPs cannot leave at the old price before a default. **Deposits are refused while any line is past due (F1,
  found in review, redesigned after a second review):** one valuation serves both sides. A deposit priced at the impaired value lets a
  newcomer buy cheap before the borrower (a colluder) repays; priced un-impaired it lets an incumbent who expects a default wait for new
  deposits to lift the price, withdraw, and leave the loss with the newcomers. With deposits closed while `impaired > 0`, a deposit always
  prices at `assets` with nothing impaired, so no value moves between LPs across the overdue window. Liveness: `default` is permissionless
  after the due date, books the loss and clears the impairment; a repay reopens deposits too. **After a default deposits stay closed
  until the loss is recovered or written off** (third review): a recovery sweep raises the price, so a deposit between the default and
  the recovery would buy cheap and take part of the recovery from the incumbents. A partial recovery keeps them closed; the full
  recovery reopens them at the recovered price, and the issuer's `write_off` reopens them at the post-loss price. Liveness therefore
  depends on the issuer (to sweep or write off), which is part of the issuer-trust limitation in docs/KNOWN_LIMITATIONS.md.
- **Minimum hold.** The fee is booked in one step at `repay`, so an LP could deposit just before a repay and withdraw just after with a
  share of it (the borrower could do this to recapture his own fee). Each deposit sets that LP's `locked_until_ms = now + min_hold_ms`
  (the whole position restarts its clock), and `withdraw` refuses before it: `withdraw is locked until <ms>: shares are held for
  <min_hold_ms> ms after a deposit`. `min_hold_ms` is an optional argument of `new` (default 86 400 000, 24 hours), shown in `get_pool`;
  `get_lp` shows `locked_until_ms`. What remains: an LP who deposits a full hold period before a repay it knows about still captures a pro
  rata share of that fee; time-accrued fees are the follow-up. The seized collateral and any
  recovery enter the assets when they are booked (at `default` and at the recovery sweep), so they accrue to the holders at that time,
  not to those who left earlier; a repay after the due date but before the default restores the price at once. The share price walks the
  lines, so a pool holds at most 100 cards.
- **Collateral cannot be locked.** `withdraw_collateral` returns collateral while no line is open, and `on_line_funded` refunds the
  collateral of a line whose funding transfer failed, together with the principal returning to `idle`.

### Views and events (the names the /credit page is built on)

Amounts are yocto decimal strings everywhere.

- `get_pool` returns `{ assets, shares, idle, staked, lent, impaired, fees_earned, losses, collateral_held, collateral_bps, share_price, min_hold_ms, lines: [{ card, borrower, limit, drawn, returned, fee_bps, due_ms, state }] }`. `assets = idle + lent + staked`; `staked` is 0 until AIR-332 (idle liquidity sent to earn yield), so
  the share price formula already has its slot. `drawn` is the principal funded when the line opened (equal to `limit`), `returned` what
  sweeps credited, `state` one of `Collecting`, `Open`, `Repaid`, `Defaulted`. `lines` is the same list as `list_lines(0, 50)`.
- `get_lp(account)` returns `{ shares, value, locked_until_ms }`, `get_line(card)` one line or null, `list_lines(from_index, limit)` clamped to 50, `get_card(card)`.
- `deposit()` is payable, `withdraw({ shares })`.
- Events use the NEP-297 envelope with standard `airlock-credit`, version `1.0.0`: `deposit` `{ account, amount, shares }`, `withdraw`
  `{ account, amount, shares }`, `card_registered` `{ card, borrower }`, `collateral_posted` `{ card, amount }`, `line_opened`
  `{ card, borrower, limit, fee_bps, due_ms }`, `swept` `{ card, amount }` (the pool credited a return from the card, emitted by
  `on_card_return`), `repaid` `{ card, amount, fee }`, `defaulted` `{ card, seized, loss }`, `params_set` `{ collateral_bps }`, `collateral_withdrawn` `{ card, amount }`, `write_off` `{ card, loss }`, `line_funding_failed` `{ card, limit, refund }`. The card
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

### AIR-328 as built

`contracts/airlock-credit`: `src/math.rs` (256 bit `mul_div`, share, fee and collateral math), `src/lib.rs` (the contract), `src/tests.rs`
(27 unit tests including a property test of the accounting over 12 random sequences of 120 operations), `tests/pool.rs` (sandbox, with the
real airlock-policy wasm and the mock signer, reusing the policy crate's test helpers; `tests/contracts` is a symlink to the policy
crate's). Two details beyond the design: failed payouts (the collateral, a refund, an excess) are parked in `unclaimed` and taken with
`claim`, so no accounting is lost on a transfer to a deleted account; and `register_card` and `open_line` are not payable (the pool never
needs a deposit from the issuer).

The sandbox suite pins: the happy path (LPs deposit 60 and 40, the issuer registers the card, the pool checks its roles on chain, the
borrower posts collateral, the line funds the card, the agent pays a book merchant through the verdict, an injected payee is held and
nothing moves, a sweep is refused while an escalation is pending, then credited, the borrower repays with the fee, an LP withdraws more
than it deposited); a default after the due date with the collateral seized and a recovery sweep after the issuer pauses the card;
`register_card` refusing a card whose roles are not the pool's; and the case the review asked for, "the borrower tries to pay himself
through his agent": held as a new payee, the approver refused, `approve_and_remember` and `book_set_root` refused to him, the pool and
the card untouched.

#### Mutation check of the money paths

Each mutant was applied alone and the library tests run (the unit tests of `src/tests.rs` and `src/math.rs`).

| Mutant | Killed by |
| --- | --- |
| shares round up on deposit | `deposit_then_withdraw_never_gains`, `first_deposit_is_one_to_one_and_later_ones_round_down`, `deposit_refusals` |
| amounts round up on withdraw | `withdraw_rounds_down_and_never_pays_more_than_pro_rata`, the property test |
| the fee rounds down | `fee_and_collateral_round_up` |
| `on_card_return` accepts any caller | `only_the_card_returns_funds_and_the_excess_goes_back` |
| repay accepts less than owed | `repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral` |
| `open_line` without the collateral requirement | `open_line_needs_collateral_liquidity_and_sane_terms` |
| `open_line` without the idle liquidity check | `open_line_needs_collateral_liquidity_and_sane_terms` |
| `default` before the due date | `default_seizes_collateral_principal_first_and_books_the_rest_as_a_loss` |
| `default` seizes all the collateral, not only what is owed | `default_with_collateral_above_what_is_owed_returns_the_rest` |
| the collateral is not returned on repay | `repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral` (it first survived a weaker assertion; the test now pins the amounts sent) |
| the leftover collateral is not returned on default | `default_with_collateral_above_what_is_owed_returns_the_rest` |
| the excess of a return is not sent back | `only_the_card_returns_funds_and_the_excess_goes_back` |
| `register_card` without the owner check | `register_card_is_owner_only_and_never_the_pool_or_the_issuer_as_borrower` |
| `withdraw` does not lower idle | `withdraw_pays_the_pro_rata_amount_down_to_idle_and_refuses_beyond`, `a_failed_withdraw_transfer_gives_the_shares_back` |
| the fee is not added to the fees earned | `repay_charges_the_fee_on_what_the_card_kept_and_returns_the_collateral` |
| a new line can reset a loss (post_collateral without the loss guard) | `a_card_with_an_unrecovered_loss_is_terminal_until_recovered_or_written_off` |
| a new line can reset a loss (open_line without the loss guard) | same test |
| overdue lines are not impaired | `an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default` |
| the deposit guard removed (F1: a deposit while a line is past due) | `deposits_are_refused_while_a_line_is_past_due_and_reopen_after_default`, `an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default`, `property_random_operations_keep_the_accounting` |
| the loss guard removed (a deposit between a default and its recovery) | `deposits_stay_closed_between_a_default_and_its_recovery`, `a_write_off_reopens_deposits`, `deposits_are_refused_while_a_line_is_past_due_and_reopen_after_default`, `property_random_operations_keep_the_accounting` |
| the hold check removed or off by one (`ms() >= locked`) | `shares_are_held_for_min_hold_ms_after_a_deposit`, `a_deposit_just_before_a_repay_cannot_capture_the_fee` |
| the lock not set at deposit | same tests |
| a deposit priced at idle + lent + staked instead of `assets` | equivalent mutant: with the guard in force nothing is impaired, so both values are equal |
| a withdraw is priced at idle + lent + staked (LPs leave at the old price) | `an_overdue_line_is_impaired_in_the_share_price_before_anyone_calls_default` |
| `withdraw_collateral` open to anyone | `collateral_can_be_withdrawn_by_the_borrower_while_no_line_is_open` |
| `withdraw_collateral` with an open line | same test |
| `withdraw_collateral` pays before lowering the state (collateral held not lowered) | same test |
| a failed funding does not refund the collateral | `a_failed_funding_transfer_refunds_the_collateral` |
| `write_off` does not clear the loss | `a_card_with_an_unrecovered_loss_is_terminal_until_recovered_or_written_off` |
| `write_off` open to anyone | same test |
| `default` does not record the loss on the card | `a_recovered_loss_frees_the_card`, the terminal-card test |

## Summary (moved from the README, section AIRLOCK Credit)

LPs deposit NEAR in a pool contract, and an agent borrows through a card: an AIRLOCK policy that the issuer owns, with the borrower as its approver and the pool as its sponsor [C21]. The card is a normal AIRLOCK policy, so its Base lane is the one shown in [C10] and [C2b] and its Solana lane the one in the Solana lane section of `docs/EVIDENCE.md`, and this page shows no credit card spending on either chain.

A borrower who asks his agent to pay his own account cannot approve it, because the approver may approve only a payee that is in the issuer's book [C21]. On testnet that approve reverted with the contract's own text [C19]. LPs earn the fee: an LP deposited 3 NEAR and withdrew 3.03 NEAR after the borrower repaid with a fee [C19]. A line that is not repaid defaults after its due date, the collateral is seized and the rest is booked as a loss, and on testnet a sweep of the paused card recovered that loss [C19]. While a line is past due or a loss is unrecovered the pool refuses deposits, and shares are held for a minimum time after a deposit, so a newcomer cannot buy cheap before a repay or a recovery [C20]. The pool's rules are pinned by 42 unit tests and a sandbox suite [C20].

What this does not show: everything ran on NEAR testnet between our own accounts; the issuer picks the borrowers, limits and collateral and is trusted; losses beyond the collateral fall on the LPs; staking, share tokens, Passport and Intents funding are not shipped; and the crate is not yet in `scripts/check.sh`, so a green `scripts/check.sh full` does not cover its tests (`docs/KNOWN_LIMITATIONS.md`).

A lender's worst case, with what collateral covers and what it does not: `docs/UNDERWRITING.md`.
