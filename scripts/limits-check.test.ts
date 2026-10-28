// AIR-241: tests of scripts/limits-check.ts. The skeleton fixture is a frozen copy of the kit's docs/KNOWN_LIMITATIONS.md
// (21 bullets, the fifteen original keywords, none of the nine new ones), so the first test keeps its meaning after the
// live file is extended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'limits-check.ts');
const SKELETON = readFileSync(join(HERE, 'fixtures', 'limits', 'skeleton.md'), 'utf8');
const NEW = ['payment before delivery', 'availability', 'pairing', 'x402', 'look-alike', 'Ed25519', 'reject-all', 'careless owner', 'simulated'];

const ALL = ['host powers', 'unattested', 'oracle dust', 'plan_hash', 'UTC', 'socially engineered', 'side channel', 'K2', 'quick cap',
  'trusted computing base', 'fixtures', 'testnet only', 'cancel', 'owner transfer', 'Lean', ...NEW];

function full(bullets: number): string {   // n bullets: one per keyword (24), then fillers
  const lines = ['# Known limitations', ''];
  for (const k of ALL) lines.push('- A limit about ' + k + ' stated plainly.');
  for (let n = ALL.length; n < bullets; n++) lines.push('- A filler limit number ' + n + '.');
  return lines.join('\n') + '\n';
}

function check(doc: string, g4?: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'lim-'));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'KNOWN_LIMITATIONS.md'), doc);
    if (g4) writeFileSync(join(root, 'docs', 'DECISIONS.md'), '# Decisions\n\n' + g4 + '\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';

test('the skeleton fails: 21 bullets and the nine new keywords missing', () => {
  const r = check(SKELETON);
  assert.equal(r.code, 1, r.out);
  for (const k of NEW) assert.ok(r.out.includes(k), 'missing keyword not reported: ' + k);
});

test('the full file passes with 30 bullets and every keyword', () => {
  const r = check(full(30));
  assert.equal(r.code, 0, r.out);
  assert.equal(lastLine(r.out), 'LIMITS OK 30 bullets');
});

test('one bullet removed fails (29 of 30)', () => {
  assert.equal(check(full(29)).code, 1);
});

test('under a G4 OUT line the minimum is 29: 29 pass, 28 fail', () => {
  assert.equal(check(full(29), 'G4 2026-11-09 OUT').code, 0);
  assert.equal(check(full(28), 'G4 2026-11-09 OUT').code, 1);
  assert.equal(check(full(29), 'G4 2026-11-09 IN').code, 1);
});

test('a judge sentence or a placeholder fails', () => {
  assert.equal(check(full(30) + 'A judge would read this.\n').code, 1);
  assert.equal(check(full(30) + 'To fill during the build.\n').code, 1);
});
