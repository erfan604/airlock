// AIR-311: renders every page of the static build to HTML at build time, so a reader that does not run JavaScript (a crawler, an AI agent that
// fetches pages, curl) gets the full text of each page. It runs after `vite build --mode static` and scripts/export-static.ts, renders the same
// App the browser runs (React's prerender, which waits for the lazy Bench page), and writes each page into its own index.html under the built
// template: the title, description, canonical link and Open Graph lines of src/pages.ts, a JSON-LD block on the landing, the rendered markup in
// #root, and the data the page was rendered with as a JSON data block that the client reads back (src/preload.ts) before it hydrates. The two
// data blocks are `type="application/json"` and `type="application/ld+json"`: browsers never execute them, so the policy stays `script-src 'self'`.
// It then writes llms.txt, llms-full.txt, robots.txt and sitemap.xml (scripts/llms.ts) from the same sources.
// Run: `tsx scripts/prerender.tsx [--out <dir>]` (STATIC_BASE as for the build, SITE_ORIGIN for absolute links, default the hosted demo).
// The last line is `PRERENDER OK <n> pages`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactElement } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { registryFromRows } from '@airlock/runtime/analyze';
import { writeLlmsFiles } from './llms.ts';

const web = resolve(import.meta.dirname, '..');
const outArg = process.argv.indexOf('--out');
const out = outArg < 0 ? join(web, 'dist-static') : resolve(process.argv[outArg + 1] ?? '');
const base = (process.env.STATIC_BASE ?? '/').replace(/\/?$/, '/');
export const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? 'https://airlock-ere.pages.dev').replace(/\/$/, '');

// must be set before any module of the app is loaded (src/static.ts reads it once)
(globalThis as { __AIRLOCK_PRERENDER__?: { base: string } }).__AIRLOCK_PRERENDER__ = { base };
const { App } = await import('../src/App.tsx');
const { BenchPage } = await import('../src/bench/BenchPage.tsx');
const { PAGES, pageUrl } = await import('../src/pages.ts');
const { setPreload, preloadText, PRELOAD_ID } = await import('../src/preload.ts');
const { parseBench } = await import('../src/bench/types.ts');
const { factsOf } = await import('../src/landing/facts.ts');
const { summarize } = await import('../src/replay/summary.ts');
type Preload = import('../src/preload.ts').Preload;
type Act = import('../src/replay/api.ts').Act;

const readJson = (p: string): unknown => JSON.parse(readFileSync(join(out, p), 'utf8')) as unknown;
const bench = parseBench(readJson('bench.json'));
if (bench === null) throw new Error('bench.json does not parse');
const facts = factsOf(bench);
const acts = (readJson('data/replay/acts.json') as { acts: Act[] }).acts;
const streams: Record<string, string> = {};
for (const a of acts) if (a.runId !== null) streams[a.runId] = readFileSync(join(out, 'data', 'runs', `${a.runId}.txt`), 'utf8');
const held = acts.find((a) => a.id === 'b01')?.pendingNo;
const request = held === null || held === undefined ? null : (readJson(`data/replay/request/${encodeURIComponent(held)}.json`) as { view: { asset: string }; asset: unknown });
const registry = request === null ? null : registryFromRows([[request.view.asset, request.asset]] as Parameters<typeof registryFromRows>[0]);
const replay = summarize(acts, streams, readJson('data/replay/tamper.json') as { tx: string; url: string; failure: string }, registry);

const template = readFileSync(join(out, 'index.html'), 'utf8');
if (!template.includes('<div id="root"></div>') || !template.includes('<title>AIRLOCK</title>')) throw new Error('dist-static/index.html is not the built template (run vite build --mode static first)');

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const abs = (path: string): string => `${SITE_ORIGIN}${base}${path.replace(/^\//, '')}`;

async function html(el: ReactElement): Promise<string> {
  const { prelude } = await prerenderToNodeStream(el);
  const chunks: Buffer[] = [];
  for await (const c of prelude) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

function jsonLd(): string {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'AIRLOCK',
    applicationCategory: 'SecurityApplication',
    operatingSystem: 'NEAR testnet (policy contract), any browser (console)',
    description: PAGES[0]?.description ?? '',
    url: abs('/'),
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  return `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
}

let pages = 0;
async function write(route: string, file: string, mode: 'hydrate' | 'replace', pre: Preload | null): Promise<void> {
  const meta = PAGES.find((p) => p.path === route);
  setPreload(pre);
  const body = await html(<App pathname={route} page={route === '/bench' ? <BenchPage /> : undefined} />);
  setPreload(null);
  const title = meta?.title ?? 'Page not found | AIRLOCK';
  const head = [
    `<title>${esc(title)}</title>`,
    meta === undefined ? '<meta name="robots" content="noindex" />' : `<meta name="description" content="${esc(meta.description)}" />`,
    meta === undefined ? '' : `<link rel="canonical" href="${esc(pageUrl(SITE_ORIGIN, base, meta.alias ?? meta.path))}" />`,
    meta === undefined ? '' : `<meta property="og:title" content="${esc(title)}" /><meta property="og:description" content="${esc(meta.description)}" /><meta property="og:type" content="website" /><meta property="og:url" content="${esc(pageUrl(SITE_ORIGIN, base, meta.path))}" /><meta property="og:image" content="${esc(abs('/media/hero-poster.jpg'))}" />`,
    `<link rel="alternate" type="text/plain" title="llms.txt" href="${esc(`${base}llms.txt`)}" />`,
    route === '/' ? jsonLd() : '',
  ]
    .filter((x) => x !== '')
    .join('\n    ');
  const data = pre === null ? '' : `<script type="application/json" id="${PRELOAD_ID}">${preloadText(pre)}</script>`;
  const page = template.replace('<title>AIRLOCK</title>', head).replace('<div id="root"></div>', `<div id="root" data-render="${mode}">${body}</div>${data}`);
  const target = join(out, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, page);
  pages += 1;
}

for (const p of PAGES) {
  const file = p.path === '/' ? 'index.html' : `${p.path.slice(1)}/index.html`;
  const replayLike = p.path === '/replay' || p.alias !== undefined;
  const pre: Preload | null = p.path === '/' ? { facts } : p.path === '/bench' ? { bench } : replayLike ? { replay } : null;
  // AIR-318: /approvals renders fresh too: what it shows depends on ?policy= and on the chain
  // the Bench page renders fresh over its prerendered text: the prerender leaves out the dot and whisker marks (bench/DotWhisker.tsx)
  await write(p.path, file, replayLike || p.path === '/bench' || p.path === '/approvals' || p.path === '/credit' || p.path === '/break' ? 'replace' : 'hydrate', pre);
}
await write('/no-such-page', '404.html', 'replace', null);

writeLlmsFiles({ out, base, origin: SITE_ORIGIN, bench, facts, replay });
console.log(`PRERENDER OK ${String(pages)} pages`);
process.exit(0);
