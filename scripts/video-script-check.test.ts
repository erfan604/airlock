// Tests for scripts/video-script-check.ts (AIR-278). Run: node --test scripts/video-script-check.test.ts (Node 24) or pnpm tsx --test.
// Every test copies the passing fixture tree (scripts/fixtures/video-script/pass) to a temp folder, changes one thing and runs the
// checker with --root on that copy. The dossiers are read from the real $AIRLOCK_RESEARCH, so this file is not wired into
// scripts/check.sh: a reader of the public repository does not have that folder.
// The em dash is written as an escape on purpose: a literal one in a staged file is refused by the pre-commit hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fs.realpathSync(process.argv[1] ?? '.'));
const CHECKER = path.join(HERE, 'video-script-check.ts');
const LINT = path.join(HERE, 'claims-lint.ts');
const FIXTURE = path.join(HERE, 'fixtures', 'video-script', 'pass');
const RESEARCH = process.env['AIRLOCK_RESEARCH'] ?? path.join(os.homedir(), 'apps', 'airlock-research');
const EM = '\u2014';

type Tree = { tmp: string; root: string; script: string };
type Result = { code: number | null; out: string; lines: string[]; last: string; err: string; errLines: string[] };

function withTree(fn: (t: Tree) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-script-test-'));
  try {
    const root = path.join(tmp, 'root');
    fs.cpSync(FIXTURE, root, { recursive: true });
    fn({ tmp, root, script: path.join(root, 'docs', 'video-script.md') });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function execute(t: Tree, args: string[], env?: NodeJS.ProcessEnv): Result {
  const p = spawnSync(process.execPath, [CHECKER, ...args], { cwd: t.tmp, encoding: 'utf8', env: env ?? { ...process.env, AIRLOCK_RESEARCH: RESEARCH } });
  const out = p.stdout ?? '';
  const err = p.stderr ?? '';
  const lines = out.split('\n').filter((l) => l !== '');
  return { code: p.status, out, lines, last: lines[lines.length - 1] ?? '', err, errLines: err.split('\n').filter((l) => l !== '') };
}

function run(t: Tree, args: string[] = []): Result {
  return execute(t, ['--root', t.root, ...args]);
}

function show(res: Result): string {
  return 'exit ' + res.code + '\n' + res.lines.join('\n') + '\n' + res.err;
}

function rulesOf(res: Result): string[] {
  const set = new Set<string>();
  for (const l of res.lines) {
    const m = /^FINDING (\S+) /.exec(l);
    if (m !== null) set.add(m[1] ?? '');
  }
  return [...set].sort();
}

function findingsOf(res: Result, rule: string): string[] {
  return res.lines.filter((l) => l.startsWith('FINDING ' + rule + ' '));
}

function expectFail(res: Result, rule: string): void {
  assert.equal(res.code, 1, 'expected exit 1, got ' + show(res));
  assert.ok(rulesOf(res).includes(rule), 'expected a FINDING ' + rule + ' line in:\n' + show(res));
  assert.match(res.last, /^VIDEO SCRIPT FAIL \d+ findings$/);
}

function expectOnly(res: Result, rules: string[]): void {
  expectFail(res, rules[0] ?? '');
  assert.deepEqual(rulesOf(res), [...rules].sort(), 'unexpected rules in:\n' + show(res));
}

function expectOk(res: Result): void {
  assert.equal(res.code, 0, show(res));
  assert.match(res.last, /^VIDEO SCRIPT OK shots=\d+ seconds=\d+ words=\d+$/);
  assert.ok(!res.lines.some((l) => l.startsWith('FINDING ')), show(res));
}

function editFile(t: Tree, rel: string, fn: (s: string) => string): void {
  const p = path.join(t.root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  assert.notEqual(after, before, 'the edit changed nothing in ' + rel);
  fs.writeFileSync(p, after);
}

function swap(t: Tree, from: string, to: string): void {
  editFile(t, 'docs/video-script.md', (s) => {
    assert.ok(s.includes(from), 'the fixture script has no text ' + from);
    return s.replace(from, to);
  });
}

function dropLines(t: Tree, prefix: string): void {
  editFile(t, 'docs/video-script.md', (s) => s.split('\n').filter((l) => !l.startsWith(prefix)).join('\n'));
}

// The five locked shots of the real script are every shot but S02 and S06; the hash is the one AIR-282 check 5 computes with awk.
function lockHash(file: string): string {
  const p = spawnSync('awk', ['/^SHOT /{keep = ($2 !~ /^(S02|S06)$/)} keep', file]);
  return crypto.createHash('sha256').update(p.stdout).digest('hex');
}

function setLine2(t: Tree, value?: string): void {
  editFile(t, 'docs/video-script.md', (s) => {
    const lines = s.split('\n');
    lines[1] = value ?? 'FIRST FIVE LOCKED 2026-11-10 sha256 ' + lockHash(t.script);
    return lines.join('\n');
  });
}

// Leave the shots in ids with their SHOT and RUN lines only.
function bare(t: Tree, ids: string[]): void {
  editFile(t, 'docs/video-script.md', (s) => {
    let cur = '';
    const kept: string[] = [];
    for (const l of s.split('\n')) {
      const m = /^SHOT (\S+) /.exec(l);
      if (m !== null) cur = m[1] ?? '';
      if (ids.includes(cur) && /^(CAP|SCREEN|VOICE) /.test(l)) continue;
      kept.push(l);
    }
    return kept.join('\n');
  });
}

// One VOICE line after every CAP line, equal to the caption text, except the cue ids in skip.
function addVoice(t: Tree, skip: string[] = [], change: { cue: string; text: string } | null = null): void {
  editFile(t, 'docs/video-script.md', (s) => {
    const out: string[] = [];
    for (const l of s.split('\n')) {
      out.push(l);
      const m = /^CAP (\S+) \S+ \[[^\]]*\] (.*)$/.exec(l);
      if (m === null) continue;
      const cue = m[1] ?? '';
      if (skip.includes(cue)) continue;
      out.push('VOICE ' + cue + ' ' + (change !== null && change.cue === cue ? change.text : (m[2] ?? '')));
    }
    return out.join('\n');
  });
}

function captionWords(file: string): number {
  let n = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^CAP \S+ \S+ \[[^\]]*\] (.*)$/.exec(l);
    if (m !== null) n += (m[1] ?? '').split(/\s+/).filter((w) => w !== '').length;
  }
  return n;
}

