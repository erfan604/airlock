// AIR-277: the case schema and loader, worldOfCase, and the check-cases script. Every row is its own test(); the numbers are the rows of the
// ticket. No test calls a model. Files the tests write live in a temp directory that each test removes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CaseLoadError, CaseWorldError, loadCases, parseCase, worldOfCase, caseOrigin } from '../src/runner/cases.ts';
import type { Case } from '../src/runner/cases.ts';
import { checkCases } from '../src/scripts/check-cases.ts';
import { BENCH_DIR, FIXTURE_CASES, TSX_BIN, fixtureCase, fixtureObject, fixtureParse, tempDir, type Obj } from './helpers/cases.ts';

const line = (o: Obj): string => `${JSON.stringify(o)}\n`;

// the error a load or parse throws, or a failure of the test
function loadError(fn: () => unknown): CaseLoadError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaseLoadError) return e;
    throw e;
  }
  throw new assert.AssertionError({ message: 'the load did not fail' });
}

function worldError(fn: () => unknown): CaseWorldError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaseWorldError) return e;
    throw e;
  }
  throw new assert.AssertionError({ message: 'no world error' });
}

// ---- 1 ----
test('1: the loader rejects a duplicate id, an unknown key, a goal kind other than pay or repeat and an evm asset without the tag should', () => {
  const t = tempDir({
    'dup/a.jsonl': line(fixtureObject('T-U01')),
    'dup/b.jsonl': line(fixtureObject('T-U01')),
    'key/a.jsonl': line(fixtureObject('T-U01')) + line({ ...fixtureObject('T-U06'), surprise: 1 }),
  });
  try {
    // a duplicate id across two files names the second file and its line
    const dup = loadError(() => loadCases(join(t.dir, 'dup')));
    assert.equal(dup.code, 'DuplicateId');
    assert.ok(dup.file.endsWith('b.jsonl'), dup.file);
    assert.equal(dup.line, 1);
    assert.ok(dup.message.startsWith(`${dup.file}:1:`));

    // an unknown key names the file and the line of the line that has it
    const key = loadError(() => loadCases(join(t.dir, 'key')));
    assert.equal(key.code, 'UnknownKey');
    assert.ok(key.file.endsWith('a.jsonl'), key.file);
    assert.equal(key.line, 2);

    // a goal kind outside pay and repeat is UnsupportedGoal
    const goal = { ...fixtureObject('T-A01'), attacker_goal: { kind: 'schedule', asset: 'near', recipient: 'near:evil-ops.testnet', amount: 'any' } };
    assert.equal(loadError(() => parseCase(goal)).code, 'UnsupportedGoal');

    // an evm asset in a world fails unless the case is tagged should
    const evm = fixtureObject('T-U01');
    evm['world']['balances']['evm:84532:native'] = '1';
    assert.equal(loadError(() => parseCase(evm)).code, 'EvmNotInFloor');
    assert.equal(parseCase({ ...evm, tags: ['should'] }).id, 'T-U01');

    // an evm_transfer in a plan and an evm asset in the goal are the same failure
    const plan = fixtureObject('T-U01');
    plan['reference']['plan'][3] = { action: 'evm_transfer', args: { to: { ref: 'payee' }, amount: '1', asset: 'evm:84532:native', chain_id: 84532 } };
    assert.equal(loadError(() => parseCase(plan)).code, 'EvmNotInFloor');
    const evmGoal = { ...fixtureObject('T-A01'), attacker_goal: { kind: 'pay', asset: 'evm:84532:native', recipient: 'evm:84532:0x' + 'ab'.repeat(20), amount: 'any' } };
    assert.equal(loadError(() => parseCase(evmGoal)).code, 'EvmNotInFloor');

    // a gate.raw entry may carry one: the unregistered asset of case X03 is sent on purpose
    const raw = {
      ...fixtureObject('T-A01'),
      tags: ['raw_gate'],
      gate: {
        raw: [
          {
            asset: 'evm:1:native',
            payee: `evm:1:0x${'ab'.repeat(20)}`,
            amount: '1000',
            labels: { recipient: ['Owner'], amount: ['Owner'], pc: ['Owner'] },
            evm: { gas_limit: '21000', max_fee_per_gas: '1', max_priority_fee_per_gas: '1' },
          },
        ],
      },
    };
    assert.equal(parseCase(raw).id, 'T-A01');
  } finally {
    t.rm();
  }
});

