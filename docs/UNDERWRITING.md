# Underwriting: a lender's worst case

A short, plain account of what a lender in the AIRLOCK pool can lose, written against the code and the testnet runs. Tags such as [C3b] name rows of `docs/CLAIMS.md`. Everything here is NEAR testnet, and every lender, borrower, merchant and issuer in the recorded runs is one of the team's own accounts.

## How the money moves

Lenders deposit NEAR in the pool (`contracts/airlock-credit`). The issuer opens a credit line for a borrower, who first posts collateral (30 percent of the line by default, `DEFAULT_COLLATERAL_BPS` at `contracts/airlock-credit/src/lib.rs:23`). The line funds a card: an AIRLOCK policy contract that the issuer owns, with the borrower as its approver and the pool as its sponsor [C21]. The borrower's agent spends from the card by sending requests to the card's `submit_batch`; the card's verdict allows, holds for the owner, or blocks each one [C5]. The borrower repays what the card kept plus the fee, or after the due date anyone can call `default` [C19].

## What a hijacked agent can move

- To an account outside the issuer's book: nothing on its own. A lying runtime can pay only inside an open task, to book payees, within limits [C3b]. The live run held a payee injected through untrusted text, and the borrower's approve of a payment to his own account reverted on chain [C19].
- A doctored amount to a booked merchant: on the live card it is held for the owner at any size, because the card runs strict mode since 2026-11-10T07:14:52Z [C22]. In the bench, strict mode paid 0 of 250 attack runs and default mode paid 10 of 250, each a doctored amount to a booked payee inside that payee's cap [C6].
- Inside strict mode's assumption: strict mode trusts the runtime's labels. A compromised runtime that labels a doctored amount as the owner's is bounded by the signed task and the booked payee's daily limit, not by strict mode [C22].
- Its own agent account's NEAR: the agent's function-call key cannot attach a deposit, but the agent account also holds a full-access key held by the team (`docs/KEYS.md`). That key reaches the agent account, not the card's or the pool's balance.

## What a held payment can still become

- The borrower is the card's approver and controls the agent. He may approve a held payment whose payee is in the book at the current epoch, so a held doctored amount to a booked merchant is paid if he approves it, within the live limits at approval time [C21].
- The issuer may approve a held payment to a payee that is not in the book (the override of `contracts/airlock-policy/src/roles.rs`); the borrower cannot [C21]. A lender trusts the issuer with this.

## What collateral covers

- After the due date, `default` seizes the collateral against what is owed, principal first, then the fee, returns any rest to the borrower, and books what is still owed as a loss (`default` in `contracts/airlock-credit/src/lib.rs`). On testnet a 1 NEAR line with 0.3 NEAR collateral defaulted, the 0.3 NEAR was seized and 0.7 NEAR was booked as a loss [C19].
- A sweep of the paused card returns what the card still holds; after a default it is credited as a recovery of the loss. On testnet the sweep recovered the 0.7 NEAR loss [C19].
- While a line is past due or a loss is unrecovered, the pool refuses deposits, and a past-due line counts as 0 in the share price before anyone calls `default` [C20].

## What is not covered

- Money spent at a booked merchant and not repaid, beyond the collateral: that loss falls on the lenders. There is no insurance and no credit scoring.
- A merchant who colludes with the borrower: a booked merchant can send money back off chain. The issuer books the merchants, so this is issuer risk.
- The issuer: it picks the borrowers, the limits, the fees, the due dates and the collateral ratio, owns the card policy and can write off a loss.
- The deployer: the pool and the credit card hold no access key since 2026-11-12, so their code cannot be redeployed and a bug in it cannot be fixed; the agent account keeps a full-access key (`docs/KEYS.md`).
- The proofs: the Lean theorems and Kani harnesses cover the gate (the verdict function), not the pool. The pool's rules rest on unit, property and sandbox tests [C20].
- The fee: it is charged on what the card kept at repay, so a sweep before repay lowers the fee the lenders earn.

## Leaving the pool

On this pool a lender can withdraw 60 seconds after a deposit (`min_hold_ms` 60000 at initialisation; the default is 24 hours), at the current share price, up to the pool's idle liquidity: NEAR lent out to an open line cannot be withdrawn until it comes back (`withdraw` in `contracts/airlock-credit/src/lib.rs`).

More: `docs/design/credit.md` (the pool's design and its mutation check), `docs/KNOWN_LIMITATIONS.md` (AIRLOCK Credit), `docs/EVIDENCE.md` (AIRLOCK Credit, and Credit card strict mode).