const EXPLORER_URL = 'https://testnet.nearblocks.io/txns/FixtureTwinTxHashAAAAAAAAAAAAAAAAAAAAAAAA';

// ---------- the first fourteen: a draft that must fail, and the script that passes ----------

test('the pass fixture passes with a first line LOCKED and no flag', () => {
  withTree((t) => {
    const res = run(t);
    expectOk(res);
    assert.equal(res.last, 'VIDEO SCRIPT OK shots=8 seconds=145 words=' + captionWords(t.script));
  });
});

test('lint: a caption with a banned phrase fails', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card is unhackable');
    const res = run(t);
    expectOnly(res, ['lint']);
    assert.match(findingsOf(res, 'lint')[0] ?? '', /^FINDING lint \S+docs\/video-script\.md:\d+ 3 /);
  });
});

test('number: a caption with a number that is in no BENCH line fails', () => {
  withTree((t) => {
    swap(t, 'capped baseline: 2 of 10 attack runs succeed', 'capped baseline: 37 of 10 attack runs succeed');
    expectOnly(run(t), ['lint', 'number']);
  });
});

test('pacing: a caption at 4 words per second fails', () => {
  withTree((t) => {
    swap(t, 'CAP S02a 0:10-0:14 ', 'CAP S02a 0:10-0:12 ');
    expectOnly(run(t), ['pacing']);
  });
});

test('pacing: a caption of 14 words fails', () => {
  withTree((t) => {
    // 14 words in 7 s is 2.0 words per second, so only the word cap fails
    swap(t, 'CAP S02b 0:14-0:18 [BENCH:V1-tight/benign] capped baseline pays 6 of 10 real invoices', 'CAP S02b 0:14-0:21 [BENCH:V1-tight/benign] capped baseline with an allowance that the owner really chose before the task began');
    dropLines(t, 'CAP S02c ');
    dropLines(t, 'CAP S02d ');
    const res = run(t);
    expectOnly(res, ['pacing']);
    assert.ok(findingsOf(res, 'pacing').some((l) => /14 words/.test(l)), show(res));
    assert.equal(findingsOf(res, 'pacing').length, 1, show(res));
  });
});

test('screen: a SCREEN string that is not in the code fails', () => {
  withTree((t) => {
    swap(t, 'SCREEN S04a "Fixture plan preview"', 'SCREEN S04a "Fixture plan preview, edited"');
    expectOnly(run(t), ['screen']);
  });
});

test('untrusted: the word UntrustedAmount in the live correction shot fails', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card UntrustedAmount reason');
    expectOnly(run(t), ['untrusted']);
  });
});

test('say: a part that differs from the dossier line fails', () => {
  withTree((t) => {
    swap(t, 'We built the gate the way AWS', 'We built the door the way AWS');
    expectOnly(run(t), ['say']);
  });
});

test('say: a Say line with part 3 missing fails', () => {
  withTree((t) => {
    dropLines(t, 'CAP S05c ');
    expectOnly(run(t), ['say']);
  });
});

test('mode-words: a REPLAY shot whose captions do not say replay or recorded fails', () => {
  withTree((t) => {
    swap(t, 'recorded tamper attempt, reverted by contract', 'tamper attempt, reverted by contract');
    expectOnly(run(t), ['mode-words']);
  });
});

test('mode-words: a LIVE shot whose caption says replay fails', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card held for the replay correction');
    expectOnly(run(t), ['mode-words']);
  });
});

test('tee: a TEE sentence without the registration row fails', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'TEE card held for the correction');
    expectOnly(run(t), ['tee']);
  });
});

test('contiguous: shots with a gap fail', () => {
  withTree((t) => {
    swap(t, 'SHOT S03 0:25-0:50', 'SHOT S03 0:26-0:50');
    expectOnly(run(t), ['contiguous']);
  });
});

test('total: a script of 160 seconds fails', () => {
  withTree((t) => {
    swap(t, 'SHOT S07 2:15-2:25', 'SHOT S07 2:15-2:40');
    expectOnly(run(t), ['total']);
  });
});

// ---------- the lock rule and the bare blocks ----------

test('lock: a valid line 2 passes, and one word changed in S03 fails with lock', () => {
  withTree((t) => {
    setLine2(t);
    expectOk(run(t));
  });
  withTree((t) => {
    setLine2(t);
    swap(t, 'vanilla agent, run 2', 'vanilla robot, run 2');
    expectOnly(run(t), ['lock']);
  });
});

test('lock: a line 2 that is not the lock form fails, and a shot SHOT line on line 2 is not a lock line', () => {
  withTree((t) => {
    setLine2(t, 'FIRST FIVE LOCKED 2026-11-10 sha256 abc');
    expectOnly(run(t), ['lock']);
  });
  withTree((t) => {
    setLine2(t, 'some other text');
    expectOnly(run(t), ['lock']);
  });
  withTree((t) => {
    editFile(t, 'docs/video-script.md', (s) => s.replace('\n\n', '\n'));
    expectOk(run(t));
  });
});

test('lock: S02 and S06 left bare pass under --draft, the lock hash still matches, and fail without the flag', () => {
  withTree((t) => {
    setLine2(t);
    bare(t, ['S02', 'S06']);
    const res = run(t, ['--draft']);
    expectOk(res);
    assert.equal(res.last, 'VIDEO SCRIPT OK shots=8 seconds=145 words=' + String(captionWords(t.script)));
    expectOnly(run(t), ['lock']);
  });
});