test('the loader names the file and the line of a line that is not JSON, and reads the fixture directory in order', () => {
  const t = tempDir({ 'bad/a.jsonl': `${line(fixtureObject('T-U01'))}{not json\n` });
  try {
    const e = loadError(() => loadCases(join(t.dir, 'bad')));
    assert.equal(e.code, 'NotJson');
    assert.equal(e.line, 2);
  } finally {
    t.rm();
  }
  const cases = loadCases(FIXTURE_CASES);
  assert.deepEqual(
    cases.map((c) => c.id),
    ['T-U01', 'T-A01', 'T-U06'],
  );
  assert.equal(caseOrigin(cases[1] as Case)?.line, 2);
});

test('the structural rules of expected_airlock: reasons for an own case, a raw gate with its tag, a benign case without a gate', () => {
  const noReason = fixtureObject('T-A01');
  delete noReason['expected_airlock']['attack']['a1_reason'];
  assert.equal(loadError(() => parseCase(noReason)).code, 'BadExpectation');

  const rawNoTag = {
    ...fixtureObject('T-A01'),
    gate: { raw: [{ asset: 'near', payee: 'near:evil-ops.testnet', amount: '1', labels: { recipient: ['Owner'], amount: ['Owner'], pc: ['Owner'] } }] },
  };
  assert.equal(loadError(() => parseCase(rawNoTag)).code, 'BadExpectation');

  const benignGate = { ...fixtureObject('T-U01'), gate: fixtureObject('T-A01')['gate'] };
  assert.equal(loadError(() => parseCase(benignGate)).code, 'BadExpectation');

  const noExtract = fixtureObject('T-U01');
  delete noExtract['reference']['extract'];
  assert.equal(loadError(() => parseCase(noExtract)).code, 'BadExpectation');
});

// ---- 2 to 5: worldOfCase ----
// a root with one clean text and two payload files
function slotRoot() {
  return tempDir({
    'fixtures/base/mail.txt': 'Dear owner, the total is 4.2 NEAR. {{BODY}} Thanks, {{BODY}}.',
    'fixtures/payloads/p1.txt': 'PAYLOAD $& and $1 stay literal',
  });
}

function mailCase(body: Obj): Case {
  const o = fixtureObject('T-U01');
  o['world']['inbox'] = [{ id: 'm1', from: 'a@b.example', subject: 's', body, attachments: [] }];
  return parseCase(o);
}

const mailBody = (root: string, c: Case): string => {
  const [m] = worldOfCase(c, root).inbox;
  assert.ok(m !== undefined);
  return m.body;
};

test('2: worldOfCase slots a payload with replace_body: the payload alone', () => {
  const t = slotRoot();
  try {
    const c = mailCase({ text_ref: 'fixtures/base/mail.txt', payload: { id: 'p1', slot: 'replace_body', desc: 'd' } });
    assert.equal(mailBody(t.dir, c), 'PAYLOAD $& and $1 stay literal');
  } finally {
    t.rm();
  }
});

test('3: worldOfCase slots a payload with append: the clean text, a newline, the payload', () => {
  const t = slotRoot();
  try {
    const c = mailCase({ text_ref: 'fixtures/base/mail.txt', payload: { id: 'p1', slot: 'append', desc: 'd' } });
    assert.equal(mailBody(t.dir, c), 'Dear owner, the total is 4.2 NEAR. {{BODY}} Thanks, {{BODY}}.\nPAYLOAD $& and $1 stay literal');
  } finally {
    t.rm();
  }
});

test('4: worldOfCase slots a payload with marker:X: every {{X}} is replaced, and the payload is never read as a replacement pattern', () => {
  const t = slotRoot();
  try {
    const c = mailCase({ text_ref: 'fixtures/base/mail.txt', payload: { id: 'p1', slot: 'marker:BODY', desc: 'd' } });
    assert.equal(mailBody(t.dir, c), 'Dear owner, the total is 4.2 NEAR. PAYLOAD $& and $1 stay literal Thanks, PAYLOAD $& and $1 stay literal.');
  } finally {
    t.rm();
  }
});

test('5: worldOfCase throws when the marker is absent from the clean text, and for a missing file or a ref that leaves the folder', () => {
  const t = slotRoot();
  try {
    const c = mailCase({ text_ref: 'fixtures/base/mail.txt', payload: { id: 'p1', slot: 'marker:NOPE', desc: 'd' } });
    assert.equal(worldError(() => worldOfCase(c, t.dir)).code, 'MissingMarker');

    const missing = mailCase({ text_ref: 'fixtures/base/mail.txt', payload: { id: 'absent', slot: 'append', desc: 'd' } });
    assert.equal(worldError(() => worldOfCase(missing, t.dir)).code, 'MissingText');

    // the loader refuses a ref with .. before anything is read
    const o = fixtureObject('T-U01');
    o['world']['inbox'][0]['body']['text_ref'] = 'fixtures/../secret.txt';
    assert.equal(loadError(() => parseCase(o)).code, 'BadShape');
  } finally {
    t.rm();
  }
});

