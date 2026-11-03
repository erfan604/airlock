// AIR-305: the NEAR Intents 1Click quote leg. After the verdict has Allowed a payment, the runtime may ask 1Click for a `dry: true` quote of
// a cross-chain payout, and this module checks the quote against the allowed payment before anything could be signed. It imports no signer,
// no chain client and no key: a pass returns a record, a refusal returns a named reason, and neither signs, so "never signs" holds by
// construction (the test pins the import list). Dry and labelled: Intents has no testnet (hackathon rules Q-007), so every quote here is a
// mainnet price quote that moves no money, and a dry quote carries no deposit address at all (1Click docs, `dry`).
// Facts: notes/intents_1click_2026-11-03.md of the research repo (URLs, a live recording, what a dry quote does not carry).
// Amounts are decimal strings and BigInt only (money-lint directory).
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ONE_CLICK_URL = 'https://1click.chaindefuser.com';
export const INTENTS_LABEL = 'dry quote, mainnet prices, no funds move (Intents has no testnet)';

/** What the verdict allowed, in the units 1Click uses. `payee` is the destination address, `amountOut` the destination asset's base units. */
export interface AllowedPayout {
  /** The id of the allowed request: the quote record is bound to it. */
  requestId: string;
  payee: string;
  destinationAsset: string;
  /** The amount the payee must receive at least (base units of the destination asset, decimal string). */
  amountOut: string;
  originAsset: string;
  /** The most the payout may cost in the origin asset (decimal string): the Allow's own spend cap. */
  maxAmountIn: string;
  /** Refund addresses that are ours (origin chain); anything else is a hijacked refund. */
  refundTo: readonly string[];
  /** The authorization window, Unix ms: the quote deadline must fall inside it. */
  windowStartMs: bigint;
  windowEndMs: bigint;
  /** The widest slippage accepted, in basis points (1/100 of a percent); the request and the quote must both stay within it. */
  maxSlippageBps: bigint;
  /** The fee recipients the echoed `appFees` may name, each with its largest fee in basis points. Default none: any fee entry is refused. */
  allowedFees?: readonly { recipient: string; maxFeeBps: number }[];
}

export const REASONS = [
  'MalformedQuote',
  'NotDry',
  'RequestEchoMismatch',
  'RecipientMismatch',
  'RecipientNotOnDestinationChain',
  'DestinationAssetMismatch',
  'OriginAssetMismatch',
  'AmountOutBelowAllowed',
  'AmountInAboveCap',
  'SlippageTooWide',
  'RefundNotOurs',
  'DeadlineOutsideWindow',
  'UnexpectedDepositAddress',
  'MissingDepositAddress',
  'UnexpectedFee',
] as const;
export type Reason = (typeof REASONS)[number];

/** The record kept for an accepted quote. `depositAddress` is null for a dry quote (it has none). `binding` ties it to the allowed request id. */
export interface QuoteRecord {
  label: string;
  requestId: string;
  dry: boolean;
  depositAddress: string | null;
  correlationId: string;
  signature: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  deadline: string;
  binding: string;
}

export type QuoteCheck = { ok: true; record: QuoteRecord } | { ok: false; reason: Reason };

const dec = z.string().regex(/^(0|[1-9][0-9]*)$/);
const QuoteResponse = z.looseObject({
  quote: z.looseObject({
    depositAddress: z.string().min(1).optional(),
    amountIn: dec,
    minAmountIn: dec,
    amountOut: dec,
    minAmountOut: dec,
    deadline: z.string().optional(),
  }),
  quoteRequest: z.looseObject({
    dry: z.boolean(),
    swapType: z.string(),
    slippageTolerance: z.number(),
    originAsset: z.string(),
    depositType: z.string(),
    destinationAsset: z.string(),
    amount: dec,
    refundTo: z.string(),
    refundType: z.string(),
    recipient: z.string(),
    recipientType: z.string(),
    deadline: z.string(),
  }),
  signature: z.string().min(1),
  timestamp: z.string(),
  correlationId: z.string().min(1),
});

