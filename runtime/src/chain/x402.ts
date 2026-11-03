// AIR-168: x402 v2 `PAYMENT-SIGNATURE` assembly for one live settlement on Base Sepolia. The contract signs an EIP-3009 authorization
// (AIR-109) and emits `x402_signed`; this module decodes that event and wraps it in the v2 payload the facilitator settles. Everything
// is a string or BigInt: no Number conversion of an amount ever happens here.
import { z } from 'zod';

const EVENT_PREFIX = 'EVENT_JSON:';
const NETWORK = 'eip155:84532';
/** The Base Sepolia test USDC (AIR-109 registry entry), lower case. */
export const USDC_BASE_SEPOLIA = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

/** The `x402_signed` payload (docs/events.md). `r` and `s` are 64 hex without `0x`. */
export interface X402Signed {
  id: string;
  from: string;
  to: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
  v: 27 | 28;
  r: string;
  s: string;
}

const addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const dec = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const SignedSchema = z.object({
  id: z.string().min(1),
  from: addr,
  to: addr,
  value: dec,
  valid_after: dec,
  valid_before: dec,
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  v: z.union([z.literal(27), z.literal(28)]),
  r: hex32,
  s: hex32,
});

/** One `EVENT_JSON:` log line carrying the event `x402_signed`, else null. Never throws. */
export function decodeX402Signed(line: string): X402Signed | null {
  if (typeof line !== 'string' || !line.startsWith(EVENT_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.standard !== 'airlock' || o.event !== 'x402_signed') return null;
  if (!Array.isArray(o.data) || o.data.length !== 1) return null;
  const parsed = SignedSchema.safeParse(o.data[0]);
  return parsed.success ? parsed.data : null;
}

/** One entry of `accepts`. Unknown fields are kept so `accepted` echoes the server's requirement exactly. */
export const PaymentRequirementsV2 = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  amount: dec,
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive().optional(),
  extra: z.looseObject({ name: z.string().optional(), version: z.string().optional() }).optional(),
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2>;

export const PaymentRequiredV2 = z.looseObject({
  x402Version: z.literal(2),
  resource: z.looseObject({}).optional(),
  accepts: z.array(PaymentRequirementsV2).min(1),
});
export type PaymentRequiredV2 = z.infer<typeof PaymentRequiredV2>;

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: unknown;
  accepted: PaymentRequirementsV2;
  payload: {
    signature: string;
    authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
  };
}

/** A fixed message naming the field, never a server value. */
export class X402Mismatch extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`x402 mismatch: ${field}`);
    this.name = 'X402Mismatch';
    this.field = field;
  }
}

/** The payload for `required.accepts[index]`, which is echoed as `accepted` (a deep copy, never edited). */
export function buildPaymentPayload(ev: X402Signed, required: PaymentRequiredV2, index: number): PaymentPayloadV2 {
  const picked = required.accepts[index];
  if (picked === undefined) throw new X402Mismatch('index');
  const accepted = structuredClone(picked) as PaymentRequirementsV2;
  if (accepted.scheme !== 'exact') throw new X402Mismatch('scheme');
  if (accepted.network !== NETWORK) throw new X402Mismatch('network');
  if (accepted.asset.toLowerCase() !== USDC_BASE_SEPOLIA) throw new X402Mismatch('asset');
  if (ev.to.toLowerCase() !== accepted.payTo.toLowerCase()) throw new X402Mismatch('payTo');
  if (BigInt(ev.value) !== BigInt(accepted.amount)) throw new X402Mismatch('amount');
  if (ev.valid_after !== '0') throw new X402Mismatch('valid_after');
  const signature = `0x${ev.r}${ev.s}${ev.v.toString(16).padStart(2, '0')}`;
  const out: PaymentPayloadV2 = {
    x402Version: 2,
    accepted,
    payload: {
      signature,
      authorization: { from: ev.from, to: ev.to, value: ev.value, validAfter: '0', validBefore: ev.valid_before, nonce: ev.nonce },
    },
  };
  if (required.resource !== undefined) out.resource = structuredClone(required.resource);
  return out;
}

/** base64 of JSON.stringify(p): the `PAYMENT-SIGNATURE` header value. */
export function encodePaymentHeader(p: PaymentPayloadV2): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}
