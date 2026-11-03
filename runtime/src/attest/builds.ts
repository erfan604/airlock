// AIR-309: evidence about which NEAR AI builds answer, and the reviewed rotation of the pinned policy. Nothing here relaxes a check: a build
// seen in a report is only a claim until the Intel-verified quote agrees (the os_measurements row compares them), and rotation edits the
// policy file only after the whole verification passes with the candidate's values added.
import { createHash } from 'node:crypto';
import type { Attestation, VerifyPolicy } from './types.ts';

/** The measurements that name one build, as the report claims them (the pin rows prove the verified quote agrees). */
export interface Build {
  compose_hash: string;
  mr_td: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): v is string => typeof v === 'string';

function buildOfReport(report: unknown): Build | null {
  const r = obj(report);
  try {
    const raw = obj(r?.info)?.tcb_info;
    const tcb = obj(text(raw) ? JSON.parse(raw) : raw);
    if (tcb === null || !text(tcb.app_compose) || !text(tcb.mrtd) || !text(tcb.rtmr0) || !text(tcb.rtmr1) || !text(tcb.rtmr2)) return null;
    return {
      compose_hash: createHash('sha256').update(Buffer.from(tcb.app_compose, 'utf8')).digest('hex'),
      mr_td: tcb.mrtd.toLowerCase(),
      rtmr0: tcb.rtmr0.toLowerCase(),
      rtmr1: tcb.rtmr1.toLowerCase(),
      rtmr2: tcb.rtmr2.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** The gateway build and the build of each returned model report in a raw report body; null where a report is missing or unreadable. */
export function buildsOf(rawBody: string): { gateway: Build | null; models: (Build | null)[] } {
  try {
    const b = obj(JSON.parse(rawBody));
    const models = Array.isArray(b?.model_attestations) ? (b.model_attestations as unknown[]).map(buildOfReport) : [];
    return { gateway: buildOfReport(b?.gateway_attestation), models };
  } catch {
    return { gateway: null, models: [] };
  }
}

export interface SampleRun {
  att: Attestation;
  /** the raw report body; empty when no report was fetched */
  body: string;
}

export interface DistinctBuild {
  model_build: Build | null;
  gateway_build: Build | null;
  count: number;
  verified: number;
  /** names of the rows that failed in this build's runs, sorted and unique */
  failed_rows: string[];
  first_report_sha256: string;
}

export interface SampleSummary {
  n: number;
  distinct: DistinctBuild[];
}

/** Runs `one` n times in sequence and groups the answers by (gateway build, model build). */
export async function sampleBuilds(n: number, one: () => Promise<SampleRun>): Promise<SampleSummary> {
  if (!Number.isInteger(n) || n < 1) throw new Error('sample size must be a positive integer');
  const groups = new Map<string, DistinctBuild>();
  for (let i = 0; i < n; i++) {
    const { att, body } = await one();
    const b = body === '' ? { gateway: null, models: [] as (Build | null)[] } : buildsOf(body);
    const model = b.models[0] ?? null;
    const key = JSON.stringify([b.gateway, model]);
    const g = groups.get(key) ?? { model_build: model, gateway_build: b.gateway, count: 0, verified: 0, failed_rows: [], first_report_sha256: att.report_sha256 };
    g.count += 1;
    if (att.status === 'VERIFIED') g.verified += 1;
    g.failed_rows = [...new Set([...g.failed_rows, ...att.checks.filter((c) => !c.ok).map((c) => c.name)])].sort();
    groups.set(key, g);
  }
  return { n, distinct: [...groups.values()] };
}

/** Printable lines for a summary: one block per distinct build. */
export function formatSample(s: SampleSummary): string[] {
  const lines = [`SAMPLE ${s.n} reports, ${s.distinct.length} distinct build(s)`];
  s.distinct.forEach((d, i) => {
    lines.push(`build ${i + 1}: ${d.count} of ${s.n} reports, ${d.verified} VERIFIED, failed rows: ${d.failed_rows.length === 0 ? 'none' : d.failed_rows.join(',')}`);
    for (const [who, b] of [['model', d.model_build], ['gateway', d.gateway_build]] as const) {
      lines.push(b === null ? `  ${who}: no build read` : `  ${who}: compose_hash ${b.compose_hash} mr_td ${b.mr_td} rtmr0 ${b.rtmr0} rtmr1 ${b.rtmr1} rtmr2 ${b.rtmr2}`);
    }
    lines.push(`  first report_sha256 ${d.first_report_sha256 === '' ? 'none' : d.first_report_sha256}`);
  });
  return lines;
}

/** The rows a rotation may repair: the pin rows of the model report. Any other failing row refuses the rotation. */
const PIN_ROW = /^model(\[\d+\])?\.(os_measurements|compose_pin)$/;

export interface RotateInput {
  model: string;
  /** compose hash of the build to add, from the failing compose_pin row of an earlier run */
  composeHash: string;
  reason: string;
  now: Date;
  /** the policy as parsed from the file, with its `_` keys */
  policy: VerifyPolicy & Record<string, unknown>;
  /** the fresh report: raw body, and its verification under the CURRENT policy */
  rawBody: string;
  current: Attestation;
  /** verifies the same body with the same nonce under another policy (here: the policy with the candidate added) */
  verifyWith: (policy: VerifyPolicy) => Promise<Attestation>;
}

export interface RotationLogEntry {
  date: string;
  model: string;
  compose_hash: string;
  report_sha256: string;
  reason: string;
}

const add = (list: readonly string[], v: string): string[] => (list.includes(v) ? [...list] : [...list, v]);

/** Returns the policy with the build added and a log entry, or throws with the reason. The input policy is not changed. */
export async function rotatePolicy(input: RotateInput): Promise<{ policy: VerifyPolicy & Record<string, unknown>; entry: RotationLogEntry }> {
  const { current } = input;
  if (input.reason.trim() === '') throw new Error('a reason is required');
  if (!/^[0-9a-f]{64}$/.test(input.composeHash)) throw new Error('compose hash must be 64 lowercase hex characters');
  if (current.status === 'UNATTESTED' || input.rawBody === '') throw new Error('no report was fetched, nothing to rotate');
  if (current.status === 'VERIFIED') throw new Error('the report already passes the current policy, nothing to rotate');
  const other = current.checks.filter((c) => !c.ok && !PIN_ROW.test(c.name)).map((c) => c.name);
  if (other.length > 0) throw new Error(`refused: other checks fail: ${other.join(', ')}`);
  const { models } = buildsOf(input.rawBody);
  const build = models[0];
  if (models.length !== 1 || build === null || build === undefined) throw new Error('refused: expected exactly one readable model report');
  if (build.compose_hash !== input.composeHash) throw new Error(`refused: the fresh report is for compose hash ${build.compose_hash}, not ${input.composeHash}`);
  const old = input.policy.models?.[input.model];
  if (old === undefined) throw new Error(`policy has no pins for ${input.model}; add the first build by hand in a reviewed commit`);
  const next = JSON.parse(JSON.stringify(input.policy)) as VerifyPolicy & Record<string, unknown>;
  next.models = {
    ...next.models,
    [input.model]: {
      mr_td: add(old.mr_td, build.mr_td),
      rtmr0: add(old.rtmr0, build.rtmr0),
      rtmr1: add(old.rtmr1, build.rtmr1),
      rtmr2: add(old.rtmr2, build.rtmr2),
      compose_hash: add(old.compose_hash, build.compose_hash),
    },
  };
  // the proof that no other check fails: the whole verification, every row, must pass with only the pins widened
  const after = await input.verifyWith(next);
  if (after.status !== 'VERIFIED') throw new Error(`refused: with the build added the report still fails: ${after.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
  const entry: RotationLogEntry = { date: input.now.toISOString(), model: input.model, compose_hash: build.compose_hash, report_sha256: current.report_sha256, reason: input.reason.trim() };
  const log = Array.isArray(next['_rotate_log']) ? (next['_rotate_log'] as unknown[]) : [];
  next['_rotate_log'] = [...log, entry];
  return { policy: next, entry };
}
