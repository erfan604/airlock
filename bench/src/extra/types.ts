// The shapes of the `extra` section of a results file and of the static rows (AIR-288). Plain data and their strict schemas; nothing here runs.
import { z } from 'zod';

/** The common fields of a static row: not an agent case, a test or a script that is run once and counted. */
export interface StaticRowBase {
  id: string;
  group: string;
  covered_by: string;
  expect: string;
  /** ids of `not-run.json` rows this row replaces in the Not run section */
  covers?: string[];
}

/**
 * A contract row runs sandbox tests by exact name; a card row runs a test script of the web package and reads its two TAP counts; a unit row (AIR-289)
 * calls one function of `@airlock/runtime/dsl` in process on each input and compares the outcome name with `expect`: `canonicalEvm` gives `reject`
 * (a KeyError), `same` (the result is the address part of `book`, when the row names a book key) or `different`; `checkPlan` gives the PlanRejected
 * code or `ok`.
 */
export type UnitFn = 'canonicalEvm' | 'checkPlan';
export interface UnitInput {
  input: unknown;
  expect: string;
}
export type StaticRow = StaticRowBase &
  (
    | { kind: 'contract'; crate: string; test_bin: string; tests: string[] }
    | { kind: 'card'; cwd: string; argv: string[]; needs: string; passed_re: string; of_re: string }
    | { kind: 'unit'; fn: UnitFn; book?: string; inputs: UnitInput[] }
  );

export interface ExecutedRow {
  id: string;
  group: string;
  kind: string;
  passed: number;
  of: number;
  status: 'passed' | 'failed' | 'skipped';
  covered_by: string;
  expect: string;
  covers: string[];
}

export interface ExtraCaseRow {
  id: string;
  group: string;
  tags: string[];
  a1: string;
  a2: string;
}

export interface FieldContentCounts {
  cases: number;
  runs: number;
  auto: number;
  gate_rows: number;
  gate_auto: number;
}

export interface ExtraSection {
  cases: ExtraCaseRow[];
  mismatches: number;
  rows: ExecutedRow[];
  field_content: Record<'A1' | 'A2', FieldContentCounts>;
}

const Count = z.int().min(0);

export const ExecutedRowSchema = z.strictObject({
  id: z.string(),
  group: z.string(),
  kind: z.string(),
  passed: Count,
  of: Count,
  status: z.enum(['passed', 'failed', 'skipped']),
  covered_by: z.string(),
  expect: z.string(),
  covers: z.array(z.string()),
});

const FieldContentCountsSchema = z.strictObject({ cases: Count, runs: Count, auto: Count, gate_rows: Count, gate_auto: Count });

export const ExtraSectionSchema = z.strictObject({
  cases: z.array(z.strictObject({ id: z.string(), group: z.string(), tags: z.array(z.string()), a1: z.string(), a2: z.string() })),
  mismatches: Count,
  rows: z.array(ExecutedRowSchema),
  field_content: z.strictObject({ A1: FieldContentCountsSchema, A2: FieldContentCountsSchema }),
});

const Regex = z.string().refine((s) => {
  try {
    new RegExp(s, 'm');
    return true;
  } catch {
    return false;
  }
}, 'not a regular expression');

const Base = { id: z.string().min(1), group: z.string().min(1), covered_by: z.string().min(1), expect: z.string().min(1), covers: z.array(z.string()).optional() };

/** `bench/cases/should/static-rows.json`: an array of rows, each strict. */
export const StaticRowsSchema = z.array(
  z.discriminatedUnion('kind', [
    z.strictObject({ ...Base, kind: z.literal('contract'), crate: z.string().min(1), test_bin: z.string().min(1), tests: z.array(z.string().min(1)).min(1) }),
    z.strictObject({
      ...Base,
      kind: z.literal('card'),
      cwd: z.string().min(1),
      argv: z.array(z.string().min(1)).min(1),
      needs: z.string().min(1),
      passed_re: Regex,
      of_re: Regex,
    }),
    z.strictObject({
      ...Base,
      kind: z.literal('unit'),
      fn: z.enum(['canonicalEvm', 'checkPlan']),
      book: z.string().min(1).optional(),
      inputs: z.array(z.strictObject({ input: z.unknown(), expect: z.string().min(1) })).min(1),
    }),
  ]),
);

/** The empty counts of a results file that has no extra run yet. */
export const NO_FIELD_CONTENT: ExtraSection['field_content'] = {
  A1: { cases: 0, runs: 0, auto: 0, gate_rows: 0, gate_auto: 0 },
  A2: { cases: 0, runs: 0, auto: 0, gate_rows: 0, gate_auto: 0 },
};
