# Hosted replay demo

Anyone can open one URL and see the console replay the recorded runs with no server, no key and no chain write. It is the same console as
`pnpm demo`, built as plain files. Every screen of the replay says `Replay of recorded run <name>`. Nothing in this document has been published:
publishing is outward facing and needs the owner's yes for the exact host and command.

## What is in it

| Page | Static copy |
| --- | --- |
| `/` | the overview: what AIRLOCK does, the doctored-amount case, the bench numbers from `bench.json`, how it works, what is and is not proven |
| `/try` | the playground: preset emails or your own, a stand-in agent (pattern matching, not a model), and the verdict crate compiled to `verdict.wasm`, run in the browser |
| `/replay` | the three recorded acts: invoice paid, correction held with the real approval card, the replayed approval, the tampered approve |
| `/bench` | the recorded bench results (`bench.json`) |
| `/proven` | the proven claims (`docs/proven.json`) |
| `/challenge` | says it needs the challenge service and lists the commands (`pnpm challenge`, `pnpm try`) |
| `/live` | says a live run needs a server, a model key and funded testnet accounts, and lists `pnpm demo`, `pnpm demo:live` |

The replay data is the answer of the replay server to each read the console makes, saved byte for byte at build time to `data/`. The console parses
those files with the functions it uses live. The trace is the server-sent event text, read by `replay/staticEventSource.ts`. No page signs, opens a
wallet or calls any other origin: the policy is `connect-src 'self'` and the e2e fails on any request to another host.

## Build and check

```
pnpm i
pnpm build:static            # web/dist-static, ends with STATIC EXPORT OK <n> files
pnpm -C web e2e static       # serves dist-static like a host, clip audit at 375 and 1440, prints E2E static OK
pnpm -C web preview:static   # look at it by hand on http://127.0.0.1:4180
```

The screenshots of the e2e are in `web/audit/static-*.png`. `pnpm build:static` needs only Node and pnpm. It reads `bench/golden`, `runtime/recordings/chain`
and `fixtures/world.jsonl`, so it shows what is committed.

The policy is in the page as a meta tag and, for hosts that read it, in `dist-static/_headers`: scripts from `'self'` only, no inline script, no
remote host, `'wasm-unsafe-eval'` so the Try page can compile its own `verdict.wasm` (WebAssembly only, no JavaScript eval), media from `'self'` through `default-src`, `frame-ancestors 'none'` in the header form. A host that ignores `_headers` (GitHub Pages) still enforces the meta tag.

## Publish to Cloudflare Pages (recommended)

Needs a Cloudflare account and `wrangler` login (`npx wrangler login`). One time:

```
npx wrangler pages project create airlock-demo --production-branch main
```

Each publish:

```
pnpm build:static && npx wrangler pages deploy web/dist-static --project-name airlock-demo --branch main
```

The URL is `https://airlock-demo.pages.dev`. `_headers` is honored, so the full policy applies. Cost: the free plan is enough. Static requests and
bandwidth are not metered, the limits are 500 builds per month (a direct upload counts none), 20,000 files and 25 MiB per file; this site is about 45 files and under 3 MB, half of it the two hero loops.
To take it down: `npx wrangler pages project delete airlock-demo`.

## Publish to GitHub Pages

This repository is private and must not be made public for this. Publish the built files to a separate public repository that holds nothing else.
GitHub Pages serves a project site under `/<repo>/`, so build with that base:

```
STATIC_BASE=/airlock-demo/ pnpm build:static
npx gh-pages -d web/dist-static --dotfiles -b gh-pages -r https://github.com/<owner>/airlock-demo.git
```

Then in that repository: Settings, Pages, Source `gh-pages` branch, folder `/ (root)`. The URL is `https://<owner>.github.io/airlock-demo/`. `404.html` and
the per-route `index.html` files are in the build, so `/airlock-demo/proven` works. Cost: free for a public repository (soft limits of 1 GB of site
and 100 GB of bandwidth per month). A private repository needs a paid GitHub plan for Pages. `_headers` is ignored, so only the meta tag policy applies.

## Keep it up

Rules Q-012 ask that the demo stays up until 2026-11-18, ideally 2026-11-25. Both hosts keep a deployment until it is deleted; no renewal is needed.
After any change to the recordings or the console, rebuild and publish again with the same command.
