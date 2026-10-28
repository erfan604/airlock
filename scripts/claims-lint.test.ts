// Tests for scripts/claims-lint.ts (AIR-276). Run: node --test scripts/claims-lint.test.ts (Node 24) or pnpm tsx --test.
// Every test builds a small repo in a temp folder: a copy of the lint, the three list files, an optional stub payload scan,
// and a copy of the passing fixture, so the lint sees the layout of the product repo and no test touches the real tree.
// The em dash and en dash are written as escapes on purpose: a literal one in a staged file is refused by the pre-commit hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fs.realpathSync(process.argv[1] ?? '.'));
const LINT_SRC = path.join(HERE, 'claims-lint.ts');
const LISTS_DIR = path.join(HERE, '..', 'docs');
const FIXTURE = path.join(HERE, 'fixtures', 'claims-lint', 'pass');
const STALE_FIXTURE = path.join(HERE, 'fixtures', 'claims-lint', 'stale-evidence');
const EM = '\u2014';
const EN = '\u2013';

type Repo = { root: string };
type Result = { code: number | null; lines: string[]; last: string; err: string };
type RepoOptions = { scan?: 'ok' | 'hit' | 'none'; markers?: boolean };

// A temp repo: scripts/claims-lint.ts, docs/*.txt (the shipped lists), pass/ (the fixture), and by default a stub
// scripts/payload-scan.sh that exits 0 plus a non-empty fixtures/payload-markers.txt, so the payload input is present.
function populate(root: string, opts: RepoOptions): void {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(LINT_SRC, path.join(root, 'scripts', 'claims-lint.ts'));
  fs.mkdirSync(path.join(root, 'docs'));
  for (const f of ['claim-verbs.txt', 'banned-phrases.txt', 'numbers-allowlist.txt']) {
    fs.copyFileSync(path.join(LISTS_DIR, f), path.join(root, 'docs', f));
  }
  fs.cpSync(FIXTURE, path.join(root, 'pass'), { recursive: true });
  fs.cpSync(STALE_FIXTURE, path.join(root, 'stale'), { recursive: true });
  const scan = opts.scan ?? 'ok';
  if (scan !== 'none') {
    fs.writeFileSync(path.join(root, 'scripts', 'payload-scan.sh'), scan === 'hit' ? '#!/usr/bin/env bash\nexit 1\n' : '#!/usr/bin/env bash\nexit 0\n');
  }
  if (opts.markers !== false) {
    fs.mkdirSync(path.join(root, 'fixtures'));
    fs.writeFileSync(path.join(root, 'fixtures', 'payload-markers.txt'), 'zz sample marker that no fixture line holds\n');
  }
}

function withRepo(opts: RepoOptions, fn: (r: Repo) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-lint-test-'));
  try {
    populate(root, opts);
    fn({ root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lint(r: Repo, args: string[]): Result {
  const p = spawnSync(process.execPath, [path.join(r.root, 'scripts', 'claims-lint.ts'), ...args], { cwd: r.root, encoding: 'utf8' });
  const lines = (p.stdout ?? '').split('\n').filter((l) => l !== '');
  return { code: p.status, lines, last: lines[lines.length - 1] ?? '', err: p.stderr ?? '' };
}

const README_ARGS = ['--readme', 'pass/README.md', '--docs', 'pass/docs'];

function edit(r: Repo, rel: string, fn: (s: string) => string): void {
  const p = path.join(r.root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  assert.notEqual(after, before, 'the edit changed nothing in ' + rel);
  fs.writeFileSync(p, after);
}

function replaceIn(r: Repo, rel: string, from: string | RegExp, to: string): void {
  edit(r, rel, (s) => s.replace(from, to));
}

// Add a line at the end of the README section that starts with the given heading (before the next heading).
function addToSection(r: Repo, rel: string, heading: string, text: string): void {
  edit(r, rel, (s) => {
    const at = s.indexOf(heading);
    assert.ok(at >= 0, 'no heading ' + heading);
    const next = s.indexOf('\n## ', at + heading.length);
    const cut = next < 0 ? s.length : next;
    return s.slice(0, cut).replace(/\n*$/, '\n') + text + '\n' + s.slice(cut);
  });
}

function findings(res: Result, rule: number): string[] {
  return res.lines.filter((l) => l.startsWith('FINDING ' + rule + ' '));
}

function expectFails(res: Result, rule: number): void {
  assert.equal(res.code, 1, 'expected exit 1, got ' + res.code + '\n' + res.lines.join('\n') + '\n' + res.err);
  assert.ok(findings(res, rule).length > 0, 'expected a FINDING ' + rule + ' line in:\n' + res.lines.join('\n'));
  assert.match(res.last, /^CLAIMS LINT FAIL \d+ findings$/);
}

const PRIOR_ART_SENTENCE = 'Interbolt (`deconvolute-labs/interbolt`) reports an AgentDojo banking attack success of 0 of 144 under its own policy [PA4].';

// ---------- the passing case ----------

test('a README and docs that follow every rule pass, and the last line counts the two pending items', () => {
  withRepo({}, (r) => {
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n') + res.err);
    assert.equal(findings(res, 1).length + findings(res, 2).length + findings(res, 3).length, 0);
    assert.equal(res.last, 'CLAIMS LINT OK (2 pending)');
    assert.ok(!res.lines.some((l) => l.startsWith('FINDING ') || l.startsWith('FINAL ') || l.startsWith('INPUT MISSING')));
  });
});

// ---------- one failing README per rule ----------

test('rule 1: an unknown claim id fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The gate never pays an unnamed recipient [C99].');
    const res = lint(r, README_ARGS);
    expectFails(res, 1);
    assert.match(findings(res, 1)[0] ?? '', /^FINDING 1 pass\/README\.md:\d+ .*C99/);
  });
});

test('rule 1: an unknown source tag [S9] fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The loss was reported at about $2.0 billion [S9].');
    expectFails(lint(r, README_ARGS), 1);
  });
});

