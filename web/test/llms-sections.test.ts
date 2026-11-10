// AIR-357: the README is one screen, and llms-full.txt copies its sections verbatim. readmeSection throws on a missing heading and runs
// inside build:static (scripts/prerender.tsx), so the list in web/scripts/llms.ts and the README headings must change together.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { README_SECTIONS, readmeSection } from '../scripts/llms.ts';

const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
const headings = readme.split('\n').filter((l) => l.startsWith('## '));

test('README_SECTIONS is the AIR-357 list', () => {
  assert.deepEqual(README_SECTIONS, ['In 90 seconds', 'The problem', 'What NEAR does here', 'Keys', 'The result', 'Verify in 5 commands', 'Limits']);
});

test('every name in README_SECTIONS is a "## " line of the README, with text under it', () => {
  for (const name of README_SECTIONS) {
    assert.ok(headings.includes(`## ${name}`), `README has no "## ${name}" line`);
    assert.ok(readmeSection(readme, name).length > 0, `README section ${name} is empty`);
  }
});

test('the README fits one screen: under 8192 bytes, and line 3 is the credit sentence', () => {
  assert.ok(Buffer.byteLength(readme, 'utf8') < 8192, `README is ${Buffer.byteLength(readme, 'utf8')} bytes`);
  const line3 = readme.split('\n')[2] ?? '';
  assert.ok(line3.startsWith('AIRLOCK is a lending pool for AI agents on NEAR: '), 'line 3 is the credit sentence');
});
