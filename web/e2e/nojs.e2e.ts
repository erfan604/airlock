// AIR-311: the static site as a reader that runs no JavaScript sees it (a crawler, an AI agent that fetches pages, curl). Every page is fetched
// with the request context, not a page, so no script runs; the raw HTML must carry the page's title, description and canonical link, its
// headings and its numbers as text, the Try page's presets with their expected verdicts, the replay's acts with their transactions, and the
// machine files (llms.txt, llms-full.txt, robots.txt, sitemap.xml) must be there and say the same things. Run: pnpm build:static && pnpm -C web e2e nojs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from '../src/pages.ts';
import { HIRED, WORLD } from '../src/try/model.ts';
import type { E2E } from './types.ts';

const web = fileURLToPath(new URL('../', import.meta.url));
const golden = (name: string): { txs: { hash: string }[] } => JSON.parse(readFileSync(join(web, '..', 'bench', 'golden', `${name}.json`), 'utf8')) as { txs: { hash: string }[] };

/** The visible text of an HTML document: script and style bodies dropped, tags removed, entities of the five kinds decoded, spaces folded. */
export function textOf(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const run: E2E = async ({ page, baseUrl }) => {
  const get = async (path: string): Promise<{ status: number; body: string; type: string }> => {
    const r = await page.request.get(`${baseUrl}${path}`);
    return { status: r.status(), body: await r.text(), type: r.headers()['content-type'] ?? '' };
  };

  // every page: its own title, description, canonical, landmarks and an h1, with the text in the HTML
  for (const p of PAGES) {
    const r = await get(p.path === '/' ? '/' : `${p.path}/`);
    assert.equal(r.status, 200, p.path);
    assert.ok(r.body.includes(`<title>${p.title.replace(/&/g, '&amp;')}</title>`), `${p.path} title`);
    assert.ok(r.body.includes('<meta name="description"'), `${p.path} description`);
    assert.ok(r.body.includes(`<link rel="canonical" href="`), `${p.path} canonical`);
    assert.ok(/<link rel="canonical" href="[^"]*\/"/.test(r.body), `${p.path} canonical is in the slash form`);
    for (const tag of ['<header', '<nav', '<main', '<h1']) assert.ok(r.body.includes(tag), `${p.path} ${tag}`);
    assert.ok(textOf(r.body).length > 400, `${p.path} has text without JavaScript (${String(textOf(r.body).length)} characters)`);
  }

  // the landing: the claim, the numbers next to their labels, the case, JSON-LD
  const home = await get('/');
  const t = textOf(home.body);
  for (const s of [
    'A lending pool for AI agents on NEAR',
    'Credit for AI agents that cannot be talked out of the money.',
    'Three things to do in under a minute',
    'Lend 1 NEAR to the agents',
    'Send a real attack',
    'Take one rule out of the gate',
    'Recorded Nov 10, 2026.',
    'How the pool lends',
    'Same payee, new amount',
    '68 of 69 attacks that worked on an agent with no guard paid a payee already in the owner',
    '0 of 250 attack runs moved money with AIRLOCK in strict mode.',
    '10 of 250 attack runs moved money in default mode, all 10 in one case',
    '44 of 70 honest payment tasks went through in default mode with no tap from you.',
    'How it works',
    'What is proven, and what is not',
  ])
    assert.ok(t.includes(s), `landing text: ${s}`);
  assert.ok(home.body.includes('<script type="application/ld+json">') && home.body.includes('"@type":"SoftwareApplication"'), 'JSON-LD');
  assert.ok(home.body.includes('alt="') || t.includes('a vault door marked AIRLOCK'), 'the hero loop is described');
  assert.ok(t.includes('junction box engraved AIRLOCK'), 'the How it works band is described in text');

  // the Try page: the steps, every preset of both worlds with its expected verdict in the at-a-glance table, the engine named
  const tr = textOf((await get('/try/')).body);
  for (const s of ['Try to trick it', 'Pick a scam', 'What the agent would pay', 'What AIRLOCK decides', 'Your agent would pay Kano Cotton $1,800.00', 'All five emails at a glance', 'a stand-in, not a model']) assert.ok(tr.includes(s), `try text: ${s}`);
  for (const p of WORLD.presets) assert.ok(tr.includes(p.title) && tr.includes(p.line), `try preset ${p.id}`);
  assert.ok(tr.includes('HELD FOR YOU UntrustedAmount') && tr.includes('ALLOWED'), 'try verdict words in the table');
  // the hired world is written out in llms-full.txt (the page opens on the bills until its script runs)
  const full = await get('/llms-full.txt');
  assert.equal(full.status, 200);
  for (const p of [...WORLD.presets, ...HIRED.presets]) assert.ok(full.body.includes(`### ${p.title}`), `llms-full preset ${p.id}`);

  // the replay: every act, its outcome and its transaction
  const rp = textOf((await get('/replay/')).body);
  for (const s of ['Act 1 Invoice paid', 'Act 2 Correction held', 'Act 3 Tampered approval', '4.2 NEAR paid', '9.4 NEAR held', 'Nothing signed', 'approve rejected: WrongAmount']) assert.ok(rp.includes(s), `replay text: ${s}`);
  for (const g of ['u01', 'b01-escalate', 'tamper']) {
    const hash = golden(g).txs[0]?.hash;
    if (hash !== undefined) assert.ok(rp.includes(hash), `replay tx ${g} ${hash}`);
  }

  // bench and proven carry their tables and statements as text
  const bt = textOf((await get('/bench/')).body);
  assert.ok(bt.includes('69/250 (27.6%, 22.4 to 33.4)') && bt.includes('44/70 (62.9%, 51.1 to 73.2)'), 'bench numbers as text');
  const pv = textOf((await get('/proven/')).body);
  assert.ok(pv.includes('PROVEN OK') && pv.includes('What this does not cover'), 'proven text');

  // AIR-313: the Use page carries every step, command and last line as text
  const us = textOf((await get('/use/')).body);
  for (const s of ['Use it with your own agent', 'pnpm airlock init --owner', 'AIRLOCK READY', 'pnpm airlock approve', 'What the agent can and cannot do']) assert.ok(us.includes(s), `use text: ${s}`);

  // the machine files
  const llms = await get('/llms.txt');
  assert.equal(llms.status, 200);
  assert.ok(llms.body.startsWith('# AIRLOCK\n\n> ') && llms.body.includes('## Pages') && llms.body.includes('/bench.json') && llms.body.includes('/llms-full.txt'), 'llms.txt shape');
  for (const p of PAGES.filter((x) => x.alias === undefined)) assert.ok(llms.body.includes(p.description), `llms.txt lists ${p.path}`);
  const readme = readFileSync(join(web, '..', 'README.md'), 'utf8');
  const summary = readme.split('\n')[2] ?? '';
  assert.ok(summary.length > 40 && llms.body.includes(summary) && full.body.includes(summary), 'the summary is the README line, verbatim');
  assert.ok(full.body.includes('## The result (README)') && full.body.includes('## Limits (README)') && full.body.includes('## Every testnet transaction in docs/EVIDENCE.md'), 'llms-full sections');
  const robots = await get('/robots.txt');
  assert.ok(robots.body.includes('User-agent: *') && robots.body.includes('Allow: /') && robots.body.includes('sitemap.xml'), 'robots.txt');
  const sitemap = await get('/sitemap.xml');
  for (const p of PAGES.filter((x) => x.alias === undefined)) assert.ok(sitemap.body.includes(`${p.path === '/' ? '' : `${p.path}/`}</loc>`), `sitemap ${p.path}`);
  // AIR-323: no sitemap entry is a path the host answers with a 308
  for (const m of sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)) assert.ok((m[1] ?? '').endsWith('/'), `sitemap entry ${m[1] ?? ''} is in the slash form`);
  // raw data stays reachable
  assert.equal((await get('/bench.json')).status, 200);
  assert.equal((await get('/data/replay/acts.json')).status, 200);
};

export default run;