test('rule 1: a prior-art tag past the first table fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'A neighbour is listed [PA5].');
    expectFails(lint(r, README_ARGS), 1);
  });
});

test('rule 1: a claim row with an empty Command fails when the README tags it', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/docs/CLAIMS.md', '`scripts/sample-check.sh`', '');
    expectFails(lint(r, README_ARGS), 1);
  });
});

test('rule 2: a claim sentence without a tag fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## The problem', 'The gate never pays an unnamed recipient.');
    const res = lint(r, README_ARGS);
    expectFails(res, 2);
    assert.match(findings(res, 2)[0] ?? '', /^FINDING 2 pass\/README\.md:\d+ /);
  });
});

test('rule 2: a claim verb in a list item or a table row without a tag fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Claims', '- The gate always pays on time');
    expectFails(lint(r, README_ARGS), 2);
  });
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## What is enforced where', '| Replay | It will never change | none |');
    expectFails(lint(r, README_ARGS), 2);
  });
});

test('rule 2: a missing required section heading fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', '## What is enforced where', '## Where things sit');
    expectFails(lint(r, README_ARGS), 2);
  });
});

test('rule 3: a banned phrase fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The sample gate is unhackable [C1a].');
    expectFails(lint(r, README_ARGS), 3);
  });
});

test('rule 3: a banned phrase split over two lines fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The sample is a provably\nsecure design [C1a].');
    expectFails(lint(r, README_ARGS), 3);
  });
});

test('rule 3: the word judges in a docs file fails and names that file', () => {
  withRepo({}, (r) => {
    edit(r, 'pass/docs/BENCH.md', (s) => s + '\nThis page is written for the judges.\n');
    const res = lint(r, README_ARGS);
    expectFails(res, 3);
    assert.match(findings(res, 3)[0] ?? '', /^FINDING 3 pass\/docs\/BENCH\.md:\d+ /);
  });
});

test('rule 3: a README-only phrase such as the word first is not a finding in a docs file', () => {
  withRepo({}, (r) => {
    edit(r, 'pass/docs/BENCH.md', (s) => s + '\nThe first step is the replay command.\n');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
});

test('rule 8: the word first in the prior-art section fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Prior art', 'The sample was the first design of its kind.');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 4: the word attested without a registration row fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The runtime is attested.');
    expectFails(lint(r, README_ARGS), 4);
  });
});

test('rule 4: the word attested passes when EVIDENCE.md has a registration transaction link', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The runtime is attested.');
    edit(r, 'pass/docs/EVIDENCE.md', (s) => s + '| TEE registration tx | testnet | https://testnet.nearblocks.io/txns/AbCdEf | 2026-11-08 |\n');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
});

test('rule 5: a number found in no doc fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The run used 7777 cases.');
    const res = lint(r, README_ARGS);
    expectFails(res, 5);
    assert.match(findings(res, 5)[0] ?? '', /7777/);
  });
});

test('rule 5: a number from a doc or the allowlist passes, code and version strings are skipped', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The sample reports 144 cases here, took 2 minutes, and ran `7777` times on v9.9.9 builds 1.2.3.');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
});

test('rule 5: identifiers are not numbers (AIR-201, erfan-7116, arXiv 2610.26438), a bare number still is', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'Ticket AIR-201 by erfan-7116 follows arXiv 2610.26438.');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'Ticket AIR-201 lost 7777 of them.');
    const res = lint(r, README_ARGS);
    expectFails(res, 5);
    assert.match(findings(res, 5)[0] ?? '', /7777/);
  });
});

