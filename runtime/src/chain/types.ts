// The chain client's wire types (AIR-160), imported by the console as `@airlock/runtime/chain-types`. Browser safe: zod and a type-only
// import of the book rows, never the NEAR client library and never a Node module. Every u64 and u128 is a decimal string (near-sdk U64 and U128).
// Contract answers go through the schemas below; an answer that does not fit is an error, never a silently repaired value.
import { z } from 'zod';

export type { BookEntryJson, BookRows } from '../dsl/book.ts';

/** A u64 or u128 on the wire: canonical decimal digits. */
const DecimalText = z.string().regex(/^(0|[1-9][0-9]*)$/);
const U8 = z.int().min(0).max(255);
const U16 = z.int().min(0).max(65535);
const U32 = z.int().min(0).max(4294967295);

// ---- requests ----

export const RequestStateSchema = z.enum(['Pending', 'Rejected', 'Expired', 'Blocked', 'Executing', 'Executed', 'Retryable', 'Failed']);
export type RequestState = z.infer<typeof RequestStateSchema>;

export const ExecInfoSchema = z.object({
  unsigned_hex: z.string().nullable(),
  big_r: z.string().nullable(),
  s: z.string().nullable(),
  recovery_id: U8.nullable(),
});
export type ExecInfo = z.infer<typeof ExecInfoSchema>;

const LabelsSchema = z.object({ recipient: U16, amount: U16, pc: U16 });
const DisplaySchema = z.object({ asset_symbol: z.string(), amount_decimal: z.string() });

/** `get_request` field for field (AIR-063). A tombstone (an expired record whose data was freed) has `tombstone: true` and blank content. */
export interface RequestView {
  request_id: string;
  id: string | null;
  state: RequestState;
  agent: string;
  task_id: string;
  asset: string;
  payee: string;
  amount: string;
  labels: { recipient: number; amount: number; pc: number };
  reason: string | null;
  book_status: string | null;
  display: { asset_symbol: string; amount_decimal: string } | null;
  created_ms: string;
  expires_ms: string | null;
  digest: string | null;
  exec: ExecInfo | null;
  tombstone?: true;
}

// The contract leaves a key out when its value is None (serde skip_serializing_if), so every optional field may be absent or null here.
const RequestViewRaw = z.object({
  request_id: z.string(),
  id: z.string().nullable().optional(),
  state: RequestStateSchema,
  agent: z.string().optional(),
  task_id: z.string().optional(),
  asset: z.string().optional(),
  payee: z.string().optional(),
  amount: DecimalText.optional(),
  labels: LabelsSchema.optional(),
  reason: z.string().nullable().optional(),
  book_status: z.string().nullable().optional(),
  display: DisplaySchema.nullable().optional(),
  created_ms: DecimalText.optional(),
  expires_ms: DecimalText.nullable().optional(),
  digest: z.string().nullable().optional(),
  exec: ExecInfoSchema.nullable().optional(),
});

const CONTENT_KEYS = ['task_id', 'asset', 'payee', 'amount', 'labels', 'reason', 'book_status', 'display', 'created_ms', 'expires_ms', 'digest', 'exec'] as const;

export const RequestViewSchema = RequestViewRaw.transform((v, ctx): RequestView => {
  const id = v.id ?? null;
  if (v.agent === undefined) {
    // a tombstone answers request_id, id and state only
    const stray = CONTENT_KEYS.filter((k) => v[k] !== undefined);
    if (stray.length > 0) {
      ctx.addIssue({ code: 'custom', message: `a record without an agent carries ${stray.join(', ')}` });
      return z.NEVER;
    }
    return {
      request_id: v.request_id,
      id,
      state: v.state,
      agent: '',
      task_id: '',
      asset: '',
      payee: '',
      amount: '0',
      labels: { recipient: 0, amount: 0, pc: 0 },
      reason: null,
      book_status: null,
      display: null,
      created_ms: '0',
      expires_ms: null,
      digest: null,
      exec: null,
      tombstone: true,
    };
  }
  const { task_id, asset, payee, amount, labels, created_ms } = v;
  if (task_id === undefined || asset === undefined || payee === undefined || amount === undefined || labels === undefined || created_ms === undefined) {
    ctx.addIssue({ code: 'custom', message: 'a record is missing task_id, asset, payee, amount, labels or created_ms' });
    return z.NEVER;
  }
  return {
    request_id: v.request_id,
    id,
    state: v.state,
    agent: v.agent,
    task_id,
    asset,
    payee,
    amount,
    labels,
    reason: v.reason ?? null,
    book_status: v.book_status ?? null,
    display: v.display ?? null,
    created_ms,
    expires_ms: v.expires_ms ?? null,
    digest: v.digest ?? null,
    exec: v.exec ?? null,
  };
});

