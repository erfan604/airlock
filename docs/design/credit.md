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

Each mutant was applied alone and the library tests run (`cargo test --lib`, 327 tests including the unit tests of `src/roles.rs` and the
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