test('rule 5: ISO dates and date-times are not numbers, a bare number next to one still is', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'Written between 2026-10-20 and 2026-10-27, product code from 2026-10-28T14:00Z.');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'On 2026-10-31 it lost 7777 of them.');
    const res = lint(r, README_ARGS);
    expectFails(res, 5);
    assert.match(findings(res, 5)[0] ?? '', /7777/);
  });
});

test('rule 6: an em dash fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'A limit ' + EM + ' stated here.');
    expectFails(lint(r, README_ARGS), 6);
  });
});

test('rule 6: an en dash fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'A limit ' + EN + ' stated here.');
    expectFails(lint(r, README_ARGS), 6);
  });
});

test('rule 6: a double hyphen in prose fails but one in a code span, a fence or a comment does not', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'Run with the flag --final to see it.');
    expectFails(lint(r, README_ARGS), 6);
  });
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'Run with `--final` to see it. <!-- a -- b -->');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
});

test('rule 7: a payload marker line fails in file mode', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'markers.txt'), 'zq sample marker text\n');
    fs.writeFileSync(path.join(r.root, 'note.md'), 'A plain line.\nHere is ZQ Sample Marker Text inside a line.\n');
    const res = lint(r, ['--file', 'note.md', '--markers', 'markers.txt', '--docs', 'pass/docs']);
    expectFails(res, 7);
    assert.match(findings(res, 7)[0] ?? '', /^FINDING 7 note\.md:2 /);
  });
});

test('rule 7: in README mode a payload scan that exits nonzero fails', () => {
  withRepo({ scan: 'hit' }, (r) => {
    expectFails(lint(r, README_ARGS), 7);
  });
});

test('rule 8: a prior-art section without interbolt fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', /Interbolt \(`deconvolute-labs\/interbolt`\)/, 'A shipped tool');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 8: a prior-art section without microsoft/agent-framework fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', 'in `microsoft/agent-framework`', 'in a shipped framework');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 8: a prior-art section without pc taint fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', 'pc taint, ', '');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 8: a prior-art section without amount provenance or without enforcement at the signer fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', 'amount provenance and ', '');
    expectFails(lint(r, README_ARGS), 8);
  });
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', 'enforcement at the signer', 'a signing step');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 8: a 0 of 144 sentence without a [PA<n>] tag fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', 'its own policy [PA4].', 'its own policy.');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 8: a 281 tests sentence without the word report or reported fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Prior art', 'Its suite holds 281 tests [PA3].');
    expectFails(lint(r, README_ARGS), 8);
  });
});

test('rule 9: a leftover placeholder fails', () => {
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', '_To fill during the build_');
    expectFails(lint(r, README_ARGS), 9);
  });
  withRepo({}, (r) => {
    edit(r, 'pass/docs/EVIDENCE.md', (s) => s + '_Skeleton written before the event_\n');
    expectFails(lint(r, README_ARGS), 9);
  });
});

test('rule 10: a bench-block line that is not in BENCH.md fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', '<!-- bench:start -->\n', '<!-- bench:start -->\n| V9 | 5 of 5 |\n');
    expectFails(lint(r, README_ARGS), 10);
  });
});

test('rule 10: a duplicated bench marker, or a hash missing from EVIDENCE.md, fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', '<!-- bench:end -->\n', '<!-- bench:end -->\n<!-- bench:start -->\n');
    expectFails(lint(r, README_ARGS), 10);
  });
  withRepo({}, (r) => {
    addToSection(r, 'pass/README.md', '## Limits', 'The wasm hash is ' + 'ab12'.repeat(16) + '.');
    expectFails(lint(r, README_ARGS), 10);
  });
});

test('rule 10: a hash that EVIDENCE.md holds passes', () => {
  withRepo({}, (r) => {
    const hash = 'ab12'.repeat(16);
    addToSection(r, 'pass/README.md', '## Limits', 'The wasm hash is ' + hash + '.');
    edit(r, 'pass/docs/EVIDENCE.md', (s) => s + '| Sample wasm | none | ' + hash + ' | 2026-11-02 |\n');
    assert.equal(lint(r, README_ARGS).code, 0);
  });
});

test('rule 2 skip: a bench block line holding the word only passes when BENCH.md has the same line', () => {
  withRepo({}, (r) => {
    const line = 'Only the sample replay is shown here.';
    edit(r, 'pass/docs/BENCH.md', (s) => s + '\n' + line + '\n');
    replaceIn(r, 'pass/README.md', '<!-- bench:start -->\n', '<!-- bench:start -->\n' + line + '\n');
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(res.last, 'CLAIMS LINT OK (1 pending)');
  });
});