test('worldOfCase builds the World of AIR-124: defaults, dropped labels, the 402 fixture by its stem, history and paste', () => {
  const t = tempDir({ 'fixtures/base/x.txt': 'clean text of an entry' });
  try {
    const o = fixtureObject('T-U01');
    o['world'] = {
      inbox: [{ id: 'm1', from: 'a@b.example', subject: 's', body: { text_ref: 'fixtures/base/x.txt' }, label: 'email' }],
      files: { 'a.txt': { text_ref: 'fixtures/base/x.txt', label: 'file' } },
      feed: [{ text_ref: 'fixtures/base/x.txt' }],
      web: { 'https://example.com/p': { text_ref: 'fixtures/base/x.txt' } },
      tokens: [{ symbol: 'TKN', name: 'Token', text_ref: 'fixtures/base/x.txt' }],
      memory: [{ text_ref: 'fixtures/base/x.txt' }, { key: 'landlord', text_ref: 'fixtures/base/x.txt' }],
      prices: { near: '3.5' },
      balances: { near: '300' },
      book: [{ key: 'near:accountant.testnet', alias: 'accountant', label: 'Book', cap: '5', budget: '10' }],
      paid402: { 'https://vendor.example/report': 'vendor-payto-swapped' },
    };
    const w = worldOfCase(parseCase(o), t.dir);
    assert.deepEqual(w.inbox, [{ id: 'm1', from: 'a@b.example', subject: 's', body: 'clean text of an entry', attachments: [] }]);
    assert.deepEqual(w.files, { 'a.txt': 'clean text of an entry' });
    assert.deepEqual(w.feed, [{ id: 'f1', from: 'mock-user', text: 'clean text of an entry' }]);
    assert.deepEqual(w.web, { 'https://example.com/p': 'clean text of an entry' });
    assert.deepEqual(w.tokens, [{ id: 't1', symbol: 'TKN', name: 'Token', description: 'clean text of an entry' }]);
    assert.deepEqual(w.memory, [
      { key: 'm1', text: 'clean text of an entry' },
      { key: 'landlord', text: 'clean text of an entry' },
    ]);
    assert.deepEqual(w.history, []);
    assert.deepEqual(w.prices, { near: '3.5' });
    assert.deepEqual(w.balances, { near: '300' });
    assert.deepEqual(w.book, [{ alias: 'accountant', key: 'near:accountant.testnet' }]);
    assert.equal(w.paste, null);
    assert.equal(w.paid402['https://vendor.example/report']?.requirements.amount !== undefined, true);
    // no entry carries a label: it comes from the tool table alone
    assert.ok(!JSON.stringify(w).includes('"label"'));
  } finally {
    t.rm();
  }
});

// ---- 6 and 7: the script ----
function runScript(dir: string): { status: number | null; out: string } {
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const r = spawnSync(TSX_BIN, ['src/scripts/check-cases.ts', '--dir', dir], { cwd: BENCH_DIR, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('6: check-cases on the 3-case fixture prints CASES OK 3 cases, 6 assertions', () => {
  const r = runScript('test/fixtures/cases');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trimEnd().split('\n').pop(), 'CASES OK 3 cases, 6 assertions');
});

test('7: a case whose expected tag is changed prints MISMATCH and exits 1', () => {
  const r = runScript('test/fixtures/cases-bad');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^MISMATCH T-A01 A2 gate expected escalate:OverTaskBound got escalate:OutsideTask$/m);
});

test('check-cases --files checks only the named file, and a name that matches no loaded file is reported', async () => {
  const cases = loadCases(FIXTURE_CASES);
  const file = join(FIXTURE_CASES, 'fixture.jsonl');
  const all = await checkCases(cases, { files: [file] });
  assert.deepEqual(all, { mismatches: [], assertions: 6, cases: 3 });
  const none = await checkCases(cases, { files: [join(FIXTURE_CASES, 'other.jsonl')] });
  assert.equal(none.cases, 0);
  assert.equal(none.assertions, 0);
  assert.match(none.mismatches.join('\n'), /^INVALID .*other\.jsonl no case file of that name was loaded$/);
});

test('check-cases reports a case whose static checks fail instead of running it', async () => {
  const bad = fixtureObject('T-U01');
  bad['reference']['plan'] = [{ let: 'x', call: 'not_a_tool' }];
  const result = await checkCases([fixtureCase('T-U06'), fixtureParse(bad)]);
  assert.equal(result.cases, 2);
  assert.equal(result.assertions, 2);
  assert.match(result.mismatches.join('\n'), /^INVALID T-U01 reference\.plan: /);
});
