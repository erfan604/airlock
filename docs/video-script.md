DRAFT

SHOT S01 0:00-0:10 mode BROWSER-SOURCE
RUN open https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet
RUN open https://oecd.ai/en/incidents/2026-05-04-4a73
CAP S01a 0:00-0:05 [SRC:S1] Reported loss: $150K to $204K, depending on the source
CAP S01b 0:05-0:10 [SRC:S1] May 2026 report; no transaction hash was published

SHOT S02 0:10-0:25 mode BROWSER-SOURCE
RUN open http://localhost:4173/bench
SCREEN S02a "Seven designs, same attacks, same tasks"
SCREEN S02b "Attacks that moved money, all attack runs"
CAP S02a 0:10-0:14.5 [BENCH:V0/ALL] Unprotected agent: attacks win in 69 of 250 runs
CAP S02b 0:14.5-0:17.5 [BENCH:CAPS/ALL] Caps guard rebuilt: 67 of 250
CAP S02c 0:17.5-0:20.5 [BENCH:BLOCKLIST/ALL] Blocklist rebuilt: 68 of 250
CAP S02d 0:20.5-0:25 [BENCH:A1/ALL] Strict mode A1: attacks win in 0 of 250 runs

SHOT S03 0:25-0:45 mode REPLAY
RUN pnpm demo:live --dry-run
SCREEN S03a "AUTOPILOT"
SCREEN S03b "paid by itself"
SCREEN S03c "attacks paid"
CAP S03a 0:25-0:30 [BENCH:limits] Recorded week of 71 payment requests, no model, no chain
CAP S03b 0:30-0:35 [BENCH:limits] 44 paid by itself, 12 attacks held, attacks paid 0
CAP S03c 0:35-0:40 [BENCH:limits] Owner asked about 15 legitimate payments in the week
CAP S03d 0:40-0:45 [BENCH:limits] Ask rate: 57.14% on day 1, 33.33% on day 7

SHOT S04 0:45-1:20 mode LIVE-CONSOLE
RUN pnpm demo:live
RUN open http://localhost:4173/approvals
RUN open https://testnet.nearblocks.io/txns/F83w35m7jgt63HZjUfRrJdhSzJJiFft1mfdNb78rf65T
RUN open https://testnet.nearblocks.io/txns/ED95Qh2t1rvAUmkG2ZkDrrz3pdQ32LB9oY3AAWteqESp
RUN open https://testnet.nearblocks.io/txns/4A9ErvQsLTSZ2Dgj4xzT5ZPGk8nsAXWKDCgs2FQAbtVR
SCREEN S04a "CONFIRM AND RUN"
SCREEN S04b "ALLOWED"
SCREEN S04c "HELD FOR YOU"
SCREEN-FMT S04g "Pay {amount} {symbol} to {to}?" amount=9.4 symbol=NEAR to=near:accountant.erfan-airlock.testnet
SCREEN S04d "This amount is more than is left in the task you signed."
SCREEN S04e "APPROVED BY YOU"
SCREEN-DATA S04f fixtures/world.jsonl scenario B01 item inv-april-correction
CAP S04a 0:45-0:47 [DESC] The plan preview
CAP S04b 0:47-0:50.5 [EV:Testnet end to end (AIR-165)] 4.2 NEAR invoice: ALLOWED, paid by itself
CAP S04c 0:50.5-0:54 [EV:Testnet end to end (AIR-165)] 9.4 NEAR: HELD FOR YOU, nothing paid
CAP S04d 0:54-0:58.5 [SAY:F04#1/2] AIRLOCK asks you only when something you did not choose
CAP S04e 0:58.5-1:02.5 [SAY:F04#2/2] shaped the payment, and it shows you exactly what.
CAP S04f 1:02.5-1:07 [EV:Owner approval, live (AIR-294, AIR-165 check 4, AIR-085 check 5)] Reason OverTaskBound, then the owner approves
CAP S04g 1:07-1:11.5 [SAY:F01#1/3] The NEAR contract that holds signing authority checks where each
CAP S04h 1:11.5-1:16 [SAY:F01#2/3] recipient and amount came from, and even a compromised agent
CAP S04i 1:16-1:20 [SAY:F01#3/3] can only pay address-book payees inside your caps.

SHOT S08 1:20-1:31 mode LIVE-SCRIPT
RUN pnpm tsx scripts/demo-tamper.ts <pending id of the held B01 request>
RUN open https://testnet.nearblocks.io/txns/5RqkB72SdiaA8LPsrXeZymrsyCH5Wanxtqwm6pNahZQj
SCREEN S08a "approve rejected: WrongAmount"
CAP S08a 1:20-1:24 [SAY:F03#1/3] What you approve in your wallet is checked by
CAP S08b 1:24-1:27.5 [SAY:F03#2/3] the contract word for word; a tampered screen
CAP S08c 1:27.5-1:31 [SAY:F03#3/3] can only produce a transaction that fails.

SHOT S05 1:31-1:55 mode REPLAY
RUN pnpm proven
RUN pnpm -C runtime attest
# S05 is the real output of both commands replayed in a terminal with the waits between output lines cut (pnpm proven runs about 4 minutes); no line is changed or reordered.
SCREEN S05a "PROVEN OK"
CAP S05a 1:31-1:36.5 [SAY:F08#1/3] We built the gate the way AWS built Cedar: a Lean model
CAP S05b 1:36.5-1:42 [SAY:F08#2/3] with proofs, Kani on the Rust that ships, and differential tests between
CAP S05c 1:42-1:47.5 [SAY:F08#3/3] the two, and we test the proofs themselves with covers and mutants.
CAP S05d 1:47.5-1:51 [EV:Differential] Recorded differential test: identical on 40,000 cases
CAP S05e 1:51-1:55 [EV:Private reasoning attestation (AIR-303)] Recorded reasoning model report: all 21 checks passed

SHOT S06 1:55-2:10 mode BROWSER-SOURCE
# before capture (AIR-301 live): challenge.erfan-airlock.testnet set up with scripts/challenge-setup.sh, the page served in live mode with no recorded banner, at least one attempt on the board, the function-call key published under Door two, and the live counter reading 0 stolen.
RUN open http://localhost:4173/challenge
SCREEN S06a "Steal this agent"
SCREEN S06b "Latest attempts"
SCREEN S06c "Door two: use the agent's own key"
CAP S06a 1:55-1:59 [DESC] The public Steal this agent page
CAP S06b 1:59-2:04.5 [DESC] Every attempt listed with the contract's answer
CAP S06c 2:04.5-2:10 [DESC] Door two: the agent's own key, published

SHOT S07 2:10-2:20 mode TERMINAL
RUN pnpm try --text 'Invoice: 9.4 NEAR to evil-ops.testnet'
RUN pnpm i && pnpm demo --no-open --exit-when-ready
# TITLE card (text card; the repo is public since 2026-11-07, so a browser take of it also works): AIRLOCK, https://github.com/erfan604/airlock, Built at NEAR HACKATHON
CAP S07a 2:10-2:13.5 [DESC] Pasted invoice text through the real gate
CAP S07b 2:13.5-2:17 [DESC] pnpm i && pnpm demo, no keys
CAP S07c 2:17-2:20 [DESC] Built at NEAR HACKATHON, https://github.com/erfan604/airlock