test('lock: any other bare shot is a finding even under --draft', () => {
  withTree((t) => {
    bare(t, ['S03']);
    expectOnly(run(t, ['--draft']), ['lock']);
  });
});

// ---------- one test for each rule and flag the first fourteen leave bare ----------

test('inside: a caption that starts after its shot ends fails', () => {
  withTree((t) => {
    swap(t, 'CAP S07b 2:20-2:24 ', 'CAP S07b 2:26-2:29 ');
    expectOnly(run(t), ['inside']);
  });
});

test('overlap: two captions that overlap fail', () => {
  withTree((t) => {
    swap(t, 'CAP S04c 1:00-1:05 ', 'CAP S04c 0:59-1:05 ');
    expectOnly(run(t), ['overlap']);
  });
});

test('tag: a caption with no tag fails', () => {
  withTree((t) => {
    swap(t, '[DESC] Fixture stamp one on the April invoice', 'Fixture stamp one on the April invoice');
    expectOnly(run(t), ['tag']);
  });
});

test('tag: a caption with two tags fails', () => {
  withTree((t) => {
    swap(t, '[DESC] Fixture stamp one on the April invoice', '[DESC] [SRC:S1] Fixture stamp one on the April invoice');
    expectOnly(run(t), ['tag']);
  });
});

test('tag: an invalid tag form, a DESC of more than eight words, a DESC with a claim verb and a tag with no row fail', () => {
  withTree((t) => {
    swap(t, '[DESC] Fixture stamp one on the April invoice', '[NOTE] Fixture stamp one on the April invoice');
    expectOnly(run(t), ['tag']);
  });
  withTree((t) => {
    swap(t, 'CAP S04e 1:10-1:14 [DESC] Fixture stamp one on the April invoice', 'CAP S04e 1:10-1:15 [DESC] Fixture stamp one on the April invoice and the card too');
    expectOnly(run(t), ['tag']);
  });
  withTree((t) => {
    swap(t, '[DESC] Fixture stamp one on the April invoice', '[DESC] Fixture stamp one only on the April invoice');
    expectOnly(run(t), ['tag']);
  });
  withTree((t) => {
    swap(t, '[EV:Harness counts]', '[EV:No such section]');
    expectOnly(run(t), ['number', 'tag']);
  });
  withTree((t) => {
    swap(t, '[SRC:S2]', '[SRC:S9]');
    expectOnly(run(t), ['number', 'tag']);
  });
});

test('tag: a tag that does not come right after the time range, and a cue id used twice, fail', () => {
  withTree((t) => {
    swap(t, '[DESC] Fixture stamp one on the April invoice', 'Fixture stamp [DESC] one on the April invoice');
    expectOnly(run(t), ['tag']);
  });
  withTree((t) => {
    swap(t, 'CAP S04f 1:15-1:19 ', 'CAP S04e 1:15-1:19 ');
    expectOnly(run(t), ['tag']);
  });
});

test('screen-fmt: a template that is not in the code fails', () => {
  withTree((t) => {
    swap(t, '"Fixture pays {amount} {symbol} to {to}?"', '"Fixture pays {amount} {symbol} toward {to}?"');
    expectOnly(run(t), ['screen-fmt']);
  });
});

test('screen-fmt: an amount that differs from the recorded view fails, and so does a symbol other than NEAR and a missing value', () => {
  withTree((t) => {
    swap(t, 'amount=9.4', 'amount=9.5');
    expectOnly(run(t), ['screen-fmt']);
  });
  withTree((t) => {
    swap(t, 'symbol=NEAR', 'symbol=ETH');
    expectOnly(run(t), ['screen-fmt']);
  });
  withTree((t) => {
    swap(t, ' to=near:accountant.fixture.testnet', '');
    expectOnly(run(t), ['screen-fmt']);
  });
  withTree((t) => {
    swap(t, 'to=near:accountant.fixture.testnet', 'to=near:other.fixture.testnet');
    expectOnly(run(t), ['screen-fmt']);
  });
});

test('screen-fmt: the amount is compared as an integer of 24 decimals, so 9.40 equals the recorded 9400000000000000000000000', () => {
  withTree((t) => {
    swap(t, 'amount=9.4', 'amount=9.40');
    expectOk(run(t));
  });
});

test('screen: a SCREEN-DATA file that does not exist fails', () => {
  withTree((t) => {
    swap(t, 'SCREEN-DATA S04d fixtures/world.jsonl', 'SCREEN-DATA S04d fixtures/missing.jsonl');
    expectOnly(run(t), ['screen']);
  });
});

test('screen: a string found only under contracts/*/src, runtime/src or scripts passes, and one found nowhere fails', () => {
  withTree((t) => {
    swap(t, 'SCREEN S04i "Fixture contract event line"', 'SCREEN S04i "Fixture contract event line missing"');
    expectOnly(run(t), ['screen']);
  });
  withTree((t) => {
    editFile(t, 'docs/video-script.md', (s) => s.replace('SCREEN S04i "Fixture contract event line"', 'SCREEN S04i "fixture demo line"'));
    expectOk(run(t));
  });
});

