// AIR-242: tests of scripts/threat-model-check.ts, one per failure the ticket names, plus the passing document.
// Each test builds a scratch root with docs/THREAT_MODEL.md, bench/cases/*.jsonl and bench/cases/not-run.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'threat-model-check.ts');
const SENTENCE = "The trusted renderer is the owner's wallet, not the AIRLOCK console, which may share a host with the agent.";
const CASES = [
  { id: 'own-A01-memo-payee', group: 'A' }, { id: 'own-B01-amount', group: 'B' }, { id: 'own-C01-pc', group: 'C' },
  { id: 'own-S01-twin', group: 'S' }, { id: 'own-X01-x402', group: 'X' }, { id: 'own-P01-pink', group: 'P' },
];
const NOT_RUN = [{ id: 'C01', group: 'D', reason: 'no approval action', covered_by: 'contract tests' },
  { id: 'H02', group: 'H', reason: 'no NFT permission', covered_by: 'none' }];

function doc(over: { drop?: string; sentence?: boolean; groups?: string[]; extra?: string; notRun?: string[] } = {}): string {
  const groups = over.groups ?? ['A', 'B', 'C', 'S', 'X', 'P'];
  const ids = CASES.filter((c) => groups.includes(c.group)).map((c) => c.id).join(', ');
  const parts: [string, string][] = [
    ['## Assets', 'Funds held by the policy contract.'],
    ['## Adversary (capabilities, and what they cannot do)', 'The adversary controls everything the agent reads.'],
    ['## Trust boundaries and what happens if each fails', 'Each line names a part.'],
    ['## Trusted renderer (R4-04)', over.sentence === false ? 'The wallet renders the approval.' : SENTENCE],
    ['## Attack groups covered (A to H) with the bench case ids', 'Run cases: ' + ids + '.' + (over.extra ?? '')],
    ['## Assumptions', 'The owner device is not compromised.'],
    ['## Out of scope', 'Groups D to H are not run: ' + (over.notRun ?? ['C01', 'H02']).join(', ') + '.'],
  ];
  return '# Threat model\n\n' + parts.filter(([h]) => h !== over.drop).map(([h, b]) => h + '\n' + b + '\n').join('\n');
}

function check(text: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'tm-'));
  try {
    mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'bench', 'cases'), { recursive: true });
    writeFileSync(join(root, 'docs', 'THREAT_MODEL.md'), text);
    writeFileSync(join(root, 'bench', 'cases', 'own-abc.jsonl'), CASES.map((c) => JSON.stringify(c)).join('\n') + '\n');
    writeFileSync(join(root, 'bench', 'cases', 'not-run.json'), JSON.stringify(NOT_RUN));
    const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a passing document prints THREAT MODEL OK with the count of case ids', () => {
  const r = check(doc());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.trim().split('\n').pop() ?? '', /^THREAT MODEL OK 6 case ids$/);
});

test('an own- id that is no case fails', () => {
  const r = check(doc({ extra: ' Also own-Z99-ghost.' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /own-Z99-ghost/);
});

test('a document without the AIR-084 sentence fails', () => {
  const r = check(doc({ sentence: false }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /trusted renderer sentence/);
});

test('a document missing a heading fails', () => {
  const r = check(doc({ drop: '## Assumptions' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /## Assumptions/);
});

test('a document with no case id of group X fails', () => {
  const r = check(doc({ groups: ['A', 'B', 'C', 'S', 'P'] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /group X/);
});

test('a document that omits an id of not-run.json fails', () => {
  const r = check(doc({ notRun: ['C01'] }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /H02/);
});

test('headings out of order, a placeholder or the word judge fail', () => {
  const swapped = doc().replace('## Assets', '## TEMP').replace('## Assumptions', '## Assets').replace('## TEMP', '## Assumptions');
  assert.equal(check(swapped).code, 1);
  assert.equal(check(doc({ extra: ' To fill during the build.' })).code, 1);
  assert.equal(check(doc({ extra: ' A judge would see this.' })).code, 1);
});
