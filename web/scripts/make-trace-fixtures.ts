// Writes web/fixtures/trace-u01.json, trace-b01.json and trace-hostile.json (AIR-184) from the world files: the inbox item of the scenario
// from fixtures/world.jsonl and its body from the payload file its `text_ref` names, so outsider text is copied from data to data and never
// typed here. Run: pnpm -C web exec tsx scripts/make-trace-fixtures.ts. Fixtures are regenerated from the first live run of AIR-165 when its
// golden trace exists (bench/golden/u01.json).
// The hostile fixture adds an HTML tag string, a zero width space and a right to left override to the body. They are built from code points
// here and the output is escaped to ASCII, so no file holds an invisible character.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = new URL('../../', import.meta.url);
const out = new URL('../fixtures/', import.meta.url);

type InboxRow = { id: string; kind: string; from: string; subject: string; text_ref: string; attachments: string[] };
type WireEvent = { t: number; kind: string; data: Record<string, unknown> };

const world: InboxRow[] = readFileSync(new URL('fixtures/world.jsonl', repo), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as InboxRow)
  .filter((r) => r.kind === 'inbox');

function inboxItem(id: string): InboxRow & { body: string } {
  const row = world.find((r) => r.id === id);
  if (row === undefined) throw new Error(`no inbox item ${id} in fixtures/world.jsonl`);
  const body = readFileSync(new URL(`fixtures/${row.text_ref}`, repo), 'utf8');
  return { ...row, body };
}

const PLAN_HASH = 'cf349cb2b6cbfa297a440dca92c52be6247058085239b8437e2297f17107a0e1';
const TX_HASH = 'EZ8sdxDshpMBvbCCQH9zVSEj7LBb9npKTBxLuNWCmqFa';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function events(opts: { item: string; amount: string; amountBase: string; held: boolean; seed: string; body?: (b: string) => string; vendor?: string }): WireEvent[] {
  const row = inboxItem(opts.item);
  const taskHash = sha(opts.seed);
  const emailLabels = ['Untrusted:email', 'Untrusted:quarantine'];
  const item = opts.item;
  return [
    { t: 0, kind: 'plan', data: { planSha256: PLAN_HASH } },
    {
      t: 40,
      kind: 'call',
      data: { id: 'call:1', step: [0], tool: 'read_inbox', label: 'Untrusted:email', raw: { id: row.id, from: row.from, subject: row.subject, body: (opts.body ?? ((b) => b))(row.body), attachments: row.attachments } },
    },
    { t: 1800, kind: 'extract', data: { step: [1], fields: { amount: opts.amount, vendor: opts.vendor ?? 'accountant' }, labels: emailLabels, item } },
    { t: 1850, kind: 'lookup', data: { step: [2], key: 'accountant', found: true, result: 'near:accountant.testnet', labels: ['Book'], item } },
    {
      t: 1900,
      kind: 'proposed',
      data: { step: [3], action: 'transfer', payee: 'near:accountant.testnet', asset: 'near', amount: opts.amountBase, recipientLabels: ['Book'], amountLabels: emailLabels, pc: ['Owner'], item },
    },
    { t: 2100, kind: 'submitted', data: { count: 1, taskHash, txHash: TX_HASH, item } },
    {
      t: 2600,
      kind: 'verdict',
      data: opts.held
        ? { request_id: `${taskHash}:0`, outcome: 'escalated', reason: 'OverTaskBound', pending_id: 4, item }
        : { request_id: `${taskHash}:0`, outcome: 'allowed', reason: null, pending_id: null, item },
    },
  ];
}

// code points, never typed characters: U+200B zero width space, U+202E right to left override
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const TAG = '<img src=x onerror=alert(1)>';
// first, so the Specimen's 240 character cut keeps it on screen
const hostileBody = (b: string): string => `${TAG} total 4.2${ZWSP} NEAR ${RLO}RTL\n${b}`;

const files: Record<string, WireEvent[]> = {
  'trace-u01.json': events({ item: 'inv-april', amount: '4.2', amountBase: '4200000000000000000000000', held: false, seed: 'trace-u01' }),
  'trace-b01.json': events({ item: 'inv-april-correction', amount: '9.4', amountBase: '9400000000000000000000000', held: true, seed: 'trace-b01' }),
  'trace-hostile.json': events({ item: 'inv-april', amount: '4.2', amountBase: '4200000000000000000000000', held: false, seed: 'trace-hostile', body: hostileBody, vendor: '<b onmouseover=alert(1)>accountant</b>' }),
};

// JSON.stringify leaves invisible and non ASCII characters as they are: escape every one so the files are plain ASCII
const ascii = (json: string): string => json.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

for (const [name, list] of Object.entries(files)) {
  writeFileSync(fileURLToPath(new URL(name, out)), `${ascii(JSON.stringify({ events: list }, null, 2))}\n`);
  console.log(`wrote web/fixtures/${name} (${list.length} events)`);
}