test('screen: a root under a folder that an outer .gitignore ignores still searches its own files', () => {
  withTree((t) => {
    // the product repo ignores target/, and acceptance check 3 of AIR-278 runs on a copy under target/: git must not read that rule
    const outer = path.join(t.tmp, 'outer');
    fs.mkdirSync(path.join(outer, 'target'), { recursive: true });
    fs.writeFileSync(path.join(outer, '.gitignore'), 'target/\n');
    const init = spawnSync('git', ['init', '-q', outer], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const inner = path.join(outer, 'target', 'v278');
    fs.cpSync(t.root, inner, { recursive: true });
    expectOk(execute(t, ['--root', inner]));
    // and a string that is not in that tree is still not found
    swap(t, 'SCREEN S04a "Fixture plan preview"', 'SCREEN S04a "Fixture plan preview, edited"');
    fs.cpSync(t.root, inner, { recursive: true });
    expectOnly(execute(t, ['--root', inner]), ['screen']);
  });
});

test('last-shot: a last shot without pnpm i && pnpm demo fails', () => {
  withTree((t) => {
    swap(t, 'RUN pnpm i && pnpm demo', 'RUN pnpm demo');
    expectOnly(run(t), ['last-shot']);
  });
});

test('last-shot: a last shot without the repository URL fails, and the URL on a CAP line is enough', () => {
  withTree((t) => {
    swap(t, 'RUN open https://github.com/fixture-owner/fixture-repo\n', '');
    expectOnly(run(t), ['last-shot']);
  });
  withTree((t) => {
    swap(t, 'RUN open https://github.com/fixture-owner/fixture-repo\n', '');
    swap(t, '[DESC] Built at NEAR HACKATHON', '[DESC] https://github.com/fixture-owner/fixture-repo');
    expectOk(run(t));
  });
});

test('explorer: a RUN explorer URL that is not in EVIDENCE fails', () => {
  withTree((t) => {
    swap(t, 'RUN open ' + EXPLORER_URL, 'RUN open ' + EXPLORER_URL.replace('AAAAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB'));
    expectOnly(run(t), ['explorer']);
  });
});

test('number: a GOLDEN caption with run 5 of 3 while the file says 2 of 3 fails', () => {
  withTree((t) => {
    swap(t, 'vanilla agent, run 2 of 3', 'vanilla agent, run 5 of 3');
    const res = run(t);
    expectOnly(res, ['number']);
    assert.ok(findingsOf(res, 'number').some((l) => /run 5 of 3/.test(l)), show(res));
  });
});

test('number: run k of N with a golden file that has no run key is read as text of the file', () => {
  withTree((t) => {
    editFile(t, 'bench/golden/twin.json', (s) => s.replace(/"run": \{[^}]*\},/, '"note": "run 2 of 3",').replace('"note": null', '"extra": null'));
    expectOk(run(t));
  });
  withTree((t) => {
    editFile(t, 'bench/golden/twin.json', (s) => s.replace(/"run": \{[^}]*\},/, '').replace('"note": null', '"note": "run 2 of 4 with 3 retries"'));
    const res = run(t);
    expectOnly(res, ['number']);
    assert.ok(findingsOf(res, 'number').some((l) => /has no run key and no such text/.test(l)), show(res));
  });
});

test('number: a hex token is a prefix of one txs hash, with or without 0x', () => {
  const hash = '0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const withBaseTx = (t: Tree): void => {
    editFile(t, 'bench/golden/twin.json', (s) => s.replace('"txs": [', '"txs": [\n    { "chain": "base", "label": "broadcast", "hash": "' + hash + '", "status": "success", "url": "https://sepolia.basescan.org/tx/' + hash + '" },'));
  };
  withTree((t) => {
    withBaseTx(t);
    swap(t, 'the correction, not the 4.2 NEAR invoice', 'base transaction 0xa1b2c3d4e5f6 paid');
    expectOk(run(t));
  });
  withTree((t) => {
    withBaseTx(t);
    swap(t, 'the correction, not the 4.2 NEAR invoice', 'base transaction a1b2c3d4e5f6 paid');
    expectOk(run(t));
  });
  withTree((t) => {
    withBaseTx(t);
    swap(t, 'the correction, not the 4.2 NEAR invoice', 'base transaction 0xa1b2c3ffffff paid');
    expectOnly(run(t), ['number']);
  });
  withTree((t) => {
    swap(t, 'the correction, not the 4.2 NEAR invoice', 'the decade correction paid');
    expectOk(run(t));
  });
});

test('number: a DESC caption with a number fails, a SAY caption is exempt, and the number must be in its own row', () => {
  withTree((t) => {
    swap(t, 'Fixture stamp one on the April invoice', 'Fixture stamp one on the 4.2 invoice');
    expectOnly(run(t), ['number']);
  });
  withTree((t) => {
    swap(t, 'capped baseline: 2 of 10 attack runs succeed', 'capped baseline: 6 of 10 attack runs succeed');
    expectOnly(run(t), ['number']);
  });
  withTree((t) => {
    swap(t, 'KANI OK: 36 harnesses', 'KANI OK: 37 harnesses');
    expectOnly(run(t), ['lint', 'number']);
  });
  withTree((t) => {
    swap(t, 'reported loss, $150K to $204K, depending on the source', 'reported loss, about $2.0 billion');
    expectOnly(run(t), ['number']);
  });
});

test('number: BENCH tags that name no row or no header line fail with tag, and with number when the caption holds numbers', () => {
  withTree((t) => {
    swap(t, '[BENCH:V1-tight/ALL]', '[BENCH:V9/ALL]');
    expectOnly(run(t), ['number', 'tag']);
  });
  withTree((t) => {
    editFile(t, 'docs/BENCH.md', (s) => s.replace('model fixture-model, quarantine fixture-small, n 10, hooks product, runs 70\n', ''));
    expectOnly(run(t), ['number', 'tag']);
  });
  withTree((t) => {
    swap(t, '[BENCH:V1-tight/ALL] capped baseline: 2 of 10 attack runs succeed', '[BENCH:V9/ALL] capped baseline is not listed');
    expectOnly(run(t), ['tag']);
  });
});

test('voice: a VOICE line whose text differs from its CAP fails', () => {
  withTree((t) => {
    addVoice(t, [], { cue: 'S04e', text: 'Fixture stamp one on the March invoice' });
    expectOnly(run(t), ['voice']);
  });
});

