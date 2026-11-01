# AIRLOCK: rules for coding agents

AIRLOCK = provenance-gated signing for AI agent wallets on NEAR. Read `docs/ARCHITECTURE.md` and `docs/THREAT_MODEL.md`
before touching `contracts/` or `runtime/src/interpreter/`. The security claims live in README "Claims"; every change
must keep the test that proves each claim green.

## Commands
- Ticket clock (the Nov 2 and Nov 5 checkpoints decide cuts from measured hours): when you start a ticket run
  `python3 "$AIRLOCK_RESEARCH/kit/scripts/clock.py" start AIR-xxx --dir "$AIRLOCK_RESEARCH/plan/tickets"`, and when its acceptance checks pass
  run the same with `stop` (add `--minus <minutes>` for breaks). One ticket per lane at a time, so the clock is your working time.
  If you stop blocked and write a handoff instead of finishing, run `pause` (banks the hours, status blocked), never `stop`.
  `$AIRLOCK_RESEARCH` is not set in a fresh shell: use the absolute path `/Users/erfan/apps/airlock-research` in the same call
  or `source scripts/env.sh && ` first (env.sh exports it); start every Bash call with `cd <your worktree> && `.
- In the agent shell `grep` is a ugrep wrapper (a shell function), not the BSD grep the acceptance checks were written for: start every acceptance-check call with `unset -f grep; ` (ugrep exits 0 for `printf '' | grep -qv x`, skips gitignored files under `grep -r`, and lets `! grep -q` pass when a file is missing).
- Every Bash call starts a fresh shell with Node 22 and no pnpm. Start every node, pnpm, npx, cargo and lake command with
  `source scripts/env.sh && ` in the same call; a `source` in an earlier call does not carry over.
