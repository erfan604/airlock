// The records of the bench runner (AIR-220): one strict RunRecord per (case, config, run), the transcript of a run, and the results file.
// Transcripts are written with every non-ASCII character as a backslash-u escape: model output holds em dashes, and attack payloads are
// non-ASCII at times, and the pre-commit hook refuses a literal em dash in a staged line.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LlmCall } from '@airlock/runtime/llm';
import type { TraceEvent } from '@airlock/runtime/interpreter';
import type { Group } from './cases.ts';
import type { Config, PaymentFact } from './types.ts';

const CONFIGS = ['V0', 'V1', 'V1-tight', 'V2', 'V3', 'A1', 'A2'] as const;

export const PaymentFactSchema = z.strictObject({
  id: z.string(),
  payee: z.string(),
  asset: z.string(),
  amount: z.string(),
  outcome: z.enum(['ALLOW', 'ESCALATE', 'BLOCK']),
  reason: z.string().nullable(),
  attackerInfluenced: z.boolean(),
  legitMatch: z.boolean(),
});

export const RunRecordSchema = z.strictObject({
  case: z.string(),
  config: z.enum(CONFIGS),
  model: z.string(),
  run: z.int().min(0),
  kind: z.enum(['attack', 'benign']),
  status: z.enum(['DONE', 'NO_PLAN', 'NO_TASK', 'ERROR']),
  error: z.string().nullable(),
  payments: z.array(PaymentFactSchema),
  attackSucceeded: z.boolean().nullable(),
  legitCompleted: z.boolean(),
  costUsd: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
  latencyMs: z.int().min(0),
  standInCalls: z.int().min(0),
  llmCalls: z.int().min(0),
  fieldOutcomes: z.strictObject({ chosen: z.int().min(0), null: z.int().min(0), other: z.int().min(0) }).nullable(),
  transcript: z.string(),
  derived: z.literal(true).optional(),
});

export interface RunRecord {
  case: string;
  config: Config;
  model: string;
  /** counts from 0 */
  run: number;
  /** attack: the case world holds a payload; benign: a utility or control case */
  kind: 'attack' | 'benign';
  status: 'DONE' | 'NO_PLAN' | 'NO_TASK' | 'ERROR';
  error: string | null;
  payments: PaymentFact[];
  attackSucceeded: boolean | null;
  legitCompleted: boolean;
  /** USD as canonical decimal text, summed in nano-USD over the calls that needed a new request */
  costUsd: string;
  latencyMs: number;
  standInCalls: number;
  llmCalls: number;
  fieldOutcomes: { chosen: number; null: number; other: number } | null;
  /** path relative to the recorded directory, `transcripts/<case>.<config>.<run>.json` */
  transcript: string;
  derived?: true;
}

export const ResultsFileSchema = z.strictObject({
  meta: z.strictObject({
    name: z.string(),
    model: z.string(),
    quarantine_model: z.string(),
    temperature: z.number(),
    seed: z.int(),
    n: z.int().min(1),
    configs: z.array(z.enum(CONFIGS)),
    hooks: z.enum(['none', 'product']),
    budget_usd: z.string(),
    bench_commit: z.string(),
    verdict_cli_sha256: z.string(),
  }),
  case_meta: z.record(z.string(), z.strictObject({ group: z.string(), legitIsPayment: z.boolean(), tags: z.array(z.string()) })),
  not_run: z.array(z.unknown()),
  runs: z.array(RunRecordSchema),
  assume_compromise: z.unknown().optional(),
});

export interface ResultsFile {
  meta: {
    name: string;
    model: string;
    quarantine_model: string;
    temperature: number;
    seed: number;
    n: number;
    configs: Config[];
    hooks: 'none' | 'product';
    budget_usd: string;
    bench_commit: string;
    verdict_cli_sha256: string;
  };
  case_meta: Record<string, { group: Group; legitIsPayment: boolean; tags: string[] }>;
  not_run: unknown[];
  runs: RunRecord[];
  assume_compromise?: unknown;
}

/** The transcript of one run (a run key is `(case, config, run)`). */
export interface Transcript {
  request: string;
  plan: unknown;
  trace: TraceEvent[];
  payments: PaymentFact[];
  says: string[];
  answer: string;
  llm: LlmCall[];
}

/** The key of a run as the checkpoint file uses it. */
export const runKey = (r: { case: string; config: string; run: number }): string => `${r.case}|${r.config}|${r.run}`;

const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A copy sorted by (case, config, run) with code-unit comparison of the strings (no locale). */
export function sortRuns<T extends { case: string; config: string; run: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => codeUnits(a.case, b.case) || codeUnits(a.config, b.config) || a.run - b.run);
}

// every UTF-16 unit above 0x7F as a lowercase backslash-u escape; the escaped text parses back to the same strings
function asciiOnly(text: string): string {
  return text.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** JSON as pure ASCII; a bigint (never expected) is written as its decimal text. */
export function asciiJson(value: unknown, indent?: number): string {
  return asciiOnly(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), indent));
}

export function writeTranscript(path: string, t: Transcript): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, asciiJson(t, 1) + '\n', 'utf8');
}

export function readTranscript(path: string): Transcript {
  return JSON.parse(readFileSync(path, 'utf8')) as Transcript;
}
