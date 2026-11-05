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

// AIR-311: the night navy media palette (D24 roles kept), recomputed with the same WCAG 2 formula.
const EXPECTED: Array<[fg: TokenName, bg: TokenName, ratio: number]> = [
  ['ink', 'paper', 14.62],
  ['ink', 'raised', 12.95],
  ['ink', 'sunk', 15.68],
  ['ink2', 'paper', 10.04],
  ['ink2', 'raised', 8.89],
  ['ink2', 'sunk', 10.76],
  ['ink3', 'paper', 6.64],
  ['ink3', 'raised', 5.88],
  ['ink3', 'sunk', 7.12],
  ['clear', 'paper', 11.62],
  ['clear', 'raised', 10.29],
  ['clear', 'sunk', 12.46],
  ['alarm', 'paper', 6.67],
  ['alarm', 'raised', 5.91],
  ['alarm', 'sunk', 7.15],
  ['signal', 'paper', 5.61],
  ['signal', 'raised', 4.97],
  ['signal', 'sunk', 6.02],
  ['info', 'paper', 10.05],
  ['info', 'raised', 8.9],
  ['info', 'sunk', 10.78],
  ['xray', 'paper', 10.87],
  ['xray', 'raised', 9.63],
  ['xray', 'sunk', 11.66],
  ['onClear', 'clear', 12.12],
  ['paper', 'ink', 14.62],
  ['edge', 'paper', 4.08],
  ['edge', 'raised', 3.61],
  ['edge', 'sunk', 4.37],
  ['focus', 'paper', 10.87],
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

test('contrast: a failing pair is reported ok false (hair on paper is 1.47)', () => {
  const [r] = checkContrast([{ fg: 'hair', bg: 'paper', min: 4.5 }]);
  assert.ok(r);
  assert.ok(Math.abs(r.ratio - 1.47) <= 0.01, String(r.ratio));
  assert.equal(r.ok, false);
});

test('contrast: the default pair list has 26 text pairs and 6 graphics pairs, all ok', () => {
  const pairs = defaultPairs();
  assert.equal(pairs.length, 32);
  assert.equal(pairs.filter((p) => p.min === 4.5).length, 26);
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