test('voice: a CAP with no VOICE line while the others have one fails', () => {
  withTree((t) => {
    addVoice(t, ['S04e']);
    expectOnly(run(t), ['voice']);
  });
});

test('voice: a VOICE line for a cue that has no CAP fails, and VOICE lines equal to every CAP pass', () => {
  withTree((t) => {
    addVoice(t);
    expectOk(run(t));
  });
  withTree((t) => {
    addVoice(t);
    editFile(t, 'docs/video-script.md', (s) => s + 'VOICE S99a words nobody reads\n');
    expectOnly(run(t), ['voice']);
  });
});

test('draft: a first line DRAFT without the flag fails, and passes with --draft', () => {
  withTree((t) => {
    swap(t, 'LOCKED 2026-11-10', 'DRAFT');
    expectOnly(run(t), ['draft']);
    const res = run(t, ['--draft']);
    expectOk(res);
  });
});

test('draft: a line 1 LOCKED with no date or an impossible date is a finding even under --draft', () => {
  withTree((t) => {
    swap(t, 'LOCKED 2026-11-10', 'LOCKED soon');
    expectOnly(run(t, ['--draft']), ['draft']);
  });
  withTree((t) => {
    swap(t, 'LOCKED 2026-11-10', 'LOCKED 2026-13-45');
    expectOnly(run(t), ['draft']);
  });
});

test('draft: --draft keeps every other rule on', () => {
  withTree((t) => {
    swap(t, 'LOCKED 2026-11-10', 'DRAFT');
    swap(t, 'SHOT S03 0:25-0:50', 'SHOT S03 0:26-0:50');
    expectOnly(run(t, ['--draft']), ['contiguous']);
  });
});

test('--say F99 exits 1 with a finding on stderr and nothing on stdout', () => {
  withTree((t) => {
    const res = execute(t, ['--say', 'F99']);
    assert.equal(res.code, 1, show(res));
    assert.equal(res.out, '');
    assert.ok(res.errLines.some((l) => l.startsWith('FINDING say ')), show(res));
  });
});

test('--say F08 prints the two dossier lines joined on one line without the quote marks, and needs no script', () => {
  withTree((t) => {
    const res = execute(t, ['--say', 'F08', '--root', path.join(t.tmp, 'no-such-root')]);
    assert.equal(res.code, 0, show(res));
    assert.equal(res.out, 'We built the gate the way AWS built Cedar: a Lean model with proofs, Kani on the Rust that ships, and differential tests between the two, and we test the proofs themselves with covers and mutants.\n');
    assert.equal(res.err, '');
  });
});

test('--say F09 drops the note after the closing quote mark, and F12 joins its two lines', () => {
  withTree((t) => {
    const f09 = execute(t, ['--say', 'F09']);
    assert.equal(f09.out, 'Untrusted data cannot decide whether a payment happens or who gets it; if it influenced the branch, you are asked.\n');
    const f12 = execute(t, ['--say', 'F12']);
    assert.equal(f12.code, 0, show(f12));
    assert.match(f12.out, /^Every number comes with utility, attack success and how often you would be asked, against the baselines V0, V1 and V1-tight, .* intervals, and you can replay it without keys\.\n$/);
    assert.equal(f12.out.split('\n').length, 2);
  });
});

test('--say without a research folder is INPUT MISSING and exit 2', () => {
  withTree((t) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['AIRLOCK_RESEARCH'];
    const res = execute(t, ['--say', 'F08'], env);
    assert.equal(res.code, 2, show(res));
    assert.ok(res.errLines.some((l) => l.startsWith('INPUT MISSING ')), show(res));
  });
});

test('--links prints each RUN URL once, in script order, when two RUN lines repeat it', () => {
  withTree((t) => {
    swap(t, 'RUN open ' + EXPLORER_URL + '\n', 'RUN open ' + EXPLORER_URL + '\nRUN open ' + EXPLORER_URL + '\n');
    const res = run(t, ['--links']);
    assert.equal(res.code, 0, show(res));
    assert.deepEqual(res.lines, ['https://example.org/fixture-loss-report', EXPLORER_URL, 'https://github.com/fixture-owner/fixture-repo']);
    assert.equal(res.err, '');
  });
});

test('--links with a finding still prints the URLs on stdout, findings go to stderr and the exit code is 1', () => {
  withTree((t) => {
    swap(t, 'SHOT S03 0:25-0:50', 'SHOT S03 0:26-0:50');
    const res = run(t, ['--links']);
    assert.equal(res.code, 1, show(res));
    assert.ok(res.lines.every((l) => l.startsWith('https://')), show(res));
    assert.ok(res.errLines.some((l) => l.startsWith('FINDING contiguous ')), show(res));
    assert.match(res.errLines[res.errLines.length - 1] ?? '', /^VIDEO SCRIPT FAIL \d+ findings$/);
  });
});

test('--json twice gives the same bytes, with the keys and the order of the contract', () => {
  withTree((t) => {
    const a = run(t, ['--json']);
    const b = run(t, ['--json']);
    assert.equal(a.code, 0, show(a));
    assert.equal(a.out, b.out);
    assert.equal(crypto.createHash('sha256').update(a.out).digest('hex'), crypto.createHash('sha256').update(b.out).digest('hex'));
    assert.ok(a.out.endsWith('}\n'));
    assert.ok(a.out.startsWith('{\n  "seconds": 145,\n  "shots": [\n    {\n      "shot": "S01",'), a.out.slice(0, 120));
    const j = JSON.parse(a.out) as { seconds: number; shots: Record<string, unknown>[]; cues: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(j), ['seconds', 'shots', 'cues']);
    assert.equal(j.seconds, 145);
    assert.deepEqual(j.shots.map((s) => s['shot']), ['S01', 'S02', 'S03', 'S04', 'S08', 'S05', 'S06', 'S07']);
    assert.deepEqual(Object.keys(j.shots[0] ?? {}), ['shot', 'mode', 'start', 'end']);
    assert.deepEqual(j.shots[3], { shot: 'S04', mode: 'LIVE-CONSOLE', start: 50, end: 85 });
    assert.deepEqual(Object.keys(j.cues[0] ?? {}), ['shot', 'cue', 'start', 'end', 'text', 'voice']);
    const s04b = j.cues.find((c) => c['cue'] === 'S04b');
    assert.deepEqual(s04b, { shot: 'S04', cue: 'S04b', start: 55, end: 60, text: 'The NEAR contract that holds signing authority checks where each', voice: null });
    assert.equal(j.cues.length, 24);
  });
});

