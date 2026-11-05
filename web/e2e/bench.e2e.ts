// The Bench page in a real browser (AIR-192) at 375x667 and 1440x900 on /bench: every cell text equals the string in web/public/bench.json,
// one dot and whisker per whisker cell, the detail tables opened and closed, no console error (the harness fails on one), and the clip audit
// at both widths. Screenshots go to web/audit/bench-<width>.png.
// Run: pnpm -C web build && pnpm -C web e2e bench
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipAudit } from './audit.ts';
import type { E2E } from './types.ts';

type Table = { head: string[]; rows: { cells: string[]; whiskers: (unknown | null)[] }[] };
const root = fileURLToPath(new URL('../', import.meta.url));
const data = JSON.parse(readFileSync(join(root, 'public', 'bench.json'), 'utf8')) as {
  header: string;
  compare: unknown[];
  attack: Table;
  attackFeasible?: Table | null;
  breakdown?: Table | null;
  benign: Table;
  outcomes: Table;
  owner: Table;
  completion: Table[];
  gaps: Table | null;
  redteam?: Table | null;
};

const run: E2E = async ({ page, baseUrl }) => {
  mkdirSync(join(root, 'audit'), { recursive: true });
  const hosts = new Set<string>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.host);
  });
  for (const viewport of [{ width: 375, height: 667 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/bench`);
    await page.waitForSelector('[data-testid="bench-compare"]');
    await page.evaluate(() => document.fonts.ready.then(() => true));
    assert.equal(await page.locator('[data-testid="bench-empty"]').count(), 0, 'results are shown');
    assert.equal(await page.locator('[data-testid="bench-header"]').innerText(), data.header);

    const tables: [string, Table][] = [['bench-attack', data.attack], ['bench-benign', data.benign], ['bench-outcomes', data.outcomes], ['bench-owner', data.owner], ...data.completion.map((t, i): [string, Table] => [`bench-completion-${i}`, t])];
    if (data.attackFeasible) tables.push(['bench-attack-feasible', data.attackFeasible]);
    if (data.breakdown) tables.push(['bench-breakdown', data.breakdown]);
    if (data.gaps !== null) tables.push(['bench-gaps', data.gaps]);
    if (data.redteam) tables.push(['bench-redteam', data.redteam]);
    let whiskers = 0;
    for (const [id, t] of tables) {
      const cells = await page.locator(`[data-testid="${id}"] tbody td .bt-cell`).evaluateAll((els) => els.map((e) => e.textContent ?? ''));
      assert.deepEqual(cells, t.rows.flatMap((r) => r.cells), `${id} cells at ${viewport.width}`);
      whiskers += t.rows.reduce((s, r) => s + r.whiskers.filter((w) => w !== null).length, 0);
    }
    const inTables = await page.locator('.bt [data-testid="dot-whisker"]').count();
    assert.equal(inTables, whiskers, 'one whisker per whisker cell');
    assert.equal(await page.locator('.bc [data-testid="dot-whisker"]').count(), data.compare.length * 3, 'three whiskers per chart row');
    const labels = await page.locator('.bt [data-testid="dot-whisker"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    const texts = await page.locator('.bt td.bt-stat .bt-cell').evaluateAll((els) => els.map((e) => e.textContent ?? ''));
    assert.deepEqual(labels, texts, 'aria-label equals the cell text');

    // closed, then every detail open: the long tables must not push the page wider either
    await page.screenshot({ path: join(root, 'audit', `bench-${viewport.width}.png`), fullPage: true });
    assert.deepEqual(await clipAudit(page, [viewport.width]), [], `clip audit, closed, ${viewport.width}`);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    assert.deepEqual(await clipAudit(page, [viewport.width]), [], `clip audit, open, ${viewport.width}`);
    await page.screenshot({ path: join(root, 'audit', `bench-${viewport.width}-open.png`), fullPage: true });
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = false; }));
  }
  assert.deepEqual([...hosts].filter((h) => !h.startsWith('127.0.0.1')), [], 'every request stays on the page origin');
};
export default run;
