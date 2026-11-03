# Video shots

Capture log of the public demo video. One row per `SHOT` of docs/video-script.md, filled by the capture sessions (AIR-249 for
the first shots, AIR-283 for the last ones). The takes go public, so nothing private may reach the screen: tick all six lines
below (`- [x] `) before the first take, and look at every contact sheet before the cut.

## Hygiene checklist

- [ ] A fresh Chrome profile with only the demo tabs open
- [ ] No bookmarks bar
- [ ] Notifications off
- [ ] A terminal prompt that shows no user or machine name, in a directory whose name shows neither
- [ ] `env` is never printed
- [ ] The wallet shows only the testnet demo account

## Status words

- `todo`: not captured yet
- `captured`: a take of the shot exists, recorded as its mode in the script says
- `fallback-replay`: the live take failed, so the take is the `pnpm demo` replay and the captions say replay or recorded
- `dropped`: the shot is not in the cut

## Shots

Columns: `shot` is the id of the script (`S01`), `mode` is the mode word of its `SHOT` line, `status` is one of the four words
above, `file` is the raw take `video/raw/<shot>-<take>.mov` (no spaces; `scripts/video-normalize.sh` writes
`video/norm/<shot>-<take>.mp4` from it), and `links shown` lists every explorer URL visible in the take (or `none`).

Pin lines: AIR-249 and AIR-283 each add one line directly above the table header, for the shots they capture from a pinned
build (AIR-249 Scope gives the form).

| shot | mode | status | file | links shown |
| - | - | - | - | - |

## Pre-lock takes (lane 2, 2026-11-03)

PRE-LOCK, DRAFT script. Pin: b3b9601abfa2bc5552cbe5c6ba2691bb20a029af (lane2 on main b3b9601), the console is built from that commit. Takes are `video/takes/<shot>-pre1.mp4` (1920x1080, 30 fps, H.264, gitignored) with a contact sheet `<shot>-pre1.png`; raw Playwright recordings are `video/raw/<shot>-pre1.webm`. Recorded without screen-recording permission: browser shots with Playwright recordVideo, terminal shots as real pty output replayed in xterm.js 5.5.0 (MIT) with waits between output chunks capped, so the text and its order are the real run. Re-run after the lock; S03, S04 and S08 need the live run.

| shot | mode | status | file | duration s | command | what it shows | script cue | links shown |
| - | - | - | - | - | - | - | - | - |
| S01 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S01-pre1.mp4 | 17.7 | node scripts/video-capture-browser.mjs S01 | Giskard then OECD.AI public pages, no sign-in | S01a, S01b (0:00-0:10) | none |
| S02 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S02-pre1.mp4 | 15.9 | scripts/video-serve.mjs on :4180 with BENCH_JSON from web-bench-json.ts, then video-capture-browser.mjs S02 | console /bench, numbers 69, 67, 68 and 0 of 250 match the caption | S02a to S02d (0:10-0:25) | none |
| S05 | TERMINAL | captured (pre-lock) | video/takes/S05-pre1.mp4 | 14.4 | video-term-record.py then video-term-replay.mjs S05 scripts/video-term-spec-S05.json | pnpm proven (PROVEN OK 15 of 15), pnpm -C runtime attest (ATTEST VERIFIED, 20 ok lines) | S05a to S05e (1:31-1:55) | none |
| S06 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S06-pre1.mp4 | 17.5 | scripts/video-serve.mjs proxying /api/challenge to localhost:8788, then video-capture-browser.mjs S06 | Steal this agent, live service state, 47 attempts, 0 NEAR stolen | S06a to S06c (1:55-2:10) | truncated tx hash links in Latest attempts, unlabelled |
| S07 | TERMINAL | captured (pre-lock) | video/takes/S07-pre1.mp4 | 19.4 | video-term-replay.mjs S07 scripts/video-term-spec-S07.json | pnpm try --text, pnpm i && pnpm demo --no-open --exit-when-ready, title card (repo is private, so the GitHub page is a text card) | S07a to S07c (2:10-2:20) | none |

Notes: the script's SCREEN strings KANI OK, LEANCHECKER OK and identical on do not appear in the real output of pnpm proven or attest (real lines are PROVEN OK 15 of 15, lean-matches-rust diff 40000, ATTEST VERIFIED); S05e says 21 checks, the run prints 20 ok lines. The committed web/public/bench.json is the old draft: the S02 take uses the page data regenerated from bench/results/latest.json. Hygiene: no user name, keys or env values on screen; the Door two secret key shown in S06 is the published function-call key of the challenge.