test('--json carries the text of the VOICE line for the cue, and null for every cue of a captions-only script', () => {
  withTree((t) => {
    const plain = JSON.parse(run(t, ['--json']).out) as { cues: { voice: string | null }[] };
    assert.ok(plain.cues.every((c) => c.voice === null));
    addVoice(t);
    const res = run(t, ['--json']);
    assert.equal(res.code, 0, show(res));
    const j = JSON.parse(res.out) as { cues: { cue: string; text: string; voice: string | null }[] };
    assert.equal(j.cues.length, 24);
    assert.ok(j.cues.every((c) => c.voice === c.text));
  });
});

test('--json with a finding still prints the payload, with the findings on stderr and exit 1', () => {
  withTree((t) => {
    swap(t, 'SHOT S07 2:15-2:25', 'SHOT S07 2:15-2:40');
    const res = run(t, ['--json']);
    assert.equal(res.code, 1, show(res));
    assert.equal((JSON.parse(res.out) as { seconds: number }).seconds, 160);
    assert.ok(res.errLines.some((l) => l.startsWith('FINDING total ')), show(res));
  });
});

test('lint step: a SHOT line with a clock time and a RUN line with --no-open pass, though the lint fails the raw script', () => {
  withTree((t) => {
    const raw = spawnSync(process.execPath, [LINT, '--file', t.script, '--docs', path.join(t.root, 'docs')], { cwd: t.tmp, encoding: 'utf8' });
    assert.equal(raw.status, 1, 'the claims lint should reject the raw script:\n' + raw.stdout);
    assert.match(raw.stdout, /^FINDING 6 .*:\d+ double hyphen in prose$/m);
    assert.match(raw.stdout, /^FINDING 5 /m);
    const res = run(t);
    expectOk(res);
    assert.ok(fs.readFileSync(t.script, 'utf8').includes('RUN pnpm demo --no-open'));
  });
});

test('lint step: an em dash, a double hyphen and a number in a SCREEN string are findings with the line of the script', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card ' + EM + ' held');
    const line = fs.readFileSync(t.script, 'utf8').split('\n').findIndex((l) => l.startsWith('CAP S04f ')) + 1;
    const res = run(t);
    expectOnly(res, ['lint']);
    assert.equal(findingsOf(res, 'lint')[0], 'FINDING lint ' + t.script + ':' + line + ' 6 em dash in prose');
  });
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card ' + '-'.repeat(2) + ' held');
    expectOnly(run(t), ['lint']);
  });
  withTree((t) => {
    swap(t, '"Fixture reason sentence for the held request."', '"Fixture reason sentence for the held 1234 request."');
    expectOnly(run(t), ['lint', 'screen']);
  });
});

test('lint step: a payload marker written at run time is a lint finding, and a marker file that no line matches passes', () => {
  withTree((t) => {
    fs.mkdirSync(path.join(t.root, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'fixtures', 'payload-markers.txt'), 'zz-fixture-marker-phrase\n');
    expectOk(run(t));
    swap(t, 'Fixture stamp one on the April invoice', 'Fixture stamp ZZ-fixture-marker-phrase one');
    const res = run(t);
    expectOnly(res, ['lint']);
    assert.match(findingsOf(res, 'lint')[0] ?? '', / 7 /);
  });
});

test('lint step: a missing doc that the lint needs is a lint finding with the lint exit code in its text', () => {
  withTree((t) => {
    fs.rmSync(path.join(t.root, 'docs', 'PRIOR_ART.md'));
    const res = run(t);
    expectFail(res, 'lint');
    assert.ok(findingsOf(res, 'lint').some((l) => /exited 2/.test(l)), show(res));
  });
});

test('INPUT MISSING: a missing script exits 2 with the path as the only line, a missing doc that a rule needs as the last line', () => {
  withTree((t) => {
    const nope = path.join(t.tmp, 'nope.md');
    const res = execute(t, ['--root', t.root, '--file', nope]);
    assert.equal(res.code, 2, show(res));
    assert.deepEqual(res.lines, ['INPUT MISSING ' + nope]);
  });
  withTree((t) => {
    fs.rmSync(path.join(t.root, 'docs', 'SOURCES.md'));
    const res = run(t);
    assert.equal(res.code, 2, show(res));
    assert.equal(res.last, 'INPUT MISSING ' + path.join(t.root, 'docs', 'SOURCES.md'));
  });
  withTree((t) => {
    fs.rmSync(path.join(t.root, 'runtime', 'recordings'), { recursive: true });
    const res = run(t);
    assert.equal(res.code, 2, show(res));
    assert.equal(res.last, 'INPUT MISSING ' + path.join(t.root, 'runtime', 'recordings', 'chain', 'b01-escalate.json'));
  });
  withTree((t) => {
    fs.rmSync(path.join(t.root, 'bench', 'golden', 'twin.json'));
    const res = run(t);
    assert.equal(res.code, 2, show(res));
    assert.equal(res.last, 'INPUT MISSING ' + path.join(t.root, 'bench', 'golden', 'twin.json'));
  });
});

