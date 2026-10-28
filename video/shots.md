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