/** The view of a `get_request` answer: null for JSON null, a filled-in view with `tombstone: true` for a tombstone, else a parse error. */
export function parseRequestView(raw: unknown): RequestView | null {
  if (raw === null || raw === undefined) return null;
  return RequestViewSchema.parse(raw);
}

// ---- ledgers, outcomes, signatures ----

export const AmountSchema = z.object({ spent: DecimalText, cap: DecimalText, remaining: DecimalText });
export type Amount = z.infer<typeof AmountSchema>;

export const LedgersViewSchema = z.object({
  asset_day: AmountSchema,
  payee_day: AmountSchema,
  payee_untrusted_day: AmountSchema,
  task_spent: DecimalText.nullable(),
});
export type LedgersView = z.infer<typeof LedgersViewSchema>;

export const SubmitOutcomeSchema = z.object({
  request_id: z.string(),
  outcome: z.enum(['allowed', 'escalated', 'blocked']),
  reason: z.string().nullable(),
  pending_id: z.string().nullable(),
});
export type SubmitOutcome = z.infer<typeof SubmitOutcomeSchema>;

export const SignedEventSchema = z.strictObject({
  request_id: z.string(),
  unsigned_hex: z.string(),
  big_r: z.string(),
  s: z.string(),
  recovery_id: U8,
});
export type SignedEvent = z.infer<typeof SignedEventSchema>;

// ---- registry and policy views ----

/** The shape of `AssetEntryView` (and of AIR-180's `analyze/ctx.ts` entry; both are structural types, keep them equal). */
export const AssetEntryViewJsonSchema = z.object({
  symbol: z.string(),
  decimals: U8,
  hard_cap: DecimalText,
  daily_cap: DecimalText,
  max_fee_per_gas: DecimalText,
  max_gas: DecimalText,
  quick_task_cap: DecimalText,
  path: z.string().nullable(),
});
export type AssetEntryViewJson = z.infer<typeof AssetEntryViewJsonSchema>;

export const AssetListSchema = z.array(z.tuple([z.string(), AssetEntryViewJsonSchema]));

export const PolicyViewJsonSchema = z.object({
  owner_id: z.string(),
  mpc_contract_id: z.string(),
  requires_tee: z.boolean(),
  paused: z.boolean(),
  flags: z.object({
    max_pending_per_agent: U32,
    pending_ttl_ms: DecimalText,
    hourly_escalation_budget: U32,
    lock_consecutive_rejects: U32,
    lock_rejects_per_day: U32,
    max_task_ttl_ms: DecimalText,
    max_task_actions: U8,
  }),
});
export type PolicyViewJson = z.infer<typeof PolicyViewJsonSchema>;

const BookEntryJsonSchema = z.object({
  cap: DecimalText.nullable(),
  daily_untrusted_budget: DecimalText,
  daily_limit: DecimalText,
  label: z.string(),
});

/** One page of `get_book`: `[key, entry]` pairs. */
export const BookPageSchema = z.array(z.tuple([z.string(), BookEntryJsonSchema]));

// ---- events (docs/events.md, the closed list of 26 names) ----

const Text = z.string();