test('INPUT MISSING: a rule that is not used does not need its file', () => {
  withTree((t) => {
    fs.rmSync(path.join(t.root, 'fixtures'), { recursive: true });
    dropLines(t, 'SCREEN-DATA ');
    swap(t, 'CAP S03a 0:26-0:31 [GOLDEN:twin] vanilla agent, run 2 of 3: paid 9.4 NEAR', 'CAP S03a 0:26-0:31 [DESC] vanilla agent shown');
    swap(t, 'CAP S03b 0:32-0:37 [GOLDEN:twin] the correction, not the 4.2 NEAR invoice', 'CAP S03b 0:32-0:37 [DESC] correction shown');
    expectOk(run(t));
  });
});

test('--file reads another script file while --root still holds the docs', () => {
  withTree((t) => {
    const other = path.join(t.tmp, 'other.md');
    fs.writeFileSync(other, fs.readFileSync(t.script, 'utf8').replace('SHOT S03 0:25-0:50', 'SHOT S03 0:26-0:50'));
    const res = execute(t, ['--root', t.root, '--file', other]);
    expectFail(res, 'contiguous');
    assert.ok(findingsOf(res, 'contiguous')[0]?.startsWith('FINDING contiguous ' + other + ':'), show(res));
    expectOk(run(t));
  });
});

test('the default root is the folder above the checker, the lint is the one next to the checker and never the root scripts one', () => {
  withTree((t) => {
    const repo = path.join(t.tmp, 'repo');
    fs.cpSync(t.root, repo, { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(CHECKER, path.join(repo, 'scripts', 'video-script-check.ts'));
    fs.copyFileSync(LINT, path.join(repo, 'scripts', 'claims-lint.ts'));
    for (const f of ['claim-verbs.txt', 'banned-phrases.txt', 'numbers-allowlist.txt']) fs.copyFileSync(path.join(HERE, '..', 'docs', f), path.join(repo, 'docs', f));
    const go = (): Result => {
      const p = spawnSync(process.execPath, [path.join(repo, 'scripts', 'video-script-check.ts')], { cwd: repo, encoding: 'utf8', env: { ...process.env, AIRLOCK_RESEARCH: RESEARCH } });
      const lines = (p.stdout ?? '').split('\n').filter((l) => l !== '');
      return { code: p.status, out: p.stdout ?? '', lines, last: lines[lines.length - 1] ?? '', err: p.stderr ?? '', errLines: [] };
    };
    expectOk(go());
    // a lint planted in the root scripts folder is never used: the checker's own copy decides
    fs.writeFileSync(path.join(repo, 'scripts', 'claims-lint.ts'), 'process.stdout.write("CLAIMS LINT FAIL 0 findings\\n");\nprocess.exitCode = 1;\n');
    const planted = go();
    assert.equal(planted.code, 1, 'the checker next to the planted lint uses that lint:\n' + show(planted));
    const own = execute(t, ['--root', repo]);
    expectOk(own);
  });
});

test('modes: every mode of AIR-248 is accepted and an unknown mode is a finding', () => {
  withTree((t) => {
    swap(t, 'SHOT S04 0:50-1:25 mode LIVE-CONSOLE', 'SHOT S04 0:50-1:25 mode LIVE-SCRIPT');
    expectOk(run(t));
  });
  withTree((t) => {
    swap(t, 'SHOT S04 0:50-1:25 mode LIVE-CONSOLE', 'SHOT S04 0:50-1:25 mode LIVE-SOMETHING');
    expectOnly(run(t), ['mode-words']);
  });
  withTree((t) => {
    swap(t, 'SHOT S04 0:50-1:25 mode LIVE-CONSOLE', 'SHOT S04 0:50-1:25 LIVE-CONSOLE');
    expectFail(run(t), 'contiguous');
  });
});

test('mode-words: a REPLAY shot passes with the word replay or recorded in any case, and a LIVE shot may say recorded nowhere', () => {
  withTree((t) => {
    swap(t, 'recorded tamper attempt, reverted by contract', 'Replay of a tamper attempt, reverted');
    expectOk(run(t));
  });
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card of a recorded run');
    expectOnly(run(t), ['mode-words']);
  });
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'Fixture card for replayed runs');
    expectOk(run(t));
  });
});

test('tee: the registration row with a nearblocks transaction link lets a TEE caption pass', () => {
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'TEE card held for the correction');
    editFile(t, 'docs/EVIDENCE.md', (s) => s.replace('\n## Harness counts', '| TEE registration tx | testnet | https://testnet.nearblocks.io/txns/FixtureTeeTx | 2026-11-09 |\n\n## Harness counts'));
    expectOk(run(t));
  });
  withTree((t) => {
    swap(t, 'Fixture card held for the correction', 'TEE card held for the correction');
    editFile(t, 'docs/EVIDENCE.md', (s) => s.replace('\n## Harness counts', '| TEE registration tx | testnet | pending | 2026-11-09 |\n\n## Harness counts'));
    expectOnly(run(t), ['tee']);
  });
});

test('tee: a caption tagged with a part of the F07 line needs the registration row even without the word TEE', () => {
  const f07 = 'CAP S04f 1:15-1:20 [SAY:F07#3/3] we pin the one approved machine and re-check it daily.';
  withTree((t) => {
    swap(t, 'CAP S04f 1:15-1:19 [DESC] Fixture card held for the correction', f07);
    const res = run(t);
    assert.ok(rulesOf(res).includes('tee'), show(res));
  });
  withTree((t) => {
    swap(t, 'CAP S04f 1:15-1:19 [DESC] Fixture card held for the correction', f07);
    editFile(t, 'docs/EVIDENCE.md', (s) => s.replace('\n## Harness counts', '| TEE registration tx | testnet | https://testnet.nearblocks.io/txns/FixtureTeeTx | 2026-11-09 |\n\n## Harness counts'));
    const res = run(t);
    assert.ok(!rulesOf(res).includes('tee'), show(res));
  });
});

