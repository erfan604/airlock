// AIR-246: reads the golden run files of AIR-166 (bench/golden/<name>.json) for the replay demo. Only the fields the demo shows are checked; a file
// that is absent is a `MissingRecording` that names its path, and a demo never starts half way. Nothing here reads the environment.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Tx = z.object({
  chain: z.enum(['near', 'base']),
  label: z.string(),
  hash: z.string(),
  status: z.enum(['success', 'failure']),
  url: z.string(),
});

export const GoldenFileSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  scenario: z.string().nullable(),
  recordedAt: z.string(),
  contractId: z.string(),
  requests: z.array(z.object({ request_id: z.string(), outcome: z.string(), reason: z.string().nullable(), pending_id: z.string().nullable() })),
  trace: z.array(z.object({ t: z.number(), kind: z.string(), data: z.record(z.string(), z.unknown()) })),
  txs: z.array(Tx),
});

export type GoldenFile = z.infer<typeof GoldenFileSchema>;
export type GoldenTx = z.infer<typeof Tx>;

/** A recording the demo needs is not on disk (or does not parse). `message` is `MISSING <path>`, the line `scripts/demo.ts` prints. */
export class MissingRecording extends Error {
  constructor(readonly path: string) {
    super(`MISSING ${path}`);
    this.name = 'MissingRecording';
  }
}

export function readGoldenFile(path: string): GoldenFile {
  if (!existsSync(path)) throw new MissingRecording(path);
  const parsed = GoldenFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new MissingRecording(path);
  return parsed.data;
}

/** The four golden files of the three acts. Act 2 reads b01-escalate and, for the approve link, b01-approve. */
export const ACT_FILES = ['u01', 'b01-escalate', 'b01-approve', 'tamper'] as const;
export type ActFile = (typeof ACT_FILES)[number];

export function readActFiles(goldenDir: string): Record<ActFile, GoldenFile> {
  const out = {} as Record<ActFile, GoldenFile>;
  for (const name of ACT_FILES) out[name] = readGoldenFile(join(goldenDir, `${name}.json`));
  return out;
}
