// Builds the task the owner signs (AIR-185). The console derives everything from the plan, the owner's words and its own chain reads
// with the shared analyzer; nothing the runtime says about bounds or the preview is used. Chain time, never the browser clock, sets the
// issue and expiry times. A refusal is a closed text and signs nothing. No number parsing here (lint): ids and times are built with
// integer arithmetic and BigInt.
import { analyzePlan, bookFromRows, limitsFromPolicy, registryFromRows, toOwnerBounds } from '@airlock/runtime/analyze';
import type { Analysis, AnalysisErrorCode } from '@airlock/runtime/analyze';
import { TASK_TAG, ownerTaskBorsh, planSha256, sha256Hex } from '@airlock/runtime/dsl';
import type { CheckedPlan, OwnerTask } from '@airlock/runtime/dsl';
import type { ChainSnapshot } from '../chain/reads.ts';
import { renderTaskCard } from './card.ts';
import type { CardLine } from './card.ts';

export type RefusalCode = AnalysisErrorCode | 'RuntimeDiffers' | 'PlanHashMismatch' | 'PlanInvalid' | 'KeyNotRegistered' | 'KeyUnsupported';
export type Refusal = { code: RefusalCode; text: string };

export type BuildEnv = { agentId: string; contractId: string; rand(n: number): Uint8Array };
export type BuildOk = { ok: true; task: OwnerTask; bytes: Uint8Array; card: CardLine[]; analysis: Analysis; saltHex: string };
export type BuildResult = BuildOk | { ok: false; refusal: Refusal };

const MAX_TTL_MS = 900_000;

export const REFUSAL_TEXT: Record<Exclude<RefusalCode, 'TooManyActions'>, string> = {
  ExceedsQuickCap: 'above the quick cap in this version',
  TooManyBounds: 'This plan pays more than 16 payees. Split it.',
  UnsupportedShape: 'This plan has more than one loop. Not supported in this version.',
  NoBounds: 'Nothing in this plan can be approved in advance, every payment would ask you. Not available in this version.',
  RuntimeDiffers: "Runtime preview differs from your device's preview. Not signing.",
  PlanHashMismatch: "The runtime's plan hash does not match the plan it sent. Not signing.",
  PlanInvalid: 'The runtime sent a plan that is not valid. Not signing.',
  KeyNotRegistered: 'Your task key is not registered on chain. Register it first.',
  KeyUnsupported: 'This browser cannot keep a signing key that cannot be exported. Use Chrome 137 or later, Safari 17 or later, or Firefox 129 or later.',
};

const TOO_MANY_ACTIONS = 'This plan can make more payments than one task allows. Split it into smaller requests.';

export function refusal(code: RefusalCode, analysis?: Analysis): Refusal {
  if (code !== 'TooManyActions') return { code, text: REFUSAL_TEXT[code] };
  const items = (analysis?.asksYou ?? []).filter((a) => a.code === 'TooManyActions').map((a) => a.text);
  return { code, text: [TOO_MANY_ACTIONS, ...items].join(' ') };
}

const HEX = '0123456789abcdef';
const toHex = (b: Uint8Array): string => [...b].map((x) => HEX.charAt(x >> 4) + HEX.charAt(x & 15)).join('');

/** UUID version 7: a 48 bit big-endian millisecond timestamp, version 7, variant 10, the rest from ten random bytes. */
export function uuidv7(ms: number, rand10: Uint8Array): string {
  if (rand10.length !== 10) throw new RangeError('uuidv7 needs ten random bytes');
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 48) throw new RangeError('uuidv7 timestamp is not a 48 bit integer');
  const b = new Uint8Array(16);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  b[6] = 0x70 | ((rand10[0] ?? 0) & 0x0f);
  b[7] = rand10[1] ?? 0;
  b[8] = 0x80 | ((rand10[2] ?? 0) & 0x3f);
  for (let i = 3; i < 10; i++) b[6 + i] = rand10[i] ?? 0;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The lower of 15 minutes and the contract's maximum. A policy value of more than nine digits is above 15 minutes anyway. */
function ttlMs(policyTtl: string): number {
  if (!/^[0-9]{1,9}$/.test(policyTtl)) return MAX_TTL_MS;
  return Math.min(MAX_TTL_MS, JSON.parse(policyTtl) as number);
}

export function buildTask(plan: CheckedPlan, instruction: string, snap: ChainSnapshot, env: BuildEnv): BuildResult {
  const registry = registryFromRows(snap.assets);
  const analysis = analyzePlan(plan, { ownerText: instruction, book: bookFromRows(snap.book), registry, limits: limitsFromPolicy(snap.policy) });
  const first = analysis.errors[0];
  if (first !== undefined) return { ok: false, refusal: refusal(first, analysis) };

  const taskId = uuidv7(snap.blockMs, env.rand(10));
  const salt = env.rand(16);
  const issued = snap.blockMs;
  const task: OwnerTask = {
    tag: TASK_TAG,
    task_id: taskId,
    contract_id: env.contractId,
    agent_id: env.agentId,
    plan_sha256: planSha256(plan),
    instruction_sha256_salted: sha256Hex(Uint8Array.from([...salt, ...new TextEncoder().encode(instruction)])),
    issued_ms: issued,
    expires_ms: issued + ttlMs(snap.policy.flags.max_task_ttl_ms),
    max_actions: analysis.maxActions,
    bounds: toOwnerBounds(analysis),
  };
  const bytes = ownerTaskBorsh(task);
  return { ok: true, task, bytes, card: renderTaskCard(bytes, registry), analysis, saltHex: toHex(salt) };
}
