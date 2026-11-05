// ActionRequest: what the runtime submits to the contract, field for field the contract's SubmitRequest (request.rs). There is no
// request id, nonce, path or recipient address field. The TypeScript side is stricter than the contract, which ignores extra keys.
// `parseActionRequest` is the raw-text entry: a parsed object cannot show a duplicate key (JSON.parse keeps the last value, and the
// contract reverts on a duplicate), so the text is scanned first.
import { z } from 'zod';
import { parseCanonicalDecimal } from '../money/index.ts';
import { assetForPayeeKey, validatePayeeKey } from './keys.ts';

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

const U64_MAX = (1n << 64n) - 1n;
const EVM_ASSET = /^evm:([1-9][0-9]*):native$/;
// AIR-109: a token on an EVM chain, `evm:<chain id>:erc20:0x<40 lowercase hex>`
const ERC20_ASSET = /^evm:([1-9][0-9]*):erc20:0x[0-9a-f]{40}$/;
const MAX_DEPTH = 64;

// the decimal rule of a u128 on the wire: ^(0|[1-9][0-9]*)$ and at most 2^128 - 1 (the strict parse at 0 decimals is exactly it)
function isU128Text(s: string): boolean {
  try {
    parseCanonicalDecimal(s, 0);
    return true;
  } catch {
    return false;
  }
}

function isAsset(asset: string): boolean {
  if (asset === 'near') return true;
  const m = EVM_ASSET.exec(asset) ?? ERC20_ASSET.exec(asset);
  return m !== null && (m[1] ?? '').length <= 20 && BigInt(m[1] ?? '0') <= U64_MAX;
}

function isPayee(payee: string): boolean {
  try {
    validatePayeeKey(payee);
    return true;
  } catch {
    return false;
  }
}

export const AmountText = z.string().refine(isU128Text, { message: 'not a u128 decimal' });
export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const Mask = z.int().min(0).max(32767);

export const ActionRequest = z
  .strictObject({
    task_id: z.string(),
    action_index: z.int().min(0).max(255),
    asset: z.string().refine(isAsset, { message: 'not near, evm:<chain id>:native or evm:<chain id>:erc20:0x<token>' }),
    payee: z.string().refine(isPayee, { message: 'not a canonical payee key' }),
    amount: AmountText,
    labels: z.strictObject({ recipient: Mask, amount: Mask, pc: Mask }),
    evm: z.strictObject({ gas_limit: AmountText, max_fee_per_gas: AmountText, max_priority_fee_per_gas: AmountText }).nullable(),
    // AIR-315: the flood-control origin (runtime/src/origin.ts); optional on the wire, the contract keys its escalation counters by it
    hints: z.strictObject({ plan_hash: Hex64, trace_digest: Hex64, origin: z.string().regex(/^(owner|[a-z]{1,8}:[0-9a-f]{16})$/).optional() }),
  })
  .superRefine((r, ctx) => {
    if (isAsset(r.asset) && isPayee(r.payee) && assetForPayeeKey(r.payee) !== r.asset) {
      ctx.addIssue({ code: 'custom', path: ['asset'], message: 'asset does not match payee' });
    }
    if (r.asset.endsWith(':native') !== (r.evm !== null)) {
      ctx.addIssue({ code: 'custom', path: ['evm'], message: 'evm parameters are present exactly for a native evm asset' });
    }
  });
export type ActionRequest = z.infer<typeof ActionRequest>;

// Walks the JSON text and throws on a key that appears twice in one object (keys compared after decoding, so an escaped spelling of
// a key counts). Anything that is not JSON is left to JSON.parse, which refuses it right after; the scan only fails early on it.
function scanDuplicateKeys(text: string): void {
  let i = 0;
  const n = text.length;
  const invalid = (): never => {
    throw new RequestError('invalid JSON');
  };
  const skipSpace = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const readString = (): string => {
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (c === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return invalid();
        }
      }
    }
    return invalid();
  };
  const readValue = (depth: number): void => {
    if (depth > MAX_DEPTH) throw new RequestError('too deep');
    skipSpace();
    const c = text[i];
    if (c === '{') {
      i++;
      const keys = new Set<string>();
      skipSpace();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        skipSpace();
        if (text[i] !== '"') invalid();
        const key = readString();
        if (keys.has(key)) throw new RequestError('duplicate key');
        keys.add(key);
        skipSpace();
        if (text[i] !== ':') invalid();
        i++;
        readValue(depth + 1);
        skipSpace();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        invalid();
      }
    }
    if (c === '[') {
      i++;
      skipSpace();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        readValue(depth + 1);
        skipSpace();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        invalid();
      }
    }
    if (c === '"') {
      readString();
      return;
    }
    const start = i;
    while (i < n && !',]} \t\n\r'.includes(text.charAt(i))) i++;
    if (i === start) invalid();
  };
  readValue(0);
  skipSpace();
  if (i < n) invalid();
}

/** The raw-text entry: refuses a duplicate key anywhere, then parses and validates. Errors name field paths, never values. */
export function parseActionRequest(text: string): ActionRequest {
  if (typeof text !== 'string') throw new RequestError('not text');
  scanDuplicateKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError('invalid JSON');
  }
  const result = ActionRequest.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.')))];
    throw new RequestError(`invalid request: ${fields.join(', ')}`);
  }
  return result.data;
}