test('pacing: a caption on screen less than 1.8 s fails', () => {
  withTree((t) => {
    swap(t, 'CAP S04g 1:20-1:24 [DESC] Fixture reason sentence under the card', 'CAP S04g 1:20-1:21.5 [DESC] Fixture reason shown');
    const res = run(t);
    expectOnly(res, ['pacing']);
    assert.match(findingsOf(res, 'pacing')[0] ?? '', /minimum is 1\.8 s/);
  });
  withTree((t) => {
    swap(t, 'CAP S04g 1:20-1:24 [DESC] Fixture reason sentence under the card', 'CAP S04g 1:20-1:21.8 [DESC] Fixture reason shown');
    expectOk(run(t));
  });
});

test('pacing: the cap is exact, 12 words in 5.3 s passes at 2.3 words per second and 12 words in 5.2 s fails', () => {
  const twelve = 'wa wb wc wd we wf wg wh wi wj wk wl';
  const long = (t: Tree, range: string): void => {
    swap(t, 'CAP S02b 0:14-0:18 [BENCH:V1-tight/benign] capped baseline pays 6 of 10 real invoices', 'CAP S02b ' + range + ' [BENCH:V1-tight/benign] ' + twelve);
    dropLines(t, 'CAP S02c ');
    dropLines(t, 'CAP S02d ');
  };
  withTree((t) => {
    long(t, '0:14-0:19.3');
    expectOk(run(t));
  });
  withTree((t) => {
    long(t, '0:14-0:19.2');
    expectOnly(run(t), ['pacing']);
  });
});

test('say: a whole [SAY:F11] caption must equal the line, and a part of a different dossier is read from that dossier', () => {
  withTree((t) => {
    swap(t, "Receipts include the model provider's signed response, evidence a verifier can check.", "Receipts include the model provider's signed response, evidence a reader can check.");
    expectOnly(run(t), ['say']);
  });
  withTree((t) => {
    swap(t, '[SAY:F01#2/3]', '[SAY:F01#3/3]');
    expectOnly(run(t), ['say']);
  });
  withTree((t) => {
    swap(t, '[SAY:F01#1/3]', '[SAY:F99#1/3]');
    expectFail(run(t), 'say');
  });
});

test('the number tokenizer is the one of AIR-276 rule 5: the constants are the same text as in claims-lint.ts', () => {
  const lint = fs.readFileSync(LINT, 'utf8');
  const checker = fs.readFileSync(CHECKER, 'utf8');
  for (const name of ['TAG_SRC', 'TAG_ANY', 'CODE_RE', 'URL_RE', 'NUM_RE', 'VERSION_RE', 'IDENT_RE']) {
    const re = new RegExp('^const ' + name + ' = .*;$', 'm');
    const a = re.exec(lint)?.[0];
    const b = re.exec(checker)?.[0];
    assert.ok(a !== undefined, 'claims-lint.ts lacks ' + name);
    assert.equal(b, a, 'the checker copy of ' + name + ' drifted from claims-lint.ts');
  }
});

test('an unknown flag, two payload flags and a missing value exit 2 with nothing on stdout', () => {
  withTree((t) => {
    for (const args of [['--no-such-flag'], ['--json', '--links'], ['--say'], ['--say', 'F8'], ['--root']]) {
      const res = execute(t, args);
      assert.equal(res.code, 2, args.join(' ') + '\n' + show(res));
      assert.equal(res.out, '');
    }
  });
});

test('untrusted: the word counts anywhere in the script, on a RUN line too, and the finding names the line', () => {
  withTree((t) => {
    swap(t, 'RUN pnpm demo:live', 'RUN pnpm demo:live UntrustedAmount');
    const res = run(t);
    expectOnly(res, ['untrusted']);
    assert.match(findingsOf(res, 'untrusted')[0] ?? '', /docs\/video-script\.md:\d+ /);
  });
});

test('overlap: captions that only touch do not overlap, and a caption that runs into the next shot overlaps its first caption', () => {
  withTree((t) => {
    expectOk(run(t));
  });
  withTree((t) => {
    swap(t, 'CAP S01b 0:06-0:10 ', 'CAP S01b 0:06-0:11 ');
    const res = run(t);
    assert.ok(rulesOf(res).includes('inside'), show(res));
    assert.ok(rulesOf(res).includes('overlap'), show(res));
  });
});

test('contiguous: an overlap of two shots, a shot that does not start at 0:00 and a repeated shot id fail', () => {
  withTree((t) => {
    swap(t, 'SHOT S03 0:25-0:50', 'SHOT S03 0:24-0:50');
    expectFail(run(t), 'contiguous');
  });
  withTree((t) => {
    swap(t, 'SHOT S01 0:00-0:10', 'SHOT S01 0:01-0:10');
    expectFail(run(t), 'contiguous');
  });
  withTree((t) => {
    swap(t, 'SHOT S02 0:10-0:25', 'SHOT S01 0:10-0:25');
    expectFail(run(t), 'contiguous');
  });
});

test('total: 135 and 150 seconds pass, 134 and 151 fail', () => {
  const one = (t: Tree, end: string): Result => {
    const other = path.join(t.tmp, 'one.md');
    fs.writeFileSync(
      other,
      ['LOCKED 2026-11-10', '', 'SHOT S01 0:00-' + end + ' mode TITLE', 'RUN pnpm i && pnpm demo', 'RUN open https://github.com/fixture-owner/fixture-repo', 'CAP S01a 0:01-0:05 [DESC] Built at NEAR HACKATHON', ''].join('\n'),
    );
    return execute(t, ['--root', t.root, '--file', other]);
  };
  withTree((t) => {
    expectOk(one(t, '2:15'));
    assert.match(one(t, '2:30').last, /^VIDEO SCRIPT OK shots=1 seconds=150 words=4$/);
    expectOnly(one(t, '2:14'), ['total']);
    expectOnly(one(t, '2:31'), ['total']);
  });
});