// ---------- pending rows, the empty bench block and --final ----------

test('pending: a row whose Command is pending: AIR-228 passes without --final and the last line counts it', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', '<!-- bench:start -->\n', '<!-- bench:start -->\nSample results are generated by the replay command.\n');
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(res.last, 'CLAIMS LINT OK (1 pending)');
  });
});

test('pending: the same row fails with --final and prints a FINAL line for it', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/README.md', '<!-- bench:start -->\n', '<!-- bench:start -->\nSample results are generated by the replay command.\n');
    const res = lint(r, ['--final', ...README_ARGS]);
    assert.equal(res.code, 1);
    const finals = res.lines.filter((l) => l.startsWith('FINAL '));
    assert.equal(finals.length, 1);
    assert.match(finals[0] ?? '', /C2/);
    assert.match(res.last, /^CLAIMS LINT FAIL 1 findings$/);
  });
});

test('pending: a Command cell pending: with no ticket id fails', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/docs/CLAIMS.md', '`pending: AIR-228 scripts/bench-replay-check.sh`', '`pending: scripts/bench-replay-check.sh`');
    expectFails(lint(r, README_ARGS), 11);
  });
});

test('pending: an empty bench block passes without --final', () => {
  withRepo({}, (r) => {
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0);
    assert.match(res.last, /^CLAIMS LINT OK \(2 pending\)$/);
  });
});

test('pending: the same empty bench block fails with --final and prints its own FINAL line', () => {
  withRepo({}, (r) => {
    replaceIn(r, 'pass/docs/CLAIMS.md', '`pending: AIR-228 scripts/bench-replay-check.sh`', '`scripts/bench-replay-check.sh`');
    const res = lint(r, ['--final', ...README_ARGS]);
    assert.equal(res.code, 1);
    const finals = res.lines.filter((l) => l.startsWith('FINAL '));
    assert.equal(finals.length, 1);
    assert.match(finals[0] ?? '', /bench/i);
  });
});

test('pending: --final on the fixture prints one FINAL line for the pending row and one for the empty bench block', () => {
  withRepo({}, (r) => {
    const res = lint(r, ['--final', ...README_ARGS]);
    assert.equal(res.code, 1);
    assert.ok(res.lines.filter((l) => l.startsWith('FINAL ')).length >= 2);
  });
});

test('pending: a missing marker file in --file mode counts as pending', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'note.md'), 'A plain sentence.\n');
    const res = lint(r, ['--file', 'note.md', '--markers', 'no-such-markers.txt', '--docs', 'pass/docs']);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(res.last, 'CLAIMS LINT OK (1 pending)');
  });
});

test('pending: the same missing marker file exits 2 with --final', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'note.md'), 'A plain sentence.\n');
    const res = lint(r, ['--file', 'note.md', '--final', '--markers', 'no-such-markers.txt', '--docs', 'pass/docs']);
    assert.equal(res.code, 2);
    assert.ok(res.lines.includes('INPUT MISSING no-such-markers.txt'), res.lines.join('\n'));
    assert.ok(res.lines.some((l) => l.startsWith('FINAL ')));
    assert.match(res.last, /^CLAIMS LINT FAIL \d+ findings$/);
  });
});

test('pending: in README mode a missing payload scan script counts as one more pending item', () => {
  withRepo({ scan: 'none' }, (r) => {
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(res.last, 'CLAIMS LINT OK (3 pending)');
  });
});

test('pending: in README mode a missing payload scan script exits 2 with --final', () => {
  withRepo({ scan: 'none' }, (r) => {
    const res = lint(r, ['--final', ...README_ARGS]);
    assert.equal(res.code, 2);
    assert.ok(res.lines.includes('INPUT MISSING scripts/payload-scan.sh'), res.lines.join('\n'));
  });
});

// ---------- interface audit cases ----------

test('docs/video-script.md may hold a RUN line with a CLI flag, any other docs file may not', () => {
  const runLine = 'RUN scripts/diff-verdict.sh --commit\n';
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'pass', 'docs', 'video-script.md'), '# Script\n\n' + runLine);
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
  });
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'pass', 'docs', 'NOTES.md'), '# Notes\n\n' + runLine);
    const res = lint(r, README_ARGS);
    expectFails(res, 6);
    assert.match(findings(res, 6)[0] ?? '', /^FINDING 6 pass\/docs\/NOTES\.md:3 /);
  });
});

test('video-script.md is still read by rules 3 and 9', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'pass', 'docs', 'video-script.md'), '# Script\n\nThis wallet is unhackable.\n');
    expectFails(lint(r, README_ARGS), 3);
  });
});

