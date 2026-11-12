# Decision AIR-327 and AIR-328: AIRLOCK Credit

Status: AIR-327 (the roles) and AIR-328 (the pool contract, `contracts/airlock-credit`) are built; the coordinator approved the design and decisions D1 to D5 on 2026-11-08.

## AIR-327: the card policy has three roles

A credit line funds an AIRLOCK policy, the card. Three accounts stand around it:

| Role | Account | What it can do |
| --- | --- | --- |
| issuer | `owner_id` (the pool's issuer) | everything the owner could do before: book (`book_set_root`), assets, flags, pause, task key, agents, `reset_escalations`, `reject` (so a pending escalation never blocks `sweep`), and `sweep`; `approve` as an override for a payment to a payee that is not in the book (never for a booked one) |
| borrower | `approver` (set at init) | `reject` any held payment; `approve` a held payment only to a payee in the book at the current epoch, never one held outside the task, over the task bound or over the payee's daily limit, and only when the payee's daily limit and the task bound can take the full amount; nothing else |
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
  untrusted text, a trigger or a recipient from untrusted text) and nothing else, and only inside the issuer's bounds (red-team lane 1,
  2026-11-11): a hold for `OutsideTask`, `OverTaskBound` or `OverPayeeLimit` is refused to the approver (`approve refused for the
  approver: the payment is held <reason> ...`), and any other hold must fit what is left of the payee's daily limit and of the task
  bound in full (`... above what is left of the payee's daily limit` or `... of the task bound`), where the owner's approval charges
  those ledgers only up to their limits. The refused request stays pending: either party may reject it, or it expires. The owner cannot
  approve it either (a booked payee is the approver's to settle), so a payment past the issuer's bounds needs a new task from the
  issuer. Both live cards run this code since their code-only redeploys of 2026-11-12 UTC (docs/EVIDENCE.md, Card redeploy with the
  approver bounds; `pnpm tsx scripts/credit-card-code-check.ts --verify`). The credit card holds no access key since the lock of
  2026-11-12T04:51Z (docs/EVIDENCE.md, The lock), so this code can no longer be replaced there; the practice card keeps its key. `init` refuses an approver equal to the owner.
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
| `lps: LookupMap<AccountId, u128>` | shares per LP; the entry (and the LP's `locks` entry) exists from its first deposit until a full withdraw removes it (2026-11-11 storage fix below) |
| `cards: IterableMap<AccountId, Card>` | `{ borrower, line: Option<Line> }`; one line per card at a time |
| `Line` | `{ limit, returned, fee_bps, due_ms, collateral, state: Collecting | Open | Repaid | Defaulted }` |

`assets = idle + lent + staked - impaired` (principal at cost, an overdue line impaired to 0; fees and losses enter when they are realised, never as a mark to market). The share price is
`assets * 10^24 / total_shares` (yoctoNEAR per share scaled by 10^24, a decimal string in views).
`staked` stays 0 in this ticket, no call moves it. Pool accounting uses these fields only, never the contract's balance, so a plain transfer to the contract cannot move the share price (no
donation attack). The invariant `contract balance >= idle + collateral_held + refunds in flight` is a property test.

### Calls

| Call | Who | Rule |
| --- | --- | --- |
| `deposit()` payable | anyone | `shares = amount` when `total_shares` is 0, else `floor(amount * total_shares / assets)`; refused while any open line is past its due date (`deposits are paused while a line is past due`) or any card carries an unrecovered loss (`deposits are paused while a defaulted line is being recovered`), F1 below; sets the LP's lock to `now + min_hold_ms`; at least `MIN_DEPOSIT` (0.001 NEAR); a caller with no `lps` entry pays `LP_STORAGE` (0.0025 NEAR) for its entries out of the attached amount, `amount` is the rest and must still be at least `MIN_DEPOSIT`; refuses when shares are 0 or `assets` is 0 with shares outstanding |
| `withdraw(shares)` | an LP | `amount = floor(shares * assets / total_shares)`; refuses above `idle` with the most shares that can leave now; burns, lowers `idle`, then transfers; withdrawing all of an LP's shares removes its `lps` and `locks` entries; `on_withdraw` restores the shares if the transfer failed |
| `register_card(card, borrower)` | owner | asks the card `get_roles` and, in `on_card_roles`, requires `owner_id == pool owner`, `approver == borrower`, `sponsor == this pool`, and `borrower != owner`; then stores the card. The roles are the card account's own `get_roles` answer, read on chain; the pool does not read the card's code, so a contract that is not an AIRLOCK card but gives that answer is registered too. The trust assumption of AIR-327 rests on the owner, who registers the cards (docs/KNOWN_LIMITATIONS.md, credit pool owner powers) |
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
- Events use the NEP-297 envelope with standard `airlock-credit`, version `1.0.0`: `deposit` `{ account, amount, shares, storage }` (`amount` is what the pool credited, `storage` the charge of a first deposit, "0" otherwise), `withdraw`
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
- Mainnet needs the author's yes; everything here is testnet.

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

LPs deposit NEAR in a pool contract, and an agent borrows through a card: an AIRLOCK policy that the issuer owns, with the borrower as its approver and the pool as its sponsor [C21]. The card is a normal AIRLOCK policy, so its Base lane is the one shown in [C10] and [C2b] and its Solana lane the one in the Solana lane section of `docs/EVIDENCE.md`. The credit card paid a booked merchant on Base Sepolia through MPC; an injected address was refused (2026-11-10, AIR-339) [C25]. The ETH it spent was placed on its Base address by us; credit lines live on NEAR. The card has not spent on Solana.

A borrower who asks his agent to pay his own account cannot approve it, because the approver may approve only a payee that is in the issuer's book [C21]. On testnet that approve reverted with the contract's own text [C19]. LPs earn the fee: an LP deposited 3 NEAR and withdrew 3.03 NEAR after the borrower repaid with a fee [C19]. A line that is not repaid defaults after its due date, the collateral is seized and the rest is booked as a loss, and on testnet a sweep of the paused card recovered that loss [C19]. While a line is past due or a loss is unrecovered the pool refuses deposits, and shares are held for a minimum time after a deposit, so a newcomer cannot buy cheap before a repay or a recovery [C20]. The pool's rules are pinned by 42 unit tests and a sandbox suite [C20].

What this does not show: everything ran on NEAR testnet between our own accounts; the issuer picks the borrowers, limits and collateral and is trusted; losses beyond the collateral fall on the LPs; staking, share tokens, Passport and Intents funding are not shipped; and the crate is not yet in `scripts/check.sh`, so a green `scripts/check.sh full` does not cover its tests (`docs/KNOWN_LIMITATIONS.md`).

A lender's worst case, with what collateral covers and what it does not: `docs/UNDERWRITING.md`.

## AIR-333: the Credit Passport on chain

Today `open_line` takes any limit the issuer types, and the score on /credit is computed in the page. This section moves a per-borrower
record and a score into the pool contract and makes the score cap the next line. Two rules make the cap mean something: the record is
keyed by the borrower account (`Card.borrower`), so a borrower cannot reset a default by getting a new card; and the issuer can lower the
cap base at once but a raise binds only after `min_hold_ms`, so every LP can leave before a raise takes effect. No token: the NEP-171
soulbound token is cut (no `nft_*` method, no SVG, no media).

The record is written by pool events only (line funded, repay, default, card return, write-off). The pool never sees a card payment, so
held and refused payments are not inputs: they are the guard working, not the borrower failing.

### State and the in-place upgrade

- `src/legacy.rs` holds `PoolV1`, a verbatim copy of the deployed `Pool` (the c1108d layout, pinned by the layout tests).
- `Pool` gains, after `min_hold_ms`: `records: LookupMap<AccountId, CreditRecord>` under a new `StorageKey::Records` appended after
  `Locks` (prefix byte 4), then `passport_base: u128`, `pending_base: Option<(u128, u64)>` (value, effective time in ms),
  `floor_base: u128` (the highest base in force so far), then (AIR-350, see below) `base_checks: LookupMap<String, BaseCheck>` under a new
  `StorageKey::BaseChecks` appended after `Records` (prefix byte 5), `mpc_signer: AccountId` and `foreign_domain_id: u64`, and last
  `version: u32` (2). `Card`, `Line`, `LineState` and the four existing prefixes keep their bytes, so no stored card or LP entry is
  rewritten.
- `migrate(passport_base: U128, mpc_signer: AccountId, foreign_domain_id: u64)` is `#[private] #[init(ignore_state)]`: it reads `PoolV1`, moves every field unchanged, sets the base (and `floor_base` to it) and
  backfills the records. Run on an already migrated state it fails (the stored bytes are no longer a `PoolV1`). The live upgrade is ONE
  transaction with two actions, `DeployContract` then `FunctionCall migrate`, so the pool never runs new code on old state.
- The deployed bytes are kept as `res/airlock_credit_c1108d.wasm`, sha256
  `1f915ce22956f33c4b65d092838c0429e2255dd6d224b6c58db8f9b941343419`, pinned by a test.
- `new` takes an optional `passport_base` (default 100 NEAR) so a fresh pool needs no migrate.

**Backfill rule: count only what the stored state proves.** The old state keeps one line per card and no history. Per card with a line in
`Open`, `Repaid` or `Defaulted`: `lines_opened += 1`. A `Defaulted` line is one default. A `Repaid` line is not counted as on time or
late, because its timing is not stored. A loss cleared to 0 cannot be told apart from a write-off in the stored state, so it counts as
neither recovered nor written off; an unrecovered loss stays a plain default. Every backfilled record has `backfilled: true` and the
reasons say so. The live c1108d card held one `Defaulted` line whose loss was recovered when this was written: 1 default, score 200. By the
upgrade (2026-11-10) the hourly loop had replaced it with a `Repaid` line of 0.09 NEAR, so the backfill gave 1 line opened and nothing else:
score 500, cap 1 NEAR (docs/EVIDENCE.md, Pool upgrade and Credit Passport run).

### The record

`CreditRecord { lines_opened: u32, repaid_on_time: u32, repaid_late: u32, defaults: u32, recovered: u32, written_off: u32,
volume_repaid: u128, fees_paid: u128, last_event_ms: u64, backfilled: bool }`, keyed by `Card.borrower`. A second card registered for
the same borrower reads and writes the same record.

| Event | Update |
| --- | --- |
| `on_line_funded`, transfer succeeded | `lines_opened += 1` (a failed funding counts nothing) |
| `repay` | `volume_repaid += outstanding`, `fees_paid += fee`; the repay QUALIFIES when `outstanding * 10 >= limit` (the card kept at least 10 percent of the limit), `outstanding >= floor_base / 10` (an absolute floor: lines of a few yocto kept in full do not count), `fee_bps >= 100` (the line charged at least 1 percent) and `fee > 0`; a qualifying repay at or before `due_ms` is `repaid_on_time += 1`, after it `repaid_late += 1`; a dust, low fee or zero fee repay counts as neither, so neither empty lines nor tiny ones can farm the score. `floor_base` is the highest base the pool has had in force: `new` and `migrate` set it to the base, `apply_passport_base` lifts it with a raise, and a cut of the base leaves it where it is. So the issuer cannot cut the base, count a run of small lines and raise it back: after a cut only a draw of a tenth of the old base counts |
| `default` | `defaults += 1` |
| `on_card_return` after a default | `recovered += 1` when this return clears the card's loss to 0 (once: a card with no loss refuses later returns) |
| `write_off` | `written_off += 1` |

Every update sets `last_event_ms`.

### The score and the cap

`math::passport_score(&CreditRecord) -> (u32, Vec<String>)`, integers only, bounded 0..=1000:

    score = 500 + 80 * min(repaid_on_time, 5) - 40 * min(repaid_late, 5) - 300 * min(defaults, 2)
                + 150 * min(recovered, min(defaults, 2))      then clamped to 0..=1000

The reasons read like `base +500`, `repaid_on_time x2 +160`, `defaulted x1 -300` (a count above its cap shows `(5 count)`), plus
`clamped to 0` when the floor applies and `backfilled: counts only what the pool state proves` on a backfilled record.
`limit_cap = floor(passport_base * score / 500)` through `mul_div_floor`, so a fresh borrower at 500 gets exactly the base, 200 gets 0.4
of it and 0 gets nothing. These are rules of thumb on the pool's own events, not a credit model.

`open_line` refuses `limit > limit_cap`, checked right after `limit > 0` and before the collateral and liquidity checks, with
`the limit is above this card's Passport cap of X NEAR (score S)` (X a decimal NEAR string, trailing zeros trimmed).

The cap is per borrower, not per card. After that check `open_line` walks the cards (100 at most) and, for every other card of the same
borrower, refuses when the card has an unrecovered loss (`the borrower has an unrecovered loss on another card`) or an open line past
its due date (`the borrower has a line past due on another card`), and adds what the card still holds (`limit - returned` of an open
line). `limit` plus that sum above the cap is refused with `the limit is above what is left of the borrower's Passport cap of X NEAR
(score S): Y NEAR is out on their other cards`. Limit: the issuer registers the cards and names each borrower account, so this binds
per account. Two accounts of one person are two borrowers. The other rules are unchanged.

### The cap base

| Call | Who | Rule |
| --- | --- | --- |
| `set_passport_base(base)` payable, exactly 1 yocto | owner | `base <= passport_base`: applies at once, clears any pending raise, emits `passport_base_set { base }`. `base > passport_base`: stored as `pending_base = (base, now + min_hold_ms)`, emits `passport_base_raise_announced { base, effective_ms }`; the base in force does not change |
| `apply_passport_base()` | anyone | needs a pending raise and `now >= effective_ms`; applies it, clears it, emits `passport_base_set { base }` |

An LP who deposited before the announcement is unlocked before the raise binds (its lock is its deposit time plus `min_hold_ms`, which is
earlier than the announcement time plus `min_hold_ms`), so every LP can leave before a raise applies. A lower base (and a lower score) can
only shrink the next line, so it needs no notice. It does not lower `floor_base`, the base the draw floor of a counted repay is taken
from (see the record table), so a cut never makes the score cheaper to earn.

### Views

- `get_passport(card) -> { borrower, score, reasons, record, limit_cap }` (null for an unknown card); `record` has its amounts and
  `last_event_ms` as decimal strings.
- `get_pool_passport() -> { base, pending_base, effective_ms, version, floor_base }` (`pending_base` and `effective_ms` null when nothing is
  pending; `floor_base` is the highest base the pool has had in force).
- `PoolView`, `LineView` and `LpView` are unchanged (the web parses them).

### Tests, each written failing first, and the rule each pins

| Test | Rule |
| --- | --- |
| `passport_score_properties` (math, random records) | one more qualifying on-time repay never lowers the score; a default never raises it and lowers it while fewer than 2 are counted and the score is above 0; the score stays in 0..=1000; recovered never counts above defaults |
| `passport_vectors_match` (vectors/passport.json) | records to score, reasons and cap; the same file feeds the web later |
| `dust_and_zero_fee_repays_do_not_count` | a repay with under 10 percent drawn or a zero fee moves neither counter |
| `ten_dust_lines_kept_in_full_do_not_raise_the_score` | ten lines of a thousandth of the base kept in full, a line one yocto under `floor_base / 10`, a line at 99 bps and a late dust line move neither counter nor the cap; a line exactly at both floors counts |
| `a_cut_of_the_base_does_not_lower_the_draw_a_repay_needs_to_count` | after a cut to a thousandth of the base, ten lines at the whole cut cap kept in full count nothing and the raise back leaves the score at 500; a raise lifts `floor_base` and a later cut leaves it |
| `the_cap_counts_what_the_borrower_holds_on_their_other_cards` | a second card of the borrower takes only what is left of the cap; a sweep on the first frees room; another borrower's card has its own cap; a line past due or a loss on one card refuses a line on the other |
| `the_record_follows_the_borrower_not_the_card` | a new card for a borrower with a default starts at that borrower's score, not 500 |
| `a_lower_base_applies_at_once_a_raise_only_after_min_hold_ms` | lower at once and clears a pending raise; a raise not in force 1 ms before `now + min_hold_ms`, applied at it; an LP who deposited before the announcement withdraws before it binds |
| `set_passport_base_is_owner_only_with_one_yocto` | a non owner refused, no deposit refused |
| `open_line_above_the_cap_is_refused_then_allowed_after_an_on_time_repay` | the cap text and score; the same limit opens after a qualifying repay |
| `the_record_counts_each_pool_event` | funded, failed funding, repay on time, late, default, recovery, write-off |
| `migrate_moves_every_field_and_backfills_only_what_the_state_proves`, `migrate_twice_is_refused`, `layout_*` | the v1 to v2 move, the backfill rule, the appended prefix |
| the property test, extended | the sum rules unchanged with records and the cap in force |
| sandbox `upgrade_from_the_c1108d_wasm_keeps_every_view_and_still_works` | the pinned wasm runs a history (deposit, card, collateral, line, repay, second line, default, recovery sweep); `get_pool`, `get_line`, `list_lines`, `get_lp`, `get_unclaimed` are snapshotted; deploy plus migrate in one transaction; every view is equal and `get_passport` reads 1 default, score 200, backfilled; then a new deposit, a withdraw after the lock, an over-cap `open_line` refused with the cap text, an `open_line` inside the cap, an agent payment to the booked merchant through the verdict (Allow), a sweep, an on-time repay that raises the score and the cap, a second `open_line` at the earlier refused limit, a default and a recovery sweep all work on the upgraded state with the sum rules asserted. There is no rollback on the live pool, so this test gates the live run |

Mutants (each applied alone, killed by a named test, rows in docs/mutation.md): the cap not enforced, a dust repay counted, migrate drops
a field, the record keyed by card instead of borrower, a raise applied at once.

### Live plan (pool.airlock-credit-c1108d.testnet only)

After the coordinator removes `target/arena/LIVE_OK` and 65 minutes have passed since the last arena transaction:
`scripts/credit-passport-run.ts` checks the four keys (pool, issuer, borrower, agent), that no line is open or past due and no escalation
is pending on the card, then the storage: the pool balance must cover `(new wasm bytes + new state bytes) x 1e19 + LP assets + unclaimed
+ 0.2 NEAR`, else the issuer tops it up first. One transaction deploys the wasm and calls `migrate(passport_base = 1 NEAR)`; the code hash
must equal the committed wasm and the pool views must equal the snapshot. Then, with every number read from `get_passport`: the
over-cap limit `L` in `(cap, 1.4 x cap]` is refused with the cap text, a line of 0.3 NEAR opens, the agent pays the booked merchant 0.1
NEAR (Allow), the issuer sweeps the rest, the borrower repays on time with the fee, the score and cap rise, `L` opens and is closed at once
by a sweep and a repay (an undrawn close counts as neither on time nor late). No line stays open. Expected when this was written: 200 and
0.4 NEAR before, 280 and 0.56 NEAR after. The script now reads the score and both caps from the chain and picks `L` as the middle of (cap
before, cap after one on-time repay] (a0a0da6). The actual run on 2026-11-10: 500 and 1 NEAR before, 580 and 1.16 NEAR after, `L` 1.08 NEAR
(upgrade transaction `AXfP2CKgY31WxbBfrisb9YfKbg3q3XYad3SA9GbazzUN`, the rest in docs/EVIDENCE.md).

### What this does not do

- The backfill counts only what the state proves: the live borrower started at 500 (one `Repaid` line, timing unknown), not at a
  reconstructed history.
- The score is pool side only; held and refused payments are not inputs.
- The record is keyed by borrower account: a borrower on a NEW account starts fresh at 500 (the full base). The Passport stops a reset on
  the same account, not a new identity; only the issuer registers borrowers, so onboarding is where identity is checked.
- The cap is per line, not per pool: many fresh borrowers can each take up to the base.

### AIR-333 as built

- `src/legacy.rs` (`PoolV1`), `src/lib.rs` (record, cap, cap base, `migrate`, the two views), `src/math.rs` (`passport_score`, `limit_cap`,
  `near_decimal`), `vectors/passport.json` (11 records with score, reasons and cap; read by `passport_vectors_match`).
- `res/airlock_credit.wasm` stays the c1108d bytes (sha256 `1f915ce2...`, the hash docs/EVIDENCE.md and
  `scripts/credit-evidence-check.sh` read); `res/airlock_credit_c1108d.wasm` is the same bytes pinned by `the_c1108d_wasm_is_pinned` for
  the rehearsal; `res/airlock_credit_v2.wasm` is the upgrade the live run deploys (rebuilt with AIR-350; sha256
  `e754b6aa1b6f06dde89fb388d799d7adfb4589429a0c9fe745073018109f0bcd`, code hash `Ga26kv1dYjLoHokUa2DU5XZmATDscBtEst8ajjAZphjr`; since
  the 2026-11-11 storage fix that path holds the fixed build and these bytes are kept as `res/airlock_credit_v2_e754b6aa.wasm`). Its
  preflight refuses to run unless the v2 file equals the wasm the sandbox rehearsal ran.
- Tests: 62 unit tests (15 new ones failed against stubs of the rules before the rules were written: score, cap, near string,
  record writes, backfill, cap base) and 5 sandbox tests. The rehearsal passed on its first run; it is the gate, and every rule it walks
  through is pinned by a unit test that failed first.
- `scripts/credit-passport-run.ts`: preflight only by default (reads the chain, sends nothing); `--live` runs the upgrade and the Passport
  steps. The preflight of 2026-11-09 passed every check but one: the card is paused (the c1108d run paused it before the recovery sweep),
  and a paused card refuses the agent's payment. `UNPAUSE_CARD=1` lets the issuer unpause it as the first live step, logged as a row.
  Storage needs no top-up: the pool holds 5.45 NEAR against 4.92 NEAR needed.
- Live since 2026-11-10T22:47:06Z: transaction `AXfP2CKgY31WxbBfrisb9YfKbg3q3XYad3SA9GbazzUN` deployed `res/airlock_credit_v2.wasm` on
  `pool.airlock-credit-c1108d.testnet` and called `migrate`; the run is in docs/EVIDENCE.md (Pool upgrade and Credit Passport run) and C23.
  These bytes ran until the code-only redeploy of 2026-11-11 (below, 2026-11-11: a lender pays for its own storage).

## AIR-350: the pool asks the MPC network whether a Base payment landed, and keeps the answer

The AIR-342 spike (2026-11-10) showed the testnet MPC signer answers `verify_foreign_transaction` for a Base Sepolia transaction, but the
answer lived in the receipt of whoever asked and nowhere else: the signer keeps no copy. With AIR-350 the pool is the asker and
the keeper: it asks the MPC network and records its signed answer, so anyone can later read with a view that a given Base Sepolia
transaction was checked back on NEAR. It enforces nothing:
no line, repay, default or cap reads it.

### API

- `check_base_payment(tx_id: String) -> Promise`, `#[payable]`, anyone. `tx_id` is exactly 64 lowercase hex characters, no 0x. The
  attached deposit is at least `BASE_CHECK_FEE` (0.01 NEAR) and the prepaid gas at least 60 Tgas (`GAS_BASE_CHECK_MIN`), each refused
  with its own message. An id already recorded is refused. The call sends `verify_foreign_transaction` to the configured signer with
  `{"request":{"request":{"Base":{"tx_id":<tx_id>,"extractors":["BlockHash"],"finality":"Finalized"}},"domain_id":<domain>,"payload_version":1}}`,
  1 yocto and 20 Tgas, then `on_base_check` with 20 Tgas of static gas.
- `on_base_check(tx_id: String, asked_by: AccountId, fee: U128)`, `#[private]`. It reads at most 2,048 bytes of the answer. A readable
  answer (`payload_hash` a string of 64 hex, stored lowercase; `signature` a JSON object of at most 512 bytes as compact JSON) for an id
  not yet recorded is stored as `BaseCheck { payload_hash, signature, asked_by, recorded_ms }`, the event `base_payment_checked` is
  emitted and any fee above 0.01 NEAR goes back. A failed or timed out call, a longer answer, an unreadable one, or an id recorded while
  this check was in flight stores nothing, emits `base_payment_unchecked` with the reason, and refunds the fee less the 1 yocto sent to
  the signer through `payout` (a failed refund is parked in `unclaimed` for `claim`).
- Views: `get_base_check(tx_id) -> Option<BaseCheckView>` (`tx_id`, `payload_hash`, `signature`, `asked_by`, `recorded_ms`) and
  `get_base_check_config() -> { mpc_signer, domain_id, fee }`.
- `new` takes optional `mpc_signer` and `foreign_domain_id` (defaults `v1.signer-prod.testnet` and 3, the domain whose purpose is
  ForeignTx on testnet); `migrate` takes both explicitly, and `scripts/credit-passport-run.ts` passes `v1.signer-prod.testnet` and 3 and
  reads them back from `get_base_check_config` after the upgrade.

### Choices

- Two checks of one id can be in flight at once: the call refuses an id already recorded, and the callback keeps the record
  written earlier and refunds the later fee. A pending marker would refuse the second check up front, but a callback that never ran would
  leave the id blocked for good; the refund path needs no extra state.
- The signature is kept as the compact JSON of the object the signer returned. The contract's JSON library sorts object keys, so the
  stored text may order keys differently from the receipt; the values are the same.
- The fee is not pool money: no pool field (`idle`, `lent`, `total_shares`, `fees_earned`, `losses`, `staked`) moves, so the share price
  cannot move. 0.01 NEAR covers the storage of the largest record the bounds allow (a 64 character account, a 512 byte signature) plus
  the 1 yocto, pinned by `the_fee_covers_the_storage_of_the_largest_record`.

### Limits

- The answer says the transaction is final and succeeded and binds its id to a block hash (the `BlockHash` extractor). It does not name
  the payee or the amount.
- The pool does not recompute the payload hash and does not check the signature against `public_key(domain 3)`; it records what the
  signer returned. Anyone can check both offline, as the AIR-342 spike did.
- V1 answers successes and not failures: a failed or unfinalized Base transaction gets no answer, which the pool records as nothing (refund).
- There is no sandbox test of a signer answer: `contracts/mock-mpc` has no `verify_foreign_transaction` and its wasm is pinned for the
  policy tests, so it is not changed. The answer path is covered by unit tests with mocked promise results built from the answer the
  testnet signer gave on 2026-11-10. The sandbox walks the refusals, the private callback and the failure path (the sandbox has no
  `v1.signer-prod.testnet`, so the call fails and the fee less 1 yocto goes back).

### Tests

| Test | Rule |
| --- | --- |
| `base_check_refuses_an_id_that_is_not_64_lowercase_hex` | empty, 63 and 65 characters, a 0x prefix, upper case and a non hex character are refused |
| `base_check_refuses_a_fee_below_the_floor_and_too_little_gas` | one yocto under the fee and 59 Tgas are refused; exactly the fee and 60 Tgas pass |
| `base_check_asks_the_configured_signer_with_one_yocto` | one receipt goes to the configured signer, `verify_foreign_transaction`, 1 yocto, at least 20 Tgas, the exact args; the other is `on_base_check` on the pool |
| `a_signed_answer_is_recorded_and_the_view_returns_it` | the record, the view, the event, no refund at exactly the fee, the excess back above it, the config view |
| `a_recorded_id_is_refused_and_a_late_duplicate_keeps_the_earlier_answer` | two checks in flight: the earlier answer stays, the later fee goes back; a recorded id is refused up front |
| `a_failed_check_records_nothing_and_refunds_the_fee` | no record, the fee less 1 yocto back, the event, a failed refund parked for `claim`, the id can be asked again |
| `an_unreadable_or_oversized_answer_records_nothing` | not JSON, no or a non string hash, a short or non hex hash, no or a non object signature, a signature over 512 bytes, an answer over 2,048 bytes; an upper case hash is stored lowercase |
| `the_base_check_fee_cannot_move_the_share_price` | checks recorded, failed, unreadable and overpaid leave `get_pool` and every pool field unchanged |
| `the_fee_covers_the_storage_of_the_largest_record` | the storage of the largest record costs less than the fee |
| `new_defaults_to_the_testnet_signer_and_domain_3`, `migrate_moves_every_field_and_backfills_only_what_the_state_proves`, `layout_*` | the defaults, migrate sets the signer and domain it is given, the appended prefix 5 and fields |
| sandbox `upgrade_from_the_c1108d_wasm_keeps_every_view_and_still_works` | after the upgrade: the config view, a 0x id and a fee under the floor refused, `on_base_check` called from an account refused as private, a check against the absent signer records nothing, refunds the fee less 1 yocto with nothing parked, and leaves `get_pool` unchanged |

Mutants are listed in docs/mutation.md.

### AIR-350 as built

- `src/lib.rs` (`BaseCheck`, `check_base_payment`, `on_base_check`, `parse_base_answer`, the two views, the state fields),
  `src/tests.rs` (10 new tests: 8 failed against stubs of the two calls before they were written; the share price test, a guard, and
  the defaults test passed against the stubs), `tests/pool.rs` (the sandbox checks above), `scripts/credit-passport-run.ts` (the migrate args).
- `res/airlock_credit_v2.wasm` is rebuilt with it: sha256 `e754b6aa1b6f06dde89fb388d799d7adfb4589429a0c9fe745073018109f0bcd`, code hash `Ga26kv1dYjLoHokUa2DU5XZmATDscBtEst8ajjAZphjr` (kept as `res/airlock_credit_v2_e754b6aa.wasm` since the 2026-11-11 storage fix rebuilt `res/airlock_credit_v2.wasm`).
- Rehearsed against the real signer on 2026-11-10 (19:50Z, signer weather GOOD): this exact wasm was deployed with `new` on a throwaway
  test network account, `rehearse-52be79.airlock-fund-0c111e.testnet`, which was deleted afterwards. Three calls, each by the account
  that funded it:
  - a check of the Base Sepolia transaction 0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63 with 0.01 NEAR and 100 Tgas
    recorded the answer in about 14 s (NEAR transaction `8a6k6Hzdw8tYm9mNZeoupj7nXXffKoGbLB8nRuvMZQGd`, event `base_payment_checked`).
    `get_base_check` returned payload hash b38ee2231f49b349ec841663233049d739fbd6b00c786b729cda8814b92021c1, the hash the AIR-342 spike
    got for the same transaction. All receipts together burnt 13.74 Tgas, so the 60 Tgas floor has room;
  - the same id again was refused with `this Base transaction is already recorded`;
  - a check of an id that is no Base transaction, with exactly 60 Tgas, ended with `base_payment_unchecked`, reason `the signer call
    failed or timed out`, and a refund of the fee less 1 yocto (NEAR transaction `FQcfS89WaSb9eoYh4ZzzovWDy83LvM6L3b952vtENiEv`).
  So the signer's answer does reach `on_base_check` as its promise result. Not rehearsed: a signer timeout, and an answer over the read bound.
- Live on the pool since the upgrade of 2026-11-10 (`migrate` set `v1.signer-prod.testnet` and domain 3). The first check on the pool:
  `lp1.airlock-credit-c1108d.testnet` asked about Base Sepolia transaction
  0x943516649902f70da582a9116d6629906c41b4cdc6d41073b819fab7ea1cda63 in NEAR transaction `4aMpo4V2949S9Pp25GvxwrLa7x2Fb7zKjAr9crFpgqMz`
  (event `base_payment_checked`, payload hash b38ee2231f49b349ec841663233049d739fbd6b00c786b729cda8814b92021c1); docs/EVIDENCE.md (Base
  payment checked back on NEAR by the pool) and C24.
- The card's own payment checked (2026-11-10): the credit card paid the booked merchant on Base Sepolia through MPC (AIR-339, Base
  transaction 0xab2b3f8472b2faeb08fb842df676c3f84182e19389308f3245e05b5d4e63683c, C25), and once Base had finalized it, about 21 minutes
  after it was mined, `lp1.airlock-credit-c1108d.testnet` asked the pool about it in NEAR transaction
  `8KReKRKbYWAdmRz1dcRmw5rqR41tzhkzz75N31mLzGbQ` (event `base_payment_checked`, payload hash
  cbe31ebcb482f8e759eb4cfc67ae344b8332caa537ab8ca5dc90c097d98272f4). A check cannot be made sooner: the request asks for finality
  `Finalized`. docs/EVIDENCE.md (The card's Base payment checked back on NEAR by the pool) and C24.

## 2026-11-11: a lender pays for its own storage

### What and why

Before this change `deposit` inserted an `lps` entry and a `locks` entry for a new lender and charged nothing for them, and `withdraw`
wrote `lps` back as 0 on a full exit and kept `locks`. Each lender so cost the pool 164 to 242 bytes forever (0.0016 to 0.0024 NEAR at
1e19 yocto per byte), paid from the account's spare balance (about 1.4 NEAR on the live pool). About 590 deposit and full withdraw rounds
by throwaway accounts, or about 870 ordinary lenders, would use it up; after that withdrawals fail with `LackBalanceForState` until
someone sends the pool NEAR. The pool account's key is to be deleted, so this has to be fixed before then.

- `deposit`: a caller with no `lps` entry pays `LP_STORAGE` = 0.0025 NEAR (250 bytes) out of the attached amount. The pool credits
  `attached - LP_STORAGE`, which must still be at least `MIN_DEPOSIT`; otherwise the call is refused with `a first deposit needs at least
  0.0035 NEAR: 0.0025 NEAR pays for your entry in the pool's storage`. The charge is not pool money: it moves none of `idle`, `lent`,
  `total_shares`, `fees_earned` or the share price, stays in the contract's balance, and is not refunded. A caller with an entry, even one
  left at 0 shares by the earlier code, pays nothing. The `deposit` event keeps `account`, `amount` (the credited amount) and `shares`
  and gains `storage` (the charge, "0" when none).
- `withdraw`: withdrawing all of one's shares removes the `lps` and `locks` entries, so the storage they used is free again and a later
  first deposit pays the charge again. If the transfer fails, `on_withdraw` writes the shares back; the lock is gone with the entry,
  so the lender may withdraw at once (its hold had already passed), which is fine.
- Views: `get_lp` answers a missing entry as 0 shares, value 0, locked until 0, as it did for a zero entry.
- `on_card_roles` checks `MAX_CARDS` again before the insert, with the same text as `register_card`: two registrations in flight both
  passed the check in `register_card`, so the pool could hold 101 cards.

Nothing else moved: no state field, `STATE_VERSION` stays 2, `migrate`, the Passport, the Base check and the math are unchanged. The
state layout is unchanged, so the live pool takes this as a code-only redeploy (DeployContract with no init call).

### Tests

Unit (`src/tests.rs`, 81 tests, 9 of them new; 7 new tests and the property model failed against the code before the fix, the storage
size test fails under the third mutant of docs/mutation.md, and the pin test reads a file):

| Test | Rule |
| --- | --- |
| `a_first_deposit_pays_the_storage_charge_and_a_second_is_credited_in_full` | shares and `get_pool` count `attached - LP_STORAGE` only, the event carries `storage`; a second deposit and a deposit by an account with a 0 share entry are credited in full |
| `a_first_deposit_must_cover_the_minimum_and_the_charge` | `MIN_DEPOSIT + LP_STORAGE - 1` is refused with the text above and stores nothing; `MIN_DEPOSIT + LP_STORAGE` is accepted |
| `the_storage_charge_never_moves_the_share_price` | a second lender's first deposit at price 1.5 leaves the price and the first lender's value unchanged |
| `a_full_withdraw_removes_both_entries_and_a_partial_keeps_them` | read through `lps` and `locks`; the next deposit of that account pays the charge again |
| `a_failed_withdraw_transfer_after_a_full_exit_gives_the_shares_back` | shares, value, `idle` and `total_shares` restored, locked until 0, the lender withdraws again at once |
| `the_views_answer_a_missing_entry_like_a_zero_entry` | `get_lp` of a stranger, of a 0 share entry and after a full exit are equal |
| `the_charge_covers_the_storage_of_the_longest_lender` | the entries of a 64 character account cost no more than the charge, and a full exit gives every byte back |
| `the_callback_checks_max_cards_again` | 99 cards, two registrations in flight: the first callback stores card 100, the second is refused |
| `the_e754b6aa_wasm_is_pinned` | the sha256 of `res/airlock_credit_v2_e754b6aa.wasm` |
| `property_random_operations_keep_the_accounting` | the model learns the charge: an accepted deposit raises `idle` by `attached` less the charge of a lender with no entry, and each lender's two entries exist exactly while the model says so |

The existing tests whose lender is new attach `amount + LP_STORAGE`, so their credited amounts and expected shares are unchanged; no
assertion was changed or removed. In `deposit_refusals` the price that buys no share is reached with `MIN_DEPOSIT + LP_STORAGE` attached
by a new lender (the credited amount is `MIN_DEPOSIT`, as before).

Sandbox (`tests/pool.rs`, 6 tests): the five earlier tests stay green (the helper `funded_line` attaches the charge on top); the new
`the_storage_fix_redeploys_over_a_v2_pool_with_no_init_call` rehearses the live redeploy. It runs the c1108d history on the pinned c1108d
wasm, migrates to the e754b6aa bytes the live pool runs, then under that code lp3 deposits and lp4 deposits and leaves in full (a zero
`lps` entry and its lock, read from the contract state). It snapshots every view (`get_pool`, `get_line`, `list_lines`, `get_card`,
`get_lp` of five lenders, `get_unclaimed`, `get_pool_passport`, `get_passport`, `get_base_check_config`), deploys the new build with no init
call, and reads every view the same. Then lp1 (c1108d) and lp3 (v2) deposit and are credited in full, lp4 (zero entry) is credited in
full, lp5 (new) is charged with the share price unchanged and its entries costing no more than the charge; after the hold lp5 withdraws
all its shares, is paid their value, both entries are gone from the state and the pool's storage usage is back where it was before its
deposit. The Passport and the Base check config views still answer.

Mutants are listed in docs/mutation.md.

### Build

`res/airlock_credit_v2.wasm` is rebuilt with this change: sha256 `3e914f6f1a906ecfff5fb3f07cb7429c8edd85514e22e20a7b214de7f68791a9`,
code hash `5DEnqxwBiVwsxuXNzYeE3a9P4DLYuSj2pjnQKvY88xyN`, the bytes the sandbox suite ran. The bytes it replaces (sha256 `e754b6aa...`,
code hash `Ga26kv1dYjLoHokUa2DU5XZmATDscBtEst8ajjAZphjr`) are kept as `res/airlock_credit_v2_e754b6aa.wasm`.

### Live

Live on `pool.airlock-credit-c1108d.testnet` since 2026-11-11T18:41:42Z: transaction `GChCfQ8eUoKkVjT5oLgBkmkL754NyZqGWeSNwWCTXHxq`
(block 277253469), sent by the pool to itself, holds one DeployContract action of these bytes and no init call; the pool's code hash is
now `5DEnqxwBiVwsxuXNzYeE3a9P4DLYuSj2pjnQKvY88xyN`. Snapshots before and after read the same raw state and the same views, and a new lender
(`lp3.airlock-credit-c1108d.testnet`) was refused at 0.003 NEAR, charged 0.0025 NEAR of a 0.1025 NEAR deposit and freed its entries with a
full withdraw. docs/EVIDENCE.md (Pool redeploy with the storage fix), C27 and C28; `pnpm tsx scripts/credit-pool-code-check.ts --verify`
checks it with no keys.