/** The payload schemas of the twelve typed events. Strict: a missing or an extra field makes the line an `unknown_event`. */
export const EVENT_PAYLOAD_SCHEMAS = {
  submitted: z.strictObject({ task_hash: Text, count: U32, agent: Text }),
  allowed: z.strictObject({
    request_id: Text,
    asset: Text,
    payee: Text,
    amount: Text,
    asset_day_remaining: Text,
    payee_day_remaining: Text,
    task_remaining: Text.nullable(),
  }),
  escalated: z.strictObject({ request_id: Text, id: Text, reason: Text }),
  blocked: z.strictObject({ request_id: Text, reason: Text }),
  approved: z.strictObject({ request_id: Text, id: Text, digest: Text, approver: Text, block_height: Text }),
  rejected: z.strictObject({ request_id: Text, id: Text }),
  expired: z.strictObject({ request_id: Text, id: Text }),
  evm_unsigned: z.strictObject({ request_id: Text, unsigned_hex: Text }),
  signed: SignedEventSchema,
  paid: z.strictObject({ request_id: Text, payee: Text, amount: Text }),
  failed: z.strictObject({
    request_id: Text,
    reason: z.enum(['MpcFailed', 'MpcBadResponse', 'TransferFailed', 'InsufficientBalance']),
    retryable: z.boolean(),
  }),
  nonce_set: z.strictObject({ path: Text, nonce: Text }),
} as const;

export type TypedEventName = keyof typeof EVENT_PAYLOAD_SCHEMAS;
export type TypedEventPayloads = { [K in TypedEventName]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]> };

export const TYPED_EVENT_NAMES = Object.keys(EVENT_PAYLOAD_SCHEMAS) as TypedEventName[];

/** The names of the closed list that decode to `{ event, data }` with the payload unvalidated. */
export const GENERIC_EVENT_NAMES = [
  'escalations_locked',
  'escalations_reset',
  'agent_allowed',
  'agent_revoked',
  'agent_registered',
  'agent_removed',
  'task_key_set',
  'task_revoked',
  'asset_set',
  'asset_removed',
  'book_added',
  'book_removed',
  'flags_set',
  'paused',
] as const;
export type GenericEventName = (typeof GENERIC_EVENT_NAMES)[number];

export type UnknownChainEvent = { event: 'unknown_event'; name: string; raw: string };

export type ChainEvent =
  | { [K in TypedEventName]: { event: K; data: TypedEventPayloads[K] } }[TypedEventName]
  | { event: GenericEventName; data: Record<string, unknown> }
  | UnknownChainEvent;

const typedEventSchemas = TYPED_EVENT_NAMES.map((name) => z.object({ event: z.literal(name), data: EVENT_PAYLOAD_SCHEMAS[name] }));
const genericEventSchema = z.object({ event: z.enum(GENERIC_EVENT_NAMES), data: z.record(z.string(), z.unknown()) });
const unknownEventSchema = z.object({ event: z.literal('unknown_event'), name: z.string(), raw: z.string() });

export const ChainEventSchema = z.union([...typedEventSchemas, genericEventSchema, unknownEventSchema] as unknown as [
  z.ZodType<ChainEvent>,
  z.ZodType<ChainEvent>,
]);

// ---- the result of a batch ----

export interface BatchResult {
  taskHash: string;
  outcomes: SubmitOutcome[];
  txHash: string | null;
  events: ChainEvent[];
  recovered: boolean;
  views: RequestView[];
}

// a view already normalised by parseRequestView (every nullable key present), as a batch result carries it
const RequestViewNormalizedSchema = z.object({
  request_id: z.string(),
  id: z.string().nullable(),
  state: RequestStateSchema,
  agent: z.string(),
  task_id: z.string(),
  asset: z.string(),
  payee: z.string(),
  amount: DecimalText,
  labels: LabelsSchema,
  reason: z.string().nullable(),
  book_status: z.string().nullable(),
  display: DisplaySchema.nullable(),
  created_ms: DecimalText,
  expires_ms: DecimalText.nullable(),
  digest: z.string().nullable(),
  exec: ExecInfoSchema.nullable(),
  tombstone: z.literal(true).optional(),
});

export const BatchResultSchema = z.object({
  taskHash: z.string(),
  outcomes: z.array(SubmitOutcomeSchema),
  txHash: z.string().nullable(),
  events: z.array(ChainEventSchema),
  recovered: z.boolean(),
  views: z.array(RequestViewNormalizedSchema),
});
