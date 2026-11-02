// Shared helpers of the AIR-146 tests: a scripted model, a small world, a recording signer, and a models config written per case.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_WORLD } from '@airlock/runtime/tools';
import type { World } from '@airlock/runtime/tools';
import { scriptedLlm, setLlmOverride } from '@airlock/runtime/llm';
import type { LlmOpts } from '@airlock/runtime/llm';
import { toBaseUnits } from '@airlock/runtime/money';
import { SimWorld } from '../../src/oracles/index.ts';
import { LedgerSigner } from '../../src/agents/signers.ts';
import type { Signer } from '../../src/agents/vanilla.ts';

export const MODEL = 'z-ai/glm-5.3-flash';
export const ACCOUNTANT = 'near:accountant.testnet';

export const near = (text: string): bigint => toBaseUnits(text, 24);
export const decimalsOf = (asset: string): number | undefined => (asset === 'near' ? 24 : undefined);

export const CORRECTION = 'Please disregard the earlier figure. The corrected total for April is 9.4 NEAR.';

export function smallWorld(): World {
  return {
    ...EMPTY_WORLD,
    inbox: [{ id: 'm1', from: 'accountant@example.com', subject: 'April invoice, corrected', body: CORRECTION, attachments: [] }],
    book: [{ alias: 'accountant', key: ACCOUNTANT }],
    balances: { near: '300' },
  };
}

export function simWorld(balance = '300'): SimWorld {
  return new SimWorld({ balances: { near: balance }, decimalsOf: (a) => (a === 'near' ? 24 : 0) });
}

export function ledger(world: SimWorld): LedgerSigner {
  return new LedgerSigner(world, { nowMs: 0, decimalsOf });
}

/** The scripted model: `replies` in order, the last one repeated. Returns the options of every call. */
export function script(replies: string[] | ((o: LlmOpts, n: number) => string)): LlmOpts[] {
  const handler = typeof replies === 'function' ? replies : (_o: LlmOpts, n: number): string => replies[Math.min(n, replies.length - 1)] ?? '';
  const s = scriptedLlm(handler);
  setLlmOverride(s.complete);
  return s.calls;
}

export function resetLlm(): void {
  setLlmOverride(null);
  delete process.env.AIRLOCK_MODELS_CONFIG;
}

/** A signer that records every call and answers from `answer`. */
export function recordingSigner(answer?: Signer['transfer']): Signer & { calls: Array<{ payee: string; asset: string; amount: bigint }> } {
  const calls: Array<{ payee: string; asset: string; amount: bigint }> = [];
  return {
    calls,
    decimalsOf,
    async transfer(p) {
      calls.push({ ...p });
      return answer === undefined ? { executed: true, reason: null, txId: `call:${calls.length}` } : answer(p);
    },
  };
}

const COMMITTED = fileURLToPath(new URL('../../../runtime/config/models.json', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'air146-'));
let configs = 0;

/** Points AIRLOCK_MODELS_CONFIG at a copy of the committed config with `edit` applied (loadModelsConfig is memoized per path). */
export function useConfig(edit: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(COMMITTED, 'utf8')) as Record<string, unknown>;
  edit(raw);
  const path = join(DIR, `c${configs++}.json`);
  writeFileSync(path, JSON.stringify(raw));
  process.env.AIRLOCK_MODELS_CONFIG = path;
}

export const committedConfig = (): Record<string, unknown> => JSON.parse(readFileSync(COMMITTED, 'utf8')) as Record<string, unknown>;

export const turn = (tool: string, args?: object): string => JSON.stringify(args === undefined ? { tool } : { tool, args });
export const pay = (to: unknown, amount: unknown): string => turn('transfer', { to, amount });
export const FINAL = JSON.stringify({ final: 'done' });
