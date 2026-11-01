// Contrast checker and token emitter (AIR-183).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkContrast, defaultPairs } from '../scripts/check-contrast.ts';
import { manual, space, tokensCss } from '../src/styles/tokens.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

const EXPECTED: Array<[fg: 'ink' | 'ink2' | 'ink3' | 'clear' | 'alarm' | 'signal', bg: 'paper' | 'raised' | 'sunk' | 'ink', ratio: number]> = [
  ['ink', 'paper', 15.19],
  ['ink', 'raised', 16.77],
  ['ink', 'sunk', 13.44],
  ['ink2', 'paper', 7.64],
  ['ink2', 'raised', 8.43],
  ['ink2', 'sunk', 6.75],
  ['ink3', 'paper', 5.4],
  ['ink3', 'raised', 5.97],
  ['ink3', 'sunk', 4.78],
  ['clear', 'paper', 6.25],
  ['clear', 'raised', 6.9],
  ['clear', 'sunk', 5.53],
  ['alarm', 'paper', 6.34],
  ['alarm', 'raised', 7.0],
  ['alarm', 'sunk', 5.61],
  ['signal', 'ink', 5.9],
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

test('contrast: a failing pair is reported ok false (hair on paper is 1.65)', () => {
  const [r] = checkContrast([{ fg: 'hair', bg: 'paper', min: 4.5 }]);
  assert.ok(r);
  assert.ok(Math.abs(r.ratio - 1.65) <= 0.01, String(r.ratio));
  assert.equal(r.ok, false);
});

test('contrast: the default pair list has 15 text pairs and 3 graphics pairs, all ok', () => {
  const pairs = defaultPairs();
  assert.equal(pairs.length, 18);
  assert.equal(pairs.filter((p) => p.min === 4.5).length, 15);
  assert.equal(pairs.filter((p) => p.min === 3).length, 3);
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

test('tokens: tokensCss emits every colour and space property and the committed file matches', () => {
  const css = tokensCss();
  for (const [name, hex] of Object.entries(manual)) {
    const prop = name.replace(/([0-9])/, '-$1');
    assert.ok(css.includes(`--${prop}: ${hex};`), prop);
  }
  space.forEach((px, i) => assert.ok(css.includes(`--space-${i + 1}: ${px}px;`), `space-${i + 1}`));
  assert.equal(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'), css);
});
