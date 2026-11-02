// AIR-166: the golden run file (data, never hand-edited), its EVIDENCE rows, and the check of a chain recording. A golden file is written by
// scripts/golden.ts from a run and read by AIR-243, AIR-246, AIR-247 and scripts/verify-golden.ts, which trusts only its hashes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from '../../runtime/node_modules/zod/index.js';

export const GOLDEN_NAMES = ['u01', 'contractor', 'b01-escalate', 'b01-approve', 'tamper', 'twin'] as const;
export type GoldenName = (typeof GOLDEN_NAMES)[number];

export const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
export const BASESCAN = 'https://sepolia.basescan.org/tx/';
export const GOLDEN_HEADING = '## Golden runs (AIR-166)';

const TxSchema = z.strictObject({
  chain: z.enum(['near', 'base']),
  label: z.enum(['submit', 'approve', 'tamper', 'broadcast', 'twin']),
  hash: z.string().min(20).max(100),
  status: z.enum(['success', 'failure']),
  url: z.string().url(),
});

export const GoldenRunSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1),
  case: z.string().min(1),
  scenario: z.string().nullable(),
  recordedAt: z.string().datetime(),
  network: z.literal('testnet'),
  contractId: z.string().min(1),
  llmMode: z.enum(['record', 'live', 'replay']),
  planSha256: z.string().nullable(),
  taskId: z.string().nullable(),
  taskHash: z.string().nullable(),
  requests: z.array(z.strictObject({ request_id: z.string(), outcome: z.string(), reason: z.string().nullable(), pending_id: z.string().nullable() })),
  trace: z.array(z.strictObject({ t: z.number(), kind: z.string(), data: z.record(z.string(), z.unknown()) })),
  txs: z.array(TxSchema),
  run: z.strictObject({ k: z.number().int().min(1), n: z.number().int().min(1), model: z.string().min(1) }).nullable(),
  note: z.string().nullable(),
});

export type GoldenRun = z.infer<typeof GoldenRunSchema>;
export type GoldenTx = GoldenRun['txs'][number];

export const txUrl = (chain: 'near' | 'base', hash: string): string => (chain === 'near' ? NEARBLOCKS : BASESCAN) + hash;

export const goldenPath = (root: string, name: string): string => join(root, 'bench', 'golden', `${name}.json`);

// plain ASCII: every UTF-16 unit above 0x7F becomes a backslash-u escape
const asciiJson = (value: unknown): string => JSON.stringify(value, null, 2).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';

/** Validates, then writes `bench/golden/<name>.json`. Throws on a file that does not fit the schema, so a bad run is never stored. */
export function writeGolden(root: string, run: GoldenRun): string {
  const parsed = GoldenRunSchema.parse(run);
  const path = goldenPath(root, parsed.name);
  mkdirSync(join(root, 'bench', 'golden'), { recursive: true });
  writeFileSync(path, asciiJson(parsed));
  return path;
}

export function readGolden(path: string): GoldenRun {
  return GoldenRunSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// ---- docs/EVIDENCE.md ----

const TABLE_HEAD = ['| Date (UTC) | Run | Contract | Code hash | Wasm sha256 | Transactions |', '| --- | --- | --- | --- | --- | --- |'];

export const wasmSha256 = (root: string): string => createHash('sha256').update(readFileSync(join(root, 'contracts', 'airlock-policy', 'res', 'airlock_policy.wasm'))).digest('hex');

export function evidenceRow(run: GoldenRun, codeHash: string, wasmSha: string): string {
  const links = run.txs.map((t) => `[${t.label}](${t.url})`).join(' ');
  return `| ${run.recordedAt.slice(0, 10)} | ${run.name} | ${run.contractId} | ${codeHash} | ${wasmSha} | ${links} |`;
}

/** Adds one row to the golden section of docs/EVIDENCE.md, creating the section and its table header when missing. */
export function appendGoldenEvidence(path: string, row: string): void {
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === GOLDEN_HEADING);
  if (at < 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', GOLDEN_HEADING, '', ...TABLE_HEAD, row, '');
  } else {
    let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
    if (end < 0) end = lines.length;
    const body = lines.slice(at + 1, end);
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const lastRow = body.map((l) => l.startsWith('|')).lastIndexOf(true);
    body.splice(lastRow + 1, 0, row);
    lines.splice(at + 1, end - at - 1, ...body, '');
  }
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'));
}

// ---- recordings ----

/** The views AIR-246's console card of a held request is built from. `get_ledgers` is checked for the payee and the asset. */
export const CARD_VIEWS = ['get_request', 'get_ledgers', 'get_book', 'list_assets'] as const;

/** The card views missing from a chain recording file (all four when the file is absent or unreadable). */
export function missingCardViews(recordingPath: string): string[] {
  if (!existsSync(recordingPath)) return [...CARD_VIEWS];
  let entries: { kind?: unknown; method?: unknown }[];
  try {
    entries = (JSON.parse(readFileSync(recordingPath, 'utf8')) as { entries: { kind?: unknown; method?: unknown }[] }).entries;
  } catch {
    return [...CARD_VIEWS];
  }
  return CARD_VIEWS.filter((m) => !entries.some((e) => e.kind === 'view' && e.method === m));
}