test('shade-attestation in an inline code span passes rule 4 in file mode, the same word in prose fails', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'ok.md'), 'The crate `shade-attestation` is pinned.\n');
    const res = lint(r, ['--file', 'ok.md', '--docs', 'pass/docs']);
    assert.equal(res.code, 0, res.lines.join('\n'));
    fs.writeFileSync(path.join(r.root, 'bad.md'), 'The crate shade-attestation is pinned.\n');
    const bad = lint(r, ['--file', 'bad.md', '--docs', 'pass/docs']);
    expectFails(bad, 4);
    assert.match(findings(bad, 4)[0] ?? '', /^FINDING 4 bad\.md:1 /);
  });
});

test('rule 4: unattested is not a finding and attestation inside a quotation is not a finding', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'ok.md'), 'The runtime is unattested. A vendor writes "attestation of code and input" on its site.\n');
    const res = lint(r, ['--file', 'ok.md', '--docs', 'pass/docs']);
    assert.equal(res.code, 0, res.lines.join('\n'));
  });
});

// ---------- file mode, flags, exit codes ----------

test('file mode: a plain sentence passes and an em dash written as bytes is a rule 6 finding', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'a.md'), 'A plain sentence.\n');
    assert.equal(lint(r, ['--file', 'a.md', '--docs', 'pass/docs']).code, 0);
    fs.writeFileSync(path.join(r.root, 'b.md'), Buffer.from([0x61, 0x20, 0xe2, 0x80, 0x94, 0x20, 0x62, 0x0a]));
    const res = lint(r, ['--file', 'b.md', '--docs', 'pass/docs']);
    expectFails(res, 6);
    assert.ok(res.lines.some((l) => l.startsWith('FINDING 6 b.md:1 ')));
  });
});

test('file mode: --lines-with limits the rules to the matching lines', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'c.md'), 'SAY a plain line\nNOTE a ' + EM + ' dash line\n');
    assert.equal(lint(r, ['--file', 'c.md', '--lines-with', '^SAY ', '--docs', 'pass/docs']).code, 0);
    expectFails(lint(r, ['--file', 'c.md', '--lines-with', '^NOTE ', '--docs', 'pass/docs']), 6);
  });
});

test('file mode: rules 1, 2, 8 and 10 do not apply', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'd.md'), 'The gate never pays an unnamed recipient [C99].\n');
    assert.equal(lint(r, ['--file', 'd.md', '--docs', 'pass/docs']).code, 0);
  });
});

test('exit 2 wins over exit 1: a missing CLAIMS.md prints INPUT MISSING and still prints the findings', () => {
  withRepo({}, (r) => {
    fs.rmSync(path.join(r.root, 'pass', 'docs', 'CLAIMS.md'));
    addToSection(r, 'pass/README.md', '## Limits', 'The sample gate is unhackable [C1a].');
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 2);
    assert.ok(res.lines.includes('INPUT MISSING pass/docs/CLAIMS.md'), res.lines.join('\n'));
    assert.ok(findings(res, 3).length > 0);
    assert.match(res.last, /^CLAIMS LINT FAIL \d+ findings$/);
  });
});

test('a missing README exits 2', () => {
  withRepo({}, (r) => {
    const res = lint(r, ['--readme', 'pass/NO-README.md', '--docs', 'pass/docs']);
    assert.equal(res.code, 2);
    assert.ok(res.lines.includes('INPUT MISSING pass/NO-README.md'), res.lines.join('\n'));
  });
});

test('an unknown flag exits nonzero and prints no FINAL line', () => {
  withRepo({}, (r) => {
    const res = lint(r, ['--no-such-flag']);
    assert.notEqual(res.code, 0);
    assert.ok(!res.lines.some((l) => l.startsWith('FINAL ')));
  });
});

test('the lists are read from the repo docs folder also when --docs points elsewhere', () => {
  withRepo({}, (r) => {
    fs.rmSync(path.join(r.root, 'docs', 'banned-phrases.txt'));
    const res = lint(r, README_ARGS);
    assert.equal(res.code, 2);
    assert.ok(res.lines.includes('INPUT MISSING docs/banned-phrases.txt'), res.lines.join('\n'));
  });
});

test('the shipped word lists hold the entries the ticket names', () => {
  const verbs = fs.readFileSync(path.join(LISTS_DIR, 'claim-verbs.txt'), 'utf8').split('\n').filter((l) => l !== '');
  assert.deepEqual(verbs, ['cannot', 'never', 'always', 'only', 'prove', 'proven', 'verified', 'model-checked', 'enforce', 'guarantee', 'block', 'refuse', 'escalate', 'auto-pay', 'release', 'signs', 'checks', 'tracks']);
  const banned = fs.readFileSync(path.join(LISTS_DIR, 'banned-phrases.txt'), 'utf8');
  for (const needle of ['first provenance tracking', 'unhackable', 'README-only: ', 'judges?', 'reviewers?', 'Kani proved all inputs', 'nobody does this']) {
    assert.ok(banned.includes(needle), 'banned-phrases.txt lacks ' + needle);
  }
  assert.ok(fs.readFileSync(path.join(LISTS_DIR, 'numbers-allowlist.txt'), 'utf8').includes('2 minutes'));
});

