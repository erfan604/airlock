// Loader for the shared vector file (AIR-024) that the Rust crate and the Lean runner read too.
import { readFileSync } from 'node:fs';
import type { OwnerTask } from '../src/dsl/index.ts';

export interface VectorFile {
  labels: { valid: { name: string; mask: number }[]; invalid: string[] };
  payee_keys: { accept: { key: string }[]; reject: { key: string; error: string }[] };
  submit_rejections: { name: string; raw: string; error: string }[];
  verdicts: {
    name: string;
    request: Record<string, unknown> & { labels: { recipient: number; amount: number; pc: number } };
    label_names: { recipient: string[]; amount: string[]; pc: string[] };
    expect: string;
  }[];
  owner_task: Record<string, unknown> & { borsh_hex: string; sha256_hex: string };
}

export const vectors = JSON.parse(readFileSync(new URL('../../fixtures/verdict-vectors.json', import.meta.url), 'utf8')) as VectorFile;

// the ten OwnerTask fields by name, in order (the vector object also holds borsh_hex, sha256_hex, request_ids and the signature)
export function vectorTask(): OwnerTask {
  const t = vectors.owner_task;
  return {
    tag: t.tag,
    task_id: t.task_id,
    contract_id: t.contract_id,
    agent_id: t.agent_id,
    plan_sha256: t.plan_sha256,
    instruction_sha256_salted: t.instruction_sha256_salted,
    issued_ms: t.issued_ms,
    expires_ms: t.expires_ms,
    max_actions: t.max_actions,
    bounds: t.bounds,
  } as OwnerTask;
}

export const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
export const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// a request of the vector file with the action_index the file leaves out (the contract's SubmitRequest has it, the file predates it)
export function withActionIndex(raw: string): string {
  return raw.includes('"action_index"') ? raw : raw.replace('{', '{"action_index":0,');
}
