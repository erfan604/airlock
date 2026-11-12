# Roadmap

Moved from the README. Each item answers one entry of the Not covered list of `docs/PROVEN.md`. None is built.

- Planner and reader models: run the benchmark on more models and with more runs per case; today it has three models, 10 runs per case on the cheap model and 5 on the other two.
- Labels the runtime attaches: extend the Lean model of the interpreter toward the TypeScript that ships, which today has a model and a property test.
- TEE: register the runtime in a TEE and link the registration transaction in `docs/EVIDENCE.md`; the runtime is in local mode, unattested.
- Chain and MPC signer: these stay trusted; the on chain evidence of each run stays re-checkable with `pnpm verify-approval` and `pnpm tsx scripts/verify-golden.ts`.

For the credit pool (`docs/UNDERWRITING.md`, `docs/design/credit.md`), none built: a fee that accrues with time instead of a fixed fee on what the card kept at repay (today a sweep before repay lowers the fee), removing the deployer's full-access key from the agent (the pool's and the credit card's were removed on 2026-11-12, `docs/KEYS.md`), and lenders who are not the team.

Continuous integration: `.github/workflows/quick-tier.yml` runs the T1 tier on every push to main (`pnpm i`, the replay demo, `scripts/claims-run.sh --tier node` and `pnpm proven:transcripts`, about a minute). The full gate needs Kani, Lean and the NEAR sandbox and took 2482 s on 2026-11-04 (`docs/EVIDENCE.md`), so it runs locally. `scripts/fresh-clone-check.sh` is the reproducible equivalent: it clones the repository, builds in empty directories and runs the gate. The record is the G5 fresh clone at commit a6f8c55 (`docs/EVIDENCE.md`, quick ALL GREEN and full ALL GREEN with the protocol 88 sandbox step skipped (label sandbox-p88), and `scripts/g5-check.sh` printed `G5 OK` there). It predates commit 4022a50, which added the browser e2e suites to the full gate; the full gate was run again with them at f1cd533 on 2026-11-04 and printed `ALL GREEN (full, skipped: sandbox-p88)` in 2482 s.