// ---------- rule 12: the file:line of the Evidence column (AIR-284) ----------
// The stale-evidence fixture is copied to stale/ next to pass/. src/a.rs has five lines: 1 `// gate module`, 2 `pub fn gate() -> bool {`,
// 3 `    true`, 4 `}`, 5 `// end`. Its CLAIMS.md has C1a (src/a.rs:3 with the symbol `pub fn gate`, valid) and C2 (src/a.rs:40, stale).

const EVIDENCE_ARGS = ['--readme', 'stale/README.md', '--docs', 'stale/docs', '--root', 'stale', '--check-evidence'];

// Rewrite the Evidence cells of the two rows of stale/docs/CLAIMS.md; the C2 row is made pending when pending is set.
function setEvidence(r: Repo, c1a: string, c2: string, pending = false): void {
  const cmd2 = pending ? '`pending: AIR-228 scripts/bench-replay-check.sh`' : '`scripts/bench-replay-check.sh`';
  fs.writeFileSync(
    path.join(r.root, 'stale', 'docs', 'CLAIMS.md'),
    '# Claims and how to check each one\n\n' +
      '| # | Claim | Evidence (file:line) | Command | Expected output | Needs | Source ticket |\n| --- | --- | --- | --- | --- | --- | --- |\n' +
      '| C1a | The sample gate cannot pay a recipient the owner did not name. | ' + c1a + ' | `scripts/sample-check.sh` | `SAMPLE OK` | none | AIR-030 |\n' +
      '| C2 | The sample bench reports n with every figure. | ' + c2 + ' | ' + cmd2 + ' | `BENCH REPLAY OK` | none | AIR-228 |\n',
  );
}

// Lint with C1a carrying the given Evidence cell and C2 a valid one.
function evidenceOf(r: Repo, cell: string, extra: string[] = []): Result {
  setEvidence(r, cell, 'src/a.rs:1');
  return lint(r, [...EVIDENCE_ARGS, ...extra]);
}

function f12(res: Result): string[] {
  return findings(res, 12);
}

test('rule 12: the stale-evidence fixture fails with one finding on the stale row and exit 1', () => {
  withRepo({}, (r) => {
    const res = lint(r, EVIDENCE_ARGS);
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.equal(f12(res).length, 1, res.lines.join('\n'));
    assert.match(f12(res)[0] ?? '', /^FINDING 12 stale\/docs\/CLAIMS\.md:6 .*src\/a\.rs:40/);
    assert.equal(res.last, 'CLAIMS LINT FAIL 1 findings');
  });
});

test('rule 12 is off without --check-evidence and on with --final', () => {
  withRepo({}, (r) => {
    const off = lint(r, ['--readme', 'stale/README.md', '--docs', 'stale/docs', '--root', 'stale']);
    assert.equal(off.code, 0, off.lines.join('\n'));
    assert.equal(f12(off).length, 0);
    const fin = lint(r, ['--final', '--readme', 'stale/README.md', '--docs', 'stale/docs', '--root', 'stale']);
    assert.equal(fin.code, 1, fin.lines.join('\n'));
    assert.equal(f12(fin).length, 1, fin.lines.join('\n'));
  });
});

