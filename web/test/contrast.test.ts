// Contrast checker and token emitter (AIR-183).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkContrast, defaultPairs } from '../scripts/check-contrast.ts';
import { cssName, manual, space, tokensCss } from '../src/styles/tokens.ts';
import type { TokenName } from '../src/styles/tokens.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

// D24 (AIR-296): the dark NEAR palette, recomputed with the same WCAG 2 formula.
const EXPECTED: Array<[fg: TokenName, bg: TokenName, ratio: number]> = [
  ['ink', 'paper', 17.27],
  ['ink', 'raised', 15.84],
  ['ink', 'sunk', 17.79],
  ['ink2', 'paper', 9.83],
  ['ink2', 'raised', 9.01],
  ['ink2', 'sunk', 10.12],
  ['ink3', 'paper', 5.96],
  ['ink3', 'raised', 5.46],
  ['ink3', 'sunk', 6.14],
  ['clear', 'paper', 12.53],
  ['clear', 'raised', 11.49],
  ['clear', 'sunk', 12.91],
  ['alarm', 'paper', 6.51],
  ['alarm', 'raised', 5.97],
  ['alarm', 'sunk', 6.71],
  ['signal', 'paper', 11.14],
  ['signal', 'raised', 10.21],
  ['signal', 'sunk', 11.47],
  ['info', 'paper', 7.63],
  ['info', 'raised', 7.0],
  ['info', 'sunk', 7.86],
  ['onClear', 'clear', 12.12],
  ['paper', 'ink', 17.27],
  ['edge', 'paper', 3.66],
  ['edge', 'raised', 3.35],
  ['edge', 'sunk', 3.77],
  ['focus', 'paper', 11.1],
];

test('contrast: the ratios of the ticket match within 0.01 and are all ok', () => {
  const results = checkContrast(EXPECTED.map(([fg, bg]) => ({ fg, bg, min: 3 })));
  assert.equal(results.length, EXPECTED.length);
  results.forEach((r, i) => {
    const want = EXPECTED[i]![2];
    assert.ok(Math.abs(r.ratio - want) <= 0.01, `${r.fg} on ${r.bg}: ${r.ratio} vs ${want}`);
    assert.equal(r.ok, true);
  });
});

test('contrast: a failing pair is reported ok false (hair on paper is 1.42)', () => {
  const [r] = checkContrast([{ fg: 'hair', bg: 'paper', min: 4.5 }]);
  assert.ok(r);
  assert.ok(Math.abs(r.ratio - 1.42) <= 0.01, String(r.ratio));
  assert.equal(r.ok, false);
});

test('contrast: the default pair list has 23 text pairs and 6 graphics pairs, all ok', () => {
  const pairs = defaultPairs();
  assert.equal(pairs.length, 29);
  assert.equal(pairs.filter((p) => p.min === 4.5).length, 23);
  assert.equal(pairs.filter((p) => p.min === 3).length, 6);
  assert.ok(checkContrast(pairs).every((r) => r.ok));
});

test('contrast: the CLI exits 0 by default and 1 with CONTRAST_EXTRA=hair:paper:4.5', () => {
  const run = (extra?: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-contrast.ts'], {
      cwd: webRoot,
      env: { ...process.env, ...(extra ? { CONTRAST_EXTRA: extra } : {}) },
      encoding: 'utf8',
    });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run('hair:paper:4.5');
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
});

test('tokens: cssName splits a trailing digit and a capital', () => {
  assert.equal(cssName('ink2'), 'ink-2');
  assert.equal(cssName('onClear'), 'on-clear');
});

test('tokens: tokensCss emits every colour and space property and the committed file matches', () => {
  const css = tokensCss();
  for (const [name, hex] of Object.entries(manual)) {
    const prop = cssName(name as TokenName);
    assert.ok(css.includes(`--${prop}: ${hex};`), prop);
  }
  space.forEach((px, i) => assert.ok(css.includes(`--space-${i + 1}: ${px}px;`), `space-${i + 1}`));
  assert.equal(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'), css);
});
