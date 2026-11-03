import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { verdictCliPath } from '../../bench/src/runner/backend.ts';
import { judge, runSelftest } from '../src/selftest.ts';
import { EMPTY_BOARD } from '../src/types.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const board = (o: Partial<typeof EMPTY_BOARD>) => ({ ...EMPTY_BOARD, ...o });

test('judge: OK only for 39 attempts, nothing stolen and every case run', () => {
  assert.deepEqual(judge(board({ attempts: 39 }), 0), { ok: true, line: 'CHALLENGE OK attempts 39 stolen 0' });
  assert.equal(judge(board({ attempts: 39, stolenYocto: (10n ** 24n).toString() }), 0).ok, false);
  assert.equal(judge(board({ attempts: 39, stolenYocto: (10n ** 24n).toString() }), 0).line, 'CHALLENGE FAIL attempts 39 stolen 1');
  assert.equal(judge(board({ attempts: 38 }), 0).ok, false);
  assert.equal(judge(board({ attempts: 39 }), 1).ok, false);
});

const hasCli = ((): boolean => {
  try {
    accessSync(verdictCliPath(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

test('selftest: the 39 bench cases through the real verdict path, recorded, nothing stolen', { skip: hasCli ? false : 'verdict_cli is not built' }, async () => {
  const before = process.env['LLM_MODE'];
  const lines: string[] = [];
  const code = await runSelftest({ root: ROOT, out: (l) => lines.push(l), blockNet: false });
  assert.equal(code, 0, lines.slice(-3).join('\n'));
  assert.equal(lines.at(-1), 'CHALLENGE OK attempts 39 stolen 0');
  assert.ok(lines.some((l) => l.startsWith('board: attempts 39')));
  assert.ok(lines.some((l) => /^Escalate\s+own-B01\s+OverTaskBound/.test(l)), 'the over-bound correction is held');
  assert.equal(process.env['LLM_MODE'], before, 'the mode is restored');
});