test('rule 12: rows that point at real lines pass, and the last line form is the one of AIR-276', () => {
  withRepo({}, (r) => {
    setEvidence(r, 'src/a.rs:3 (`pub fn gate`)', 'src/a.rs:5');
    const res = lint(r, EVIDENCE_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.match(res.last, /^CLAIMS LINT OK \(\d+ pending\)$/);
  });
});

test('rule 12: a file that does not exist is a finding that names it', () => {
  withRepo({}, (r) => {
    const res = evidenceOf(r, 'src/nope.rs:3');
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.match(f12(res)[0] ?? '', /^FINDING 12 stale\/docs\/CLAIMS\.md:5 .*src\/nope\.rs:3/);
  });
});

test('rule 12: a folder is not a file', () => {
  withRepo({}, (r) => {
    expectFails(evidenceOf(r, 'src:2'), 12);
  });
});

test('rule 12: the line must be within the file (line 0 and line 6 of 5 fail, line 1 and line 5 pass)', () => {
  withRepo({}, (r) => {
    expectFails(evidenceOf(r, 'src/a.rs:0'), 12);
    expectFails(evidenceOf(r, 'src/a.rs:6'), 12);
    assert.equal(evidenceOf(r, 'src/a.rs:1').code, 0);
    assert.equal(evidenceOf(r, 'src/a.rs:5').code, 0);
  });
});

test('rule 12: a symbol within 3 lines after the token passes and 4 lines away fails', () => {
  withRepo({}, (r) => {
    assert.equal(evidenceOf(r, 'src/a.rs:2 (`// end`)').code, 0);
    const res = evidenceOf(r, 'src/a.rs:1 (`// end`)');
    expectFails(res, 12);
    assert.match(f12(res)[0] ?? '', /\/\/ end/);
  });
});

test('rule 12: a symbol within 3 lines before the token passes and 4 lines away fails', () => {
  withRepo({}, (r) => {
    assert.equal(evidenceOf(r, 'src/a.rs:4 (`gate module`)').code, 0);
    expectFails(evidenceOf(r, 'src/a.rs:5 (`gate module`)'), 12);
  });
});

test('rule 12: the symbol may follow the token directly, in backticks of its own, or with the token itself in backticks', () => {
  withRepo({}, (r) => {
    assert.equal(evidenceOf(r, 'src/a.rs:3 `pub fn gate`').code, 0);
    assert.equal(evidenceOf(r, '`src/a.rs:3` `pub fn gate`').code, 0);
    assert.equal(evidenceOf(r, '`src/a.rs:3` (`pub fn gate`)').code, 0);
    expectFails(evidenceOf(r, '`src/a.rs:3` `no_such_symbol`'), 12);
    expectFails(evidenceOf(r, 'src/a.rs:3 `no_such_symbol`'), 12);
  });
});

test('rule 12: a symbol that appears nowhere in the file fails and is named', () => {
  withRepo({}, (r) => {
    const res = evidenceOf(r, 'src/a.rs:3 (`missing_symbol`)');
    expectFails(res, 12);
    assert.match(f12(res)[0] ?? '', /missing_symbol/);
  });
});

test('rule 12: the range form checks both ends and widens the symbol window to the whole range', () => {
  withRepo({}, (r) => {
    assert.equal(evidenceOf(r, 'src/a.rs:2-3').code, 0);
    assert.equal(evidenceOf(r, 'src/a.rs:1-5').code, 0);
    expectFails(evidenceOf(r, 'src/a.rs:4-9'), 12);
    expectFails(evidenceOf(r, 'src/a.rs:0-2'), 12);
    expectFails(evidenceOf(r, 'src/a.rs:3-2'), 12);
    assert.equal(evidenceOf(r, 'src/a.rs:1-2 (`// end`)').code, 0);
    expectFails(evidenceOf(r, 'src/a.rs:1-1 (`// end`)'), 12);
  });
});

test('rule 12: every token of a cell is checked on its own and a symbol belongs to the token before it', () => {
  withRepo({}, (r) => {
    const ok = evidenceOf(r, 'src/a.rs:3 (`pub fn gate`), src/a.rs:5 (`// end`)');
    assert.equal(ok.code, 0, ok.lines.join('\n'));
    const bad = evidenceOf(r, 'src/a.rs:3 (`pub fn gate`), src/a.rs:5 (`nonexistent_symbol`), src/a.rs:77');
    assert.equal(bad.code, 1);
    assert.equal(f12(bad).length, 2, bad.lines.join('\n'));
    assert.equal(bad.last, 'CLAIMS LINT FAIL 2 findings');
  });
});

test('rule 12: a token with no symbol passes, a path with no line and a URL with a port are not tokens', () => {
  withRepo({}, (r) => {
    assert.equal(evidenceOf(r, 'src/a.rs:3').code, 0);
    assert.equal(evidenceOf(r, 'src/missing-file.rs and proofs/NI.lean (`some_theorem`)').code, 0);
    assert.equal(evidenceOf(r, 'see http://127.0.0.1:4173/x and https://example.org:8080/y, run at 10:30').code, 0);
  });
});

test('rule 12: a token that is not alone in its backticks gets no symbol check, and a second token is never the symbol of the first', () => {
  withRepo({}, (r) => {
    const res = evidenceOf(r, '`see src/a.rs:3` `no_such_symbol`');
    assert.equal(res.code, 0, res.lines.join('\n'));
    const two = evidenceOf(r, '`src/a.rs:3` `src/a.rs:5`');
    assert.equal(two.code, 0, two.lines.join('\n'));
  });
});

test('rule 12: with --root the file only has to exist, also inside a git work tree where it is untracked', () => {
  withRepo({}, (r) => {
    setEvidence(r, 'src/a.rs:3', 'src/a.rs:1');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: r.root }).status, 0);
    const res = lint(r, EVIDENCE_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
  });
});

