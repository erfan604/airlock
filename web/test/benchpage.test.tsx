// AIR-192: the Bench page over fake fetch results. Every string of the JSON is shown as text, a 404 or a malformed file shows the empty
// state and no table, the DRAFT banner follows `draft`, and a hostile-looking cell is text, never markup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BenchView } from '../src/bench/BenchPage.tsx';
import { DotWhisker } from '../src/bench/DotWhisker.tsx';
import { loadBench, parseBench } from '../src/bench/types.ts';
import type { BenchData } from '../src/bench/types.ts';
import { ROUTES } from '../src/routes.ts';

const raw = JSON.parse(readFileSync(new URL('../fixtures/bench.json', import.meta.url), 'utf8')) as unknown;
const fake = (status: number, body: unknown): typeof fetch => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
const unescape = (html: string): string => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function data(): Promise<BenchData> {
  const d = await loadBench(fake(200, raw));
  assert.ok(d !== null);
  return d;
}

test('bench: every cell of the JSON is on the page as text', async () => {
  const d = await data();
  const html = unescape(renderToStaticMarkup(<BenchView data={d} />));
  for (const t of [d.attack, d.benign, d.outcomes, d.owner, ...d.completion]) {
    for (const r of t.rows) for (const c of r.cells) assert.ok(html.includes(`>${c}<`), c);
  }
  assert.ok(html.includes(d.header));
});

test('bench: one dot and whisker per whisker cell, with the cell text as its label', async () => {
  const d = await data();
  const html = renderToStaticMarkup(<BenchView data={d} />);
  const tables = [d.attack, d.benign, d.outcomes, d.owner, ...d.completion];
  const cells = tables.flatMap((t) => t.rows.flatMap((r) => r.whiskers.filter((w) => w !== null)));
  const chart = d.compare.length * 3;
  assert.equal((html.match(/data-testid="dot-whisker"/g) ?? []).length, cells.length + chart);
  const first = d.compare[0];
  assert.ok(first !== undefined && unescape(html).includes(`aria-label="${first.attack.text}"`));
});

test('bench: a 404, a failed fetch and a malformed file show the empty state and no table', async () => {
  const bad: (typeof fetch)[] = [fake(404, 'not found'), fake(200, '{"draft":true}'), fake(200, 'not json'), (async () => { throw new Error('offline'); }) as typeof fetch];
  for (const f of bad) {
    const d = await loadBench(f);
    assert.equal(d, null);
    const html = renderToStaticMarkup(<BenchView data={d} />);
    assert.ok(html.includes('data-testid="bench-empty"') && html.includes('No bench results yet.'));
    assert.ok(!html.includes('<table') && !html.includes('dot-whisker'));
  }
});

test('bench: the draft banner shows when draft is true and not otherwise', async () => {
  const d = await data();
  assert.ok(renderToStaticMarkup(<BenchView data={{ ...d, draft: true }} />).includes('data-testid="bench-draft"'));
  assert.ok(!renderToStaticMarkup(<BenchView data={{ ...d, draft: false }} />).includes('data-testid="bench-draft"'));
});

test('bench: a hostile cell string is text, never markup', async () => {
  const d = await data();
  const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
  const t = structuredClone(d);
  t.owner.rows[0]!.cells[0] = evil;
  t.residual = { text: evil, cases: [] };
  const html = renderToStaticMarkup(<BenchView data={t} />);
  assert.ok(!html.includes('<img') && !html.includes('<script'));
  assert.ok(unescape(html).includes(evil));
  assert.equal(parseBench(t) === null, false);
});

test('bench: the dot and whisker places the marker from the numbers and draws nothing for n = 0', () => {
  const full = renderToStaticMarkup(<DotWhisker row={{ k: 3, n: 10, p: 0.3, lo: 0.1, hi: 0.6 }} kind="attack" label="3/10" />);
  assert.ok(full.includes('x1="10%"') && full.includes('x2="60%"') && full.includes('x="30%"') && full.includes('aria-label="3/10"'));
  assert.equal((full.match(/class="dw-cap"/g) ?? []).length, 2);
  assert.ok(full.includes('width="14"') && full.includes('height="14"'));
  const empty = renderToStaticMarkup(<DotWhisker row={{ k: 0, n: 0, p: 0, lo: 0, hi: 0 }} kind="plain" label="0/0 (n/a)" />);
  assert.ok(!empty.includes('dw-mark'));
});

test('bench: the route is registered and the page holds no statistics code', () => {
  assert.ok(Object.hasOwn(ROUTES, '/bench'));
  assert.equal(typeof ROUTES['/bench'], 'function');
});

// visitor test 2026-11-11: MANDATE (0 attacks, every task done) looked strictly better than AIRLOCK, and MANDATE-C (every attack paid) was
// unexplained. The chart now says what those rows are, what MANDATE assumes, what MANDATE-C shows and where AIRLOCK's check runs.
test('bench: the derived baseline rows are explained beside the chart, before it', async () => {
  const d = await data();
  const html = unescape(renderToStaticMarkup(<BenchView data={d} />));
  const at = html.indexOf('data-testid="bench-derived"');
  assert.ok(at > 0 && at < html.indexOf('data-testid="bench-compare-row"'), 'the explanation sits above the rows');
  const t = (/data-testid="bench-derived">([^<]*)</.exec(html)?.[1] ?? '').replace(/\s+/g, ' ');
  for (const s of [
    'CAPS, BLOCKLIST, MANDATE and MANDATE-C are not systems that ran',
    'a filter applied after the fact to the payments the unprotected agent V0 made in its recorded runs',
    "MANDATE models a gateway off chain that is told the owner's exact task",
    'MANDATE-C is the same gateway when the machine it runs on is compromised',
    'it pays every attack, because the check is not on chain',
    "AIRLOCK's check runs in the NEAR contract before anything is signed",
  ])
    assert.ok(t.includes(s), s);
  assert.ok(!/\u2014|--|testnet|\bjudges?\b|\breviewers?\b|\bonly\b|nobody|unhackable/i.test(t));
  for (const r of d.compare) assert.ok(html.includes(`data-config="${r.config}"`), `${r.config}: no row renamed`);
});
