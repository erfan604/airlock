// AIR-289: load-time generated values (F2), the pure-ASCII rule of the stored files, and the recipient keys of the A12 family. Every row is its own
// test(). No test calls a model. Code points are written as numbers in this file; nothing stored holds one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyError, payeeKey } from '@airlock/runtime/dsl';
import { UNICODE_GEN, UnknownGen, expandGen } from '../src/extra/unicode-gen.ts';
import { loadCases } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { BENCH_DIR, fixtureObject, fixtureParse, tempDir } from './helpers/cases.ts';

const SHOULD = join(BENCH_DIR, 'cases', 'should');
const PAYLOADS = join(BENCH_DIR, 'fixtures', 'payloads');
const NEW_PAYLOADS = ['own-B01-incap-words', 'own-E04-pay', 'own-E05', 'own-B06', 'own-P05', 'own-A05-split-1', 'own-A05-split-2', 'own-page-A12g'];

const points = (s: string): number[] => Array.from(s).map((ch) => ch.codePointAt(0) ?? -1);

// a loader-checked case whose reference extract holds one `{ gen }` object per name
function caseWithGen(names: string[]): Case {
  const o = fixtureObject('T-A01');
  o['gate'] = { plan: o['gate']['plan'], extract: names.map((name) => ({ v: { gen: name } })) };
  return fixtureParse(o);
}

const valueOf = (c: Case, index: number): string => {
  assert.ok(c.gate !== null && 'extract' in c.gate);
  const v = c.gate.extract[index]?.['v'];
  assert.equal(typeof v, 'string');
  return v as string;
};

test('1: expandGen turns each name into the intended code points, and an unknown name throws UnknownGen', () => {
  const names = ['cyrillic_a_accountant', 'kelvin_kamal', 'fullwidth_accountant', 'zwj_accountant', 'trailing_space_accountant', 'persian_4_2', 'fullwidth_4_2'];
  assert.deepEqual(Object.keys(UNICODE_GEN).sort(), [...names].sort());
  const expanded = expandGen(caseWithGen(names));
  const cyr = points(valueOf(expanded, 0));
  assert.equal(cyr.filter((p) => p === 0x430).length, 1);
  assert.ok(cyr.indexOf(0x430) > 0, 'inside the id, not at its start');
  assert.equal(cyr.length, 'accountant.testnet'.length);
  assert.equal(valueOf(expanded, 1).codePointAt(0), 0x212a);
  assert.equal(valueOf(expanded, 1).slice(1), 'amal.testnet');
  const full = points(valueOf(expanded, 2));
  assert.equal(full[0], 0xff41);
  assert.ok(full.slice(0, 10).every((p) => p >= 0xff41 && p <= 0xff5a));
  assert.equal(valueOf(expanded, 2).slice(10), '.testnet');
  const zwj = points(valueOf(expanded, 3));
  assert.equal(zwj.filter((p) => p === 0x200d).length, 1);
  assert.equal(valueOf(expanded, 3).replace(String.fromCodePoint(0x200d), ''), 'accountant.testnet');
  const trailing = valueOf(expanded, 4);
  assert.equal(trailing.codePointAt(trailing.length - 1), 0x20);
  assert.equal(trailing.trimEnd(), 'accountant.testnet');
  assert.deepEqual(points(valueOf(expanded, 5)), [0x6f4, 0x2e, 0x6f2]);
  assert.deepEqual(points(valueOf(expanded, 6)), [0xff14, 0x2e, 0xff12]);
  // a case without a generated value comes back equal, and the input is not changed
  const input = caseWithGen(['persian_4_2']);
  const snapshot = JSON.stringify(input);
  expandGen(input);
  assert.equal(JSON.stringify(input), snapshot);
  const plain = fixtureParse(fixtureObject('T-A01'));
  assert.deepEqual(expandGen(plain), plain);
  assert.throws(
    () => expandGen(caseWithGen(['no_such_name'])),
    (e: unknown) => e instanceof UnknownGen && e.message === 'UnknownGen no_such_name',
  );
});

test('2: the case file, static-rows.json and every new payload file are pure ASCII, and the scan flags a file with a non-ASCII byte built at runtime', () => {
  const files = [join(SHOULD, 'own-extra2.jsonl'), join(SHOULD, 'static-rows.json'), ...NEW_PAYLOADS.map((id) => join(PAYLOADS, `${id}.txt`))];
  const scan = (file: string): number => {
    try {
      // the BSD grep of the system, not the shell function of the agent shell; a match (exit 0) means a non-printable, non-space byte
      execFileSync('/usr/bin/grep', ['-nE', '[^[:print:][:space:]]', file], { env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };
  for (const f of files) {
    assert.ok(readFileSync(f).length > 0, `${f} is empty or missing`);
    assert.equal(scan(f), 1, `${f} holds a non-ASCII byte`);
    for (const byte of readFileSync(f)) assert.ok(byte < 0x80, `${f} holds a byte above 0x7F`);
  }
  const t = tempDir();
  try {
    const bad = join(t.dir, 'bad.txt');
    writeFileSync(bad, `a${String.fromCodePoint(0xe9)}b\n`);
    assert.equal(scan(bad), 0);
    const clean = join(t.dir, 'clean.txt');
    writeFileSync(clean, 'plain text\n');
    assert.equal(scan(clean), 1);
  } finally {
    t.rm();
  }
});

test('4: payeeKey throws KeyError for A12 a to f taken from expandGen, independent of the interpreter, and accepts the plain accountant.testnet', () => {
  const cases = loadCases(SHOULD).map(expandGen);
  for (const letter of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const c = cases.find((x) => x.id === `own-A12-${letter}`);
    assert.ok(c !== undefined, `no case own-A12-${letter}`);
    assert.ok(c.gate !== null && 'extract' in c.gate);
    const to = c.gate.extract[0]?.['to'];
    assert.equal(typeof to, 'string');
    assert.throws(() => payeeKey({ kind: 'near' }, to as string), KeyError, `own-A12-${letter}`);
  }
  assert.equal(payeeKey({ kind: 'near' }, 'accountant.testnet'), 'near:accountant.testnet');
});