test('rule 12 and the Needs check read the columns by name and fall back to positions 3 (Evidence) and 6 (Needs)', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(
      path.join(r.root, 'stale', 'docs', 'CLAIMS.md'),
      '# Claims\n\n| Id | Claim | Where | Cmd | Expect | Tools | Ticket |\n| --- | --- | --- | --- | --- | --- | --- |\n' +
        '| C1a | A claim. | src/a.rs:40 | `scripts/sample-check.sh` | `SAMPLE OK` | gpu | AIR-030 |\n' +
        '| C2 | A second claim. | src/a.rs:3 | `scripts/bench-replay-check.sh` | `BENCH REPLAY OK` | none | AIR-228 |\n',
    );
    const res = lint(r, EVIDENCE_ARGS);
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.equal(f12(res).length, 1, res.lines.join('\n'));
    assert.equal(findings(res, 1).filter((l) => /Needs/.test(l)).length, 1, res.lines.join('\n'));
  });
});

test('rule 12: only the Evidence column is read', () => {
  withRepo({}, (r) => {
    setEvidence(r, 'src/a.rs:3', 'src/a.rs:1');
    replaceIn(r, 'stale/docs/CLAIMS.md', 'The sample bench reports n with every figure.', 'The bench code sits at src/missing.rs:99.');
    assert.equal(lint(r, EVIDENCE_ARGS).code, 0);
  });
});

test('rule 12: a path that leaves the root is a finding', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'outside.rs'), 'x\n');
    expectFails(evidenceOf(r, '../outside.rs:1'), 12);
    expectFails(evidenceOf(r, '/etc/hosts:1'), 12);
  });
});

test('rule 12: a pending row is not checked without --final, and with --final it is a FINAL line, not a rule 12 finding', () => {
  withRepo({}, (r) => {
    setEvidence(r, 'src/a.rs:3', 'src/a.rs:40', true);
    const res = lint(r, EVIDENCE_ARGS);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(f12(res).length, 0);
    const fin = lint(r, ['--final', '--readme', 'stale/README.md', '--docs', 'stale/docs', '--root', 'stale']);
    assert.equal(f12(fin).length, 0, fin.lines.join('\n'));
    assert.ok(fin.lines.some((l) => l.startsWith('FINAL pending row C2')), fin.lines.join('\n'));
  });
});

test('rule 12: a missing --root folder exits 2 with INPUT MISSING', () => {
  withRepo({}, (r) => {
    const res = lint(r, ['--readme', 'stale/README.md', '--docs', 'stale/docs', '--root', 'no-such-folder', '--check-evidence']);
    assert.equal(res.code, 2, res.lines.join('\n'));
    assert.ok(res.lines.includes('INPUT MISSING no-such-folder'), res.lines.join('\n'));
  });
});

test('rule 12: without --root the root is the folder that holds docs, and in a git work tree the file must be tracked', () => {
  withRepo({}, (r) => {
    setEvidence(r, 'src/a.rs:3', 'src/a.rs:1');
    const args = ['--readme', 'stale/README.md', '--docs', 'stale/docs', '--check-evidence'];
    // not a git work tree: the file only has to exist
    assert.equal(lint(r, args).code, 0);
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: r.root }).status, 0);
    // a work tree where the file is untracked: a finding
    const untracked = lint(r, args);
    assert.equal(untracked.code, 1, untracked.lines.join('\n'));
    assert.match(f12(untracked)[0] ?? '', /not tracked|no tracked file/);
    assert.equal(spawnSync('git', ['add', 'stale/src/a.rs'], { cwd: r.root }).status, 0);
    const tracked = lint(r, args);
    assert.equal(tracked.code, 0, tracked.lines.join('\n'));
  });
});

test('rule 12: the pass fixture, whose C1a points at src/gate.rs:10, passes with --check-evidence and --final keeps its AIR-276 behaviour', () => {
  withRepo({}, (r) => {
    const res = lint(r, [...README_ARGS, '--check-evidence']);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.equal(res.last, 'CLAIMS LINT OK (2 pending)');
    const fin = lint(r, ['--final', ...README_ARGS]);
    assert.equal(f12(fin).length, 0, fin.lines.join('\n'));
  });
});

test('rule 12 does not apply in file mode, where --check-evidence is accepted and ignored', () => {
  withRepo({}, (r) => {
    fs.writeFileSync(path.join(r.root, 'note.md'), 'A plain sentence.\n');
    const res = lint(r, ['--file', 'note.md', '--check-evidence', '--docs', 'stale/docs']);
    assert.equal(res.code, 0, res.lines.join('\n'));
  });
});
