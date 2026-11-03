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

## Pre-lock takes (lane 2, 2026-11-03, second pass)

PRE-LOCK, DRAFT script. Pin: d08507307bce9a94f8bfef60478047447bed57eb (lane2 on main 3a77522 plus this lane's commits). Takes are `video/takes/<shot>-pre1.mp4` (1920x1080, 30 fps, H.264, gitignored) with a contact sheet `<shot>-pre1.png`; raw Playwright recordings are `video/raw/<shot>-pre1.webm`. Second pass for phone readability: browser pages at CSS zoom 1.7 to 2 with scripted slow pans, terminal at 30 px, at most 90 columns, screen cleared between commands. Terminal shots are real pty output replayed in xterm.js 5.5.0 (MIT) with waits between output chunks capped (S05 therefore replays about 4.5 minutes of real work in about 14 s). S03, S04 and S08 need the live run.

| shot | mode | status | file | duration s | command | what it shows | script cue | links shown |
| - | - | - | - | - | - | - | - | - |
| S01 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S01-pre1.mp4 | 17.7 | node scripts/video-capture-browser.mjs S01 | Giskard then OECD.AI public pages, no sign-in | S01a, S01b (0:00-0:10) | none |
| S02 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S02-pre1.mp4 | 17.1 | scripts/video-serve.mjs on :4180, then ZOOM=1.7 node scripts/video-capture-browser.mjs S02 | console /bench with slow pans over the V0 to MANDATE rows then A1 and A2; 69, 67, 68, 0 of 250 | S02a to S02d (0:10-0:25) | none |
| S05 | REPLAY | captured (pre-lock) | video/takes/S05-pre1.mp4 | 14.4 | video-term-record.py, then node scripts/video-term-replay.mjs S05 scripts/video-term-spec-S05.json | pnpm proven (PROVEN OK 15 of 15) and pnpm -C runtime attest (ATTEST VERIFIED, 21 ok lines); real output replayed at 30 px, waits cut | S05a to S05e (1:31-1:55) | none |
| S06 | BROWSER-SOURCE | captured (pre-lock) | video/takes/S06-pre1.mp4 | 20.0 | scripts/video-serve.mjs proxying /api/challenge to localhost:8788, then ZOOM=2 node scripts/video-capture-browser.mjs S06 | Steal this agent: counter sentence (47 attempts, 0 NEAR stolen), Latest attempts rows, Door two block | S06a to S06c (1:55-2:10) | truncated tx hash links in Latest attempts, unlabelled |
| S07 | TERMINAL | captured (pre-lock) | video/takes/S07-pre1.mp4 | 19.4 | node scripts/video-term-replay.mjs S07 scripts/video-term-spec-S07.json | pnpm try --text, pnpm i && pnpm demo --no-open --exit-when-ready, then a text title card (repo is private) | S07a to S07c (2:10-2:20) | none |

Notes: docs/video-script.md now matches the real output (SCREEN strings that exist, S05 as REPLAY with `recorded` captions, S07 with the flags used and a TITLE comment); `ATTEST VERIFIED` is printed by runtime/scripts/attest.ts, outside the paths the SCREEN check searches, so S05 has no SCREEN line for it. The 21 checks of caption S05e match the 21 ok lines. The console no longer ships a committed bench.json: `pnpm -C web gen:bench` writes it at build time and checks it against docs/BENCH.md. Hygiene: no user name, keys or env values on screen; the Door two secret key in S06 is the published function-call key of the challenge.