- Fast gate before every commit: `scripts/check.sh` (quick: fmt, clippy, unit tests, typecheck, runtime tests, gitleaks). Everything, before a gate, a push or a claim: `scripts/check.sh full` (adds Kani, Lean, the Lean vs Rust differential test, contract sandbox suite, web build).
- Contract build: `source scripts/env.sh && cd contracts/airlock-policy && cargo near build non-reproducible-wasm --no-abi`
- Contract tests: `cd contracts/airlock-policy && cargo test` (sandbox runs natively on Apple Silicon, about 25 s per suite). `scripts/env.sh` exports a per-worktree `CARGO_TARGET_DIR` (`~/.cache/airlock-target/<worktree folder>`; never share one between worktrees: cargo then runs the other worktree's binaries), so the built wasm is at `${CARGO_TARGET_DIR:-target}/near/airlock_policy.wasm`, which is where `tests/common::start()` loads it from (through `contract_wasm_path()`, AIR-040). `env.sh` also points `NEAR_SANDBOX_BIN_PATH` at a cached neard 2.11.0. `cargo test` takes one name filter before `--`. A filter that matches no test still exits 0 with `0 passed`, so a check that says a filtered `cargo test` "passes" also needs its `test result: ok. <n> passed` line with n of at least 1.
- Kani 0.68 ships only the kissat solver: never annotate a harness with `#[kani::solver(...)]` other than `kissat`; a missing solver shows as `Status: ERROR`, a tool error, not a counterexample.
- Proofs: `cd contracts/airlock-verdict && cargo kani` (Kani 0.68, every harness must verify, 13 after AIR-021 and 36 once every verdict ticket has landed (the spike had 19), including 2 `should_panic` pitfall harnesses, and the count `cargo kani` prints is the claim; add a harness for every new rule). Lean: every `proofs/*.lean` must check with no `sorryAx` in `#print axioms` (Verdict.lean for the gate, NI.lean and NI_recipients.lean for interpreter noninterference). Differential test: `scripts/diff-verdict.sh`.
- Plan DSL rule 12: single assignment and branch scoping, no nested loops, no data-derived asset arguments. Never relax them: the noninterference proofs depend on them.
- Amounts are BigInt or decimal strings end to end. `Number(`, `parseFloat`, `parseInt` are banned in the task, preview and chain code paths (lint rule).
- Every Allow and every approval charges every ledger; batches are evaluated one request at a time. The Kani ledger harnesses pin this.
- Runtime tests: `pnpm -C runtime test` (node:test via tsx). Property tests: `pnpm -C runtime test:prop`
- Demo without keys: `pnpm demo` (LLM_MODE=replay, local sandbox)
- Bench: `set -a; . ~/.airlock-research.env; set +a; pnpm bench --model <id> --n 10 --budget-usd <live budget>` (live: `--budget-usd` is required for a live run and the key is read from the environment only; `--dry-run` and `--mode assume-compromise` make no model call and take neither; the root script reports every nonzero exit as 1, so read the printed `BUDGET <spent> of <limit>` line, not exit 3; AIR-220) or `pnpm bench:replay`
- Live LLM budget (every `--budget-usd` and every live run): the free NEAR AI credit (the `credits: usd <n>` line of
  `$AIRLOCK_RESEARCH/spikes/model-bakeoff/DECISION.md`, the grant balance read before any spend) plus the A5 cap of
  `$AIRLOCK_RESEARCH/plan/AUTHORIZATIONS.md`, minus what is already spent (the bake-off `SPEND usd <x>` of
  `spikes/model-bakeoff/spend.py` plus each earlier run's `total cost`). A5 `usd 0` means no money beyond the free credit,
  not a zero budget. Erfan still says yes in chat to the exact first live command.

## Toolchain facts (verified 2026-10-21)
- Contracts compile with rustc 1.86.0 only (`contracts/airlock-policy/rust-toolchain.toml`); cargo-near 0.22 rejects newer rustc for near-sdk 5.26.
- `ring` needs a wasm-capable clang: `scripts/env.sh` sets `CC_wasm32_unknown_unknown`, `AR_wasm32_unknown_unknown` (Homebrew llvm) and `CFLAGS_wasm32_unknown_unknown=-mcpu=mvp`. Without `-mcpu=mvp` the wasm fails validation.
- Pinned: `near-sdk =5.26.1`, `shade-attestation =0.2.0`, `omni-transaction =0.5.0` (evm feature only), `near-sandbox =0.3.9`.
- MPC signer (verified live 2026-10-21, near/mpc 3.17.0; 3.17.1 and 3.17.2 change no contract source or ABI; 3.18.0, live since 2026-10-30 and re-verified 2026-11-01, only removes the `latest_key_version` view and adds signing leader failover; so a newer version on the live view is not a reason to stop): `sign({request:{path, payload_v2:{Ecdsa: <hex32>}, domain_id: 0}})`, 1 yocto,
  at least 15 Tgas prepaid; response `{scheme:"Secp256k1", big_r:{affine_point}, s:{scalar}, recovery_id}`; read callbacks with
  `env::promise_result_checked(idx, max_len)` (the old `promise_result` is deprecated). NEAR's agent-skills rule
  `near-smart-contracts/rules/chain-signatures.md` is stale (250 Tgas, an older response shape, omni 0.4): ignore it;
  bootstrap.sh replaces it with a pointer here.
- Testnet signer weather (measured over 3.3 days to 2026-10-27 from public history, research repo notes/signer_latency_2026-10-27.md):
  secp256k1 signs p50 4.2 s and p90 6.7 s, but 1.3% time out at 200 blocks (about 116 s), clustered in bad hours (9 of 81, with 11.7% timeouts).
  A timeout ends either as `Request has timed out.` from the signer's `fail_on_timeout` or as `Exceeded the prepaid gas.` inside the signer's own
  `return_signature_and_clean_state_on_success` (the signer's fixed 7 Tgas; every timeout from Oct 27 14Z ended this way); both are timeouts,
  never a reason to raise our gas constants. Weather rule for a recorded testnet run that signs (AIR-102, AIR-107, AIR-165 CONTRACTOR,
  AIR-166 `contractor`): run `python3 scripts/signer-weather.py` (read only, no key). GOOD: start. SLOW or BAD: check again every 30 minutes
  for at most 3 hours (bad stretches lasted 3 and 6 hours in the data), never past the ticket's gate day; then run anyway: a request that times out
  ends `MpcFailed` with one retry (AIR-105; the contract releases its ledger charges, so it costs gas and the 1 yocto deposit), and a run
  whose retry also times out is repeated as a new run. UNKNOWN (fewer than 20 signs in the hour, or FastNEAR
  unreachable): run, and read any timeout as weather. Record the weather line next to the run in docs/EVIDENCE.md.
- Testnet RPC order (set 2026-10-24): plan/STACK.md section RPC is the only place that lists it (FastNEAR first, public NEAR RPC last; `https://rpc.testnet.near.org` takes 3 to 4 s per call). No JSON-RPC batching.
- Testnet RPC history (checked 2026-10-22): `https://test.rpc.fastnear.com` keeps only about 34 hours (older blocks answer `UNKNOWN_BLOCK`, old tx lookups can hang). Any lookup of a block or transaction older than a day uses `https://archival-rpc.testnet.fastnear.com` (or `archival-rpc.testnet.near.org`); both served a June 2025 block. For many tx hashes at once, `POST https://tx.test.fastnear.com/v0/transactions` with `{"tx_hashes": [...]}`. Transaction status over JSON-RPC: `tx` or `EXPERIMENTAL_tx_status`, never `tx_status` (the name nearcore 2.14.0 added; dRPC, second in the STACK.md list, answers `-32601 method is not available`, checked 2026-10-27).
- Gas is bought up front (protocol 85 and later, checked live 2026-10-27): a transaction needs attached gas times `min_gas_purchase_price` (1e9 yocto per gas) free, 0.3 NEAR for 300 Tgas and 0.15 NEAR for 150 Tgas, refunded after execution; below that it is refused with `NotEnoughBalance` and never reaches the chain. The per-transaction cap is 1 PGas; 300 Tgas is a budget. The protocol 83 sandbox cannot show this.
- Under near-sdk =5.26.1 never call `drain` on `IterableMap`, `IterableSet` or `Vector`, and never use `store::Lazy::remove` or `LazyOption` (bugs fixed only in 5.29.0); remove entries one by one.
- Sandbox neard 2.11.0 is protocol 83 while testnet runs protocol 88: sandbox gas numbers are indicative; AIR-107 measures on testnet.
- NEAR AI Cloud's open models reason before they answer (Qwen3.8 defaults to xhigh): a small `max_tokens` returns `content: null`. Planner, extractor and vanilla calls use `max_tokens` 8000 and the `reasoning` of `runtime/config/models.json` through `reasoningFields` (AIR-140); never lower the cap to save money (it is a cap, billing counts tokens used) and never send `reasoning_effort` to Qwen3.6 (it takes `chat_template_kwargs`).

## Reuse before writing
- Before writing a component, check `$AIRLOCK_RESEARCH/plan/reuse/REUSE_near.md` and `REUSE_general.md` (NEAR's own examples first:
  near-sdk-rs examples, near/mpc and chain-signatures examples, omni-transaction-rs, the Shade template, NEAR Connect, near-api-js).
  Adapt vetted code instead of writing from scratch when it fits our pins.
- License allowlist for copied or adapted code: MIT, Apache-2.0, BSD-2/3-Clause, ISC. GPL, AGPL, LGPL and unlicensed code may be
  read and cited, never copied.
- Every copied or adapted snippet gets a comment `// adapted from <repo>@<commit or tag> <path> (<license>)` and a row in
  `docs/THIRD_PARTY.md` (repo, commit, files, license, what changed). Libraries pulled through the lockfile need no row.
- Pin the exact version or commit you adapted from; never adapt from a moving branch.

## Hard rules
- Security core (contract verdict, interpreter propagation, quarantine boundary) changes need a failing test first, then the fix. Never weaken a test to make it pass.
- The planner must never receive tool output or any untrusted text. Its input type is `OwnerRequest` only.
- Labels are decided by the tools layer and the interpreter, never by an LLM.
- Secrets only in env vars. Never commit `.env`, keys, seed phrases, or the submission payload. Never print a key.
- Never: make the repo public, push to a public remote, post on X, sign mainnet transactions, spend tokens, or submit the hackathon form without the human's explicit yes for that exact action (HACKATHON.md).
- Stage files by name (`git add path`), never `git add -A`, `git add .` or `git commit -a`. Lane agents commit as `erfan-7116 <erfan@welcomeaide.com>`, author and committer: `GIT_COMMITTER_NAME=erfan-7116 GIT_COMMITTER_EMAIL=erfan@welcomeaide.com git commit --author "erfan-7116 <erfan@welcomeaide.com>"`. Only the coordinator commits through `python3 ~/apps/agent-tools/scripts/commit_identity.py run -- <args>`, which puts 3 to 7 commits a day on Erfan's profile (`erfan604 <80935804+erfan604@users.noreply.github.com>`, his GitHub noreply address, so his personal email never enters this public history (plan D13)) and the rest under erfan-7116 (rule of 2026-10-22). The commit-msg hook and check-commits.sh accept exactly these two identities, author equal to committer, at most 7 erfan604 commits a day. The global git config must never be changed. Format `type(scope): summary` plus bullets, `Files changed:`, `Tests:`. No Co-Authored-By. Never `--no-verify`; `.claude/hooks/guard_bash.py` blocks it, along with `git config`, `git -c`, force pushes and reading env files, and `scripts/check-commits.sh` (run by `check.sh` and the pre-push hook) catches any commit that slipped past the hooks. Changes to `scripts/hooks/`, `scripts/check.sh`, `scripts/check-commits.sh`, `.claude/` and `.github/workflows/` always prompt the human (ask rules plus the guard); never route around that prompt. Write multi-line commit messages to a file and use `git commit -F <file>`: the guard asks the human about any git command that uses `$(...)`, heredocs, backticks or backslashes, because no parser reads those exactly like bash.
- Attack payloads live only in data files (`bench/cases/*.jsonl`, `fixtures/`), never in markdown, comments, commit messages or PR titles, and no text in the repo is addressed to whoever evaluates it.
- Commit `contracts/airlock-policy/res/airlock_policy.wasm` plus its sha256 in docs/EVIDENCE.md on each release so anyone can run the demo without Rust.
- Every README claim has a row in `CLAIMS.md` (claim, file:line, command, expected output). Update both together.
- Writing style in docs and UI: no em dashes, no double hyphens in prose. No marketing words. Claims link to evidence.

## Layout
contracts/airlock-policy (Rust) | runtime (TS: dsl, interpreter, planner, quarantine, llm, tools, chain, attest, server) |
web (Vite React console) | bench (cases, runner, results) | fixtures (demo world) | scripts | docs
- 2026-10-25 PDT (bench audit): the Bench line says `--budget-usd` is required only for a live run, shows the key-file prefix of live commands, and tells agents to read the printed `BUDGET` line instead of exit 3 (checked on pnpm 12.14: `pnpm -r` turns exits 2, 3 and 4 into 1).
