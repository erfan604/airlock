// AIR-313: the /use page and docs/QUICKSTART.md say the same thing. Every command and expected last line of the page is in the quickstart
// verbatim, the page renders every step as text without JavaScript (no copy button before the script runs), and the page is in the site's
// route table, page list and nav.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAGES } from '../src/pages.ts';
import { ROUTES } from '../src/routes.ts';
import { NAV } from '../src/shell/SiteNav.tsx';
import { ONE_LINE, STEPS } from '../src/use/steps.ts';
import { UsePage } from '../src/use/UsePage.tsx';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const quickstart = fs.readFileSync(path.join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8');

const unescape = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('use: every command and last line of the page is in docs/QUICKSTART.md', () => {
  for (const s of STEPS) {
    if (s.cmd !== undefined) assert.ok(quickstart.includes(s.cmd), `command of ${s.id}`);
    if (s.last !== undefined) assert.ok(quickstart.includes(s.last), `last line of ${s.id}`);
  }
  assert.ok(quickstart.includes(ONE_LINE.cmd) && quickstart.includes(ONE_LINE.last));
  assert.ok(quickstart.includes('pnpm airlock play') && quickstart.includes('PLAY DONE allow 1 escalate 2 block 0'));
});

test('use: the prerendered page carries every step as text and no copy button', () => {
  const html = unescape(renderToStaticMarkup(<UsePage />));
  for (const s of STEPS) {
    assert.ok(html.includes(s.title), s.title);
    if (s.cmd !== undefined) assert.ok(html.includes(s.cmd), s.cmd);
  }
  assert.ok(!html.includes('use-copy'));
});

// AIR-346 (D23): `npm view airlock-near-mcp version` answered 404 on 2026-11-09, so the npx line would fail for anyone who pastes it. The first
// command is the clone check that works today (run by hand: it ends AIRLOCK MCP OK), and the npx line is not on the page until the package resolves.
test('use: the first command is the clone check that works today, and the unpublished npx line is not shown', () => {
  const html = unescape(renderToStaticMarkup(<UsePage />));
  assert.ok(html.includes(ONE_LINE.cmd));
  assert.ok(html.indexOf(ONE_LINE.cmd) < html.indexOf(STEPS[0]?.title ?? 'x'));
  assert.ok(ONE_LINE.cmd.includes('node packages/airlock-near-mcp/dist/cli.js --check'), ONE_LINE.cmd);
  assert.ok(!html.includes('npx -y airlock-near-mcp'), 'the npx line fails until the package is published');
  assert.ok(!/after publish/i.test(html));
  assert.equal(ONE_LINE.last, 'AIRLOCK MCP OK');
});

test('use: routed, listed for the sitemap and llms.txt, and in the nav', () => {
  assert.ok(Object.hasOwn(ROUTES, '/use'));
  assert.ok(PAGES.some((p) => p.path === '/use' && p.alias === undefined));
  assert.ok(NAV.some((n) => n.path === 'use'));
});
