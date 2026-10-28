LOCKED 2026-11-10

SHOT S01 0:00-0:10 mode BROWSER-SOURCE
RUN open https://example.org/fixture-loss-report
CAP S01a 0:01-0:06 [SRC:S1] reported loss, $150K to $204K, depending on the source
CAP S01b 0:06-0:10 [SRC:S2] four multisig failures cost about $2.0 billion

SHOT S02 0:10-0:25 mode TERMINAL
RUN open docs/BENCH.md
CAP S02a 0:10-0:14 [BENCH:V1-tight/ALL] capped baseline: 2 of 10 attack runs succeed
CAP S02b 0:14-0:18 [BENCH:V1-tight/benign] capped baseline pays 6 of 10 real invoices
CAP S02c 0:18-0:22 [BENCH:limits] V1 limit 50 NEAR, V1-tight limit 5 NEAR
CAP S02d 0:22-0:25 [BENCH:meta] n is 10 for every row

SHOT S03 0:25-0:50 mode EXPLORER
RUN open https://testnet.nearblocks.io/txns/FixtureTwinTxHashAAAAAAAAAAAAAAAAAAAAAAAA
CAP S03a 0:26-0:31 [GOLDEN:twin] vanilla agent, run 2 of 3: paid 9.4 NEAR
CAP S03b 0:32-0:37 [GOLDEN:twin] the correction, not the 4.2 NEAR invoice

SHOT S04 0:50-1:25 mode LIVE-CONSOLE
RUN pnpm demo:live
SCREEN S04a "Fixture plan preview"
SCREEN S04e "Fixture stamp one"
SCREEN S04f "Fixture stamp two"
SCREEN S04g "Fixture reason sentence for the held request."
SCREEN S04i "Fixture contract event line"
SCREEN-FMT S04h "Fixture pays {amount} {symbol} to {to}?" amount=9.4 symbol=NEAR to=near:accountant.fixture.testnet
SCREEN-DATA S04d fixtures/world.jsonl scenario B01 item inv-fixture-correction
CAP S04a 0:51-0:55 [DESC] Plan preview then fixture confirm button
CAP S04b 0:55-1:00 [SAY:F01#1/3] The NEAR contract that holds signing authority checks where each
CAP S04c 1:00-1:05 [SAY:F01#2/3] recipient and amount came from, and even a compromised agent
CAP S04d 1:05-1:09 [SAY:F01#3/3] can only pay address-book payees inside your caps.
CAP S04e 1:10-1:14 [DESC] Fixture stamp one on the April invoice
CAP S04f 1:15-1:19 [DESC] Fixture card held for the correction
CAP S04g 1:20-1:24 [DESC] Fixture reason sentence under the card

SHOT S08 1:25-1:31 mode REPLAY
RUN pnpm demo --no-open
CAP S08a 1:26-1:30 [DESC] recorded tamper attempt, reverted by contract

SHOT S05 1:31-1:57 mode TERMINAL
RUN scripts/kani-check.sh
CAP S05a 1:32-1:38 [SAY:F08#1/3] We built the gate the way AWS built Cedar: a Lean model
CAP S05b 1:38-1:44 [SAY:F08#2/3] with proofs, Kani on the Rust that ships, and differential tests between
CAP S05c 1:44-1:50 [SAY:F08#3/3] the two, and we test the proofs themselves with covers and mutants.
CAP S05d 1:51-1:55 [EV:Harness counts] KANI OK: 36 harnesses

SHOT S06 1:57-2:15 mode BROWSER-SOURCE
RUN open docs/BENCH.md
CAP S06a 1:58-2:04 [SAY:F11] Receipts include the model provider's signed response, evidence a verifier can check.
CAP S06b 2:05-2:10 [BENCH:V1/ALL] attack success 6 of 10 runs

SHOT S07 2:15-2:25 mode TITLE
RUN pnpm i && pnpm demo
RUN open https://github.com/fixture-owner/fixture-repo
CAP S07a 2:16-2:20 [DESC] pnpm i && pnpm demo
CAP S07b 2:20-2:24 [DESC] Built at NEAR HACKATHON