/** The request body of a quote for the allowed payout: EXACT_OUTPUT, so the payee gets the allowed amount and the slippage lands on our side. */
export function buildQuoteRequest(allowed: AllowedPayout, dry: boolean, deadlineIso: string): Record<string, string | boolean | number> {
  return {
    dry,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: Number(allowed.maxSlippageBps), // money-lint-allow: basis points of slippage, a small bounded config value, never an amount
    originAsset: allowed.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: allowed.destinationAsset,
    amount: allowed.amountOut,
    recipient: allowed.payee,
    recipientType: 'DESTINATION_CHAIN',
    refundTo: allowed.refundTo[0] ?? '',
    refundType: 'ORIGIN_CHAIN',
    deadline: deadlineIso,
  };
}

const ECHOED: readonly string[] = ['swapType', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline', 'slippageTolerance'];

/** The defaults 1Click adds to the echo of a request, each with the only value we accept (recorded 2026-11-03). */
const SERVER_DEFAULTS: Readonly<Record<string, (v: unknown) => boolean>> = {
  depositMode: (v) => v === 'SIMPLE',
  confidentiality: (v) => v === 'public',
  insured: (v) => v === false,
  quoteWaitingTimeMs: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0,
};

function sameAddress(a: string, b: string): boolean {
  const evm = /^0x[0-9a-fA-F]{40}$/;
  return evm.test(a) && evm.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseMs(iso: string): bigint | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : BigInt(t);
}

/**
 * Compare a 1Click quote response with the allowed payout and the request that was sent. Fixed reasons only: a reason never repeats a value
 * the server sent. `expectDry` is true for the runtime (it only ever asks for dry quotes); the non-dry branch exists so a recorded live-shape
 * quote can be checked in tests and is how a deposit address would be bound.
 */
export function checkQuote(allowed: AllowedPayout, sent: Readonly<Record<string, unknown>>, response: unknown, opts: { expectDry: boolean }): QuoteCheck {
  const refuse = (reason: Reason): QuoteCheck => ({ ok: false, reason });
  const parsed = QuoteResponse.safeParse(response);
  if (!parsed.success) return refuse('MalformedQuote');
  const { quote, quoteRequest: q } = parsed.data;

  if (q.dry !== opts.expectDry || sent['dry'] !== opts.expectDry) return refuse('NotDry');
  // the response echoes the request: a quote for a request we did not send (a proxy or a swapped body) is refused
  for (const key of ECHOED) {
    if (!Object.hasOwn(sent, key) || sent[key] !== (q as Record<string, unknown>)[key]) return refuse('RequestEchoMismatch');
  }

  // every other key of the echoed request is a server default we know, or a refusal: an extra key is a field we never asked for
  for (const [key, value] of Object.entries(q)) {
    if (key === 'appFees' || key === 'dry' || ECHOED.includes(key)) continue;
    const want = SERVER_DEFAULTS[key];
    if (want === undefined || !want(value)) return refuse('RequestEchoMismatch');
  }
  // fees: we ask for none, so an entry passes only when its recipient is on the allowed list and its fee is within that recipient's bound
  const fees = (q as Record<string, unknown>)['appFees'];
  if (fees !== undefined) {
    if (!Array.isArray(fees)) return refuse('RequestEchoMismatch');
    for (const fee of fees as unknown[]) {
      if (typeof fee !== 'object' || fee === null || Array.isArray(fee)) return refuse('RequestEchoMismatch');
      const keys = Object.keys(fee).sort();
      if (keys.length !== 2 || keys[0] !== 'fee' || keys[1] !== 'recipient') return refuse('RequestEchoMismatch');
      const { recipient, fee: bps } = fee as { recipient: unknown; fee: unknown };
      const ok = (allowed.allowedFees ?? []).some((a) => a.recipient === recipient && typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps <= a.maxFeeBps); // money-lint-allow: basis points, a bounded config value, never an amount
      if (!ok) return refuse('UnexpectedFee');
    }
  }

  if (!sameAddress(q.recipient, allowed.payee)) return refuse('RecipientMismatch');
  if (q.recipientType !== 'DESTINATION_CHAIN') return refuse('RecipientNotOnDestinationChain');
  if (q.destinationAsset !== allowed.destinationAsset) return refuse('DestinationAssetMismatch');
  if (q.originAsset !== allowed.originAsset) return refuse('OriginAssetMismatch');

  const want = BigInt(allowed.amountOut);
  const amountOut = BigInt(quote.amountOut);
  const minOut = BigInt(quote.minAmountOut);
  if (q.swapType === 'EXACT_OUTPUT' && BigInt(q.amount) !== want) return refuse('AmountOutBelowAllowed');
  if (amountOut < want || minOut < want) return refuse('AmountOutBelowAllowed');
  if (BigInt(quote.amountIn) > BigInt(allowed.maxAmountIn)) return refuse('AmountInAboveCap');
  // slippage: the request may not ask for more than the bound, and the quote's own spread (amountOut over minAmountOut) must fit it
  if (!Number.isInteger(q.slippageTolerance) || q.slippageTolerance < 0 || BigInt(q.slippageTolerance) > allowed.maxSlippageBps) return refuse('SlippageTooWide');
  if (minOut > amountOut || (amountOut - minOut) * 10000n > amountOut * allowed.maxSlippageBps) return refuse('SlippageTooWide');

  if (q.refundType !== 'ORIGIN_CHAIN' || !allowed.refundTo.some((r) => sameAddress(r, q.refundTo))) return refuse('RefundNotOurs');

  const requested = parseMs(q.deadline);
  if (requested === null || requested < allowed.windowStartMs || requested > allowed.windowEndMs) return refuse('DeadlineOutsideWindow');

  let depositAddress: string | null = null;
  let deadline = q.deadline;
  if (opts.expectDry) {
    // a dry quote has no deposit address, deadline or timeWhenInactive (1Click docs); one that carries it is not the quote we asked for
    if (quote.depositAddress !== undefined) return refuse('UnexpectedDepositAddress');
  } else {
    if (quote.depositAddress === undefined) return refuse('MissingDepositAddress');
    depositAddress = quote.depositAddress;
    const dl = quote.deadline === undefined ? null : parseMs(quote.deadline);
    if (dl === null || dl < allowed.windowStartMs || dl > allowed.windowEndMs) return refuse('DeadlineOutsideWindow');
    deadline = quote.deadline ?? deadline;
  }

  // the binding: the allowed request id, the deposit address (or none), the payee and the amounts, so a record cannot be replayed for another request
  const binding = createHash('sha256')
    .update(JSON.stringify([allowed.requestId, depositAddress, allowed.payee.toLowerCase(), allowed.destinationAsset, quote.amountOut, quote.amountIn, parsed.data.correlationId]))
    .digest('hex');
  return {
    ok: true,
    record: {
      label: opts.expectDry ? INTENTS_LABEL : 'live-shape quote (test fixture only)',
      requestId: allowed.requestId,
      dry: opts.expectDry,
      depositAddress,
      correlationId: parsed.data.correlationId,
      signature: parsed.data.signature,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      deadline,
      binding,
    },
  };
}

export interface DryQuoteOptions {
  fetch: typeof fetch;
  nowMs: () => bigint;
  /** Quote lifetime, ms (the deadline sent is now plus this, clamped to the end of the authorization window). Default 30 minutes. */
  ttlMs?: bigint;
  baseUrl?: string;
  /** Optional 1Click partner JWT (env only, never logged). Without it 1Click adds 0.25 percent to the fee; a dry quote works either way. */
  apiKey?: string;
}

export interface DryQuoteResult {
  check: QuoteCheck;
  sent: Record<string, string | boolean | number>;
  response: unknown;
}

/** Request one dry quote and check it. Always `dry: true`; a transport failure or a non-2xx answer is `MalformedQuote`, never a pass. */
export async function requestDryQuote(allowed: AllowedPayout, opts: DryQuoteOptions): Promise<DryQuoteResult> {
  const now = opts.nowMs();
  let end = now + (opts.ttlMs ?? 30n * 60n * 1000n);
  if (end > allowed.windowEndMs) end = allowed.windowEndMs;
  const sent = buildQuoteRequest(allowed, true, new Date(Number(end)).toISOString()); // money-lint-allow: epoch milliseconds for a Date, not an amount
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey !== undefined) headers['x-api-key'] = opts.apiKey;
  let response: unknown = null;
  try {
    const res = await opts.fetch(`${opts.baseUrl ?? ONE_CLICK_URL}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(sent) });
    if (!res.ok) return { check: { ok: false, reason: 'MalformedQuote' }, sent, response: null };
    response = await res.json();
  } catch {
    return { check: { ok: false, reason: 'MalformedQuote' }, sent, response: null };
  }
  return { check: checkQuote(allowed, sent, response, { expectDry: true }), sent, response };
}
