// The trace store of the Task page (AIR-184): the row model, the pure reducer and the EventSource store behind `useSyncExternalStore`.
// This file and src/components/Specimen.tsx are the only ones lint lets read a property named `raw`, and this one and the evidence parser the
// only ones that call `wrapUntrusted`. `rowOf` is the only code that reads `e.data`: it builds typed text cells for values from closed sets
// and `Untrusted` cells for anything an outsider could have written, so no component ever holds outside text as a string.
import { formatBaseUnits } from '@airlock/runtime/money';
import { TOOL_NAMES, labelFromName, labelsToBits, untrustedChannels, validatePayeeKey } from '@airlock/runtime/dsl';
import type { ChannelName, LabelName } from '@airlock/runtime/dsl';
import type { AssetRegistry } from '@airlock/runtime/analyze';
import { wrapUntrusted } from '../components/untrusted.ts';
import type { Untrusted } from '../components/untrusted.ts';
import type { VerdictState } from '../components/verdict.ts';
import { CALC_OP_NAMES, isPlainObject, parseTraceEvent } from './trace.ts';
import type { TraceEventWire, TraceKind } from './trace.ts';

export type TraceCell = { name: string; text: string } | { name: string; untrusted: Untrusted; channel: ChannelName };

export type TraceRow = {
  key: string;
  kind: TraceKind;
  item: string | null;
  cells: TraceCell[];
  seals: LabelName[];
  stamp: VerdictState | null;
};

// ---- closed sets ------------------------------------------------------------------------------------------------------------------------

const ITEM = /^[A-Za-z0-9._-]{1,64}$/;
const SCHEMA_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const WORD = /^[A-Za-z:]{1,40}$/;
const HASH64 = /^[0-9a-f]{64}$/;
const HASH64_0X = /^(0x)?[0-9a-f]{64}$/;
const BASE58_TX = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,77})(\.[0-9]{0,76}[1-9])?$/;
const DIGITS = /^[0-9]{1,78}$/;
const NEAR_OR_EVM_ASSET = /^(near|evm:[0-9]{1,10}:native)$/;
const REQUEST_ID = /^[0-9a-f]{1,128}:[0-9]{1,9}$/;
const STEP_WORD = /^[a-z]{1,8}$/;
const MAX_CELLS = 32;
const MAX_STEP = 16;
export const MAX_ROWS = 300;

const own = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const isToolName = (v: unknown): v is string => typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
const isCalcOp = (v: unknown): v is string => typeof v === 'string' && (CALC_OP_NAMES as readonly string[]).includes(v);

function labelName(v: unknown): LabelName | null {
  if (typeof v !== 'string') return null;
  try {
    labelFromName(v);
    return v as LabelName;
  } catch {
    return null;
  }
}

/** The names of a list that `labelFromName` accepts, in order, once each. */
function labelNames(v: unknown): LabelName[] {
  if (!Array.isArray(v)) return [];
  const out: LabelName[] = [];
  for (const x of v) {
    const n = labelName(x);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The first untrusted channel of a set of labels, else `other`. */
function channelOf(labels: readonly LabelName[]): ChannelName {
  return untrustedChannels(labelsToBits(labels))[0] ?? 'other';
}

// ---- cells ------------------------------------------------------------------------------------------------------------------------------

const text = (name: string, value: string): TraceCell => ({ name, text: value });

/** The text of an outside value: a string as it is, anything else as its JSON. */
function outsideText(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

function outside(name: string, v: unknown, channel: ChannelName): TraceCell | null {
  const u = wrapUntrusted(outsideText(v));
  return u === null ? null : { name, untrusted: u, channel };
}

const push = (cells: TraceCell[], c: TraceCell | null): void => {
  if (c !== null) cells.push(c);
};

function sealsOf(...lists: unknown[]): LabelName[] {
  const out: LabelName[] = [];
  for (const l of lists) for (const n of labelNames(l)) if (!out.includes(n)) out.push(n);
  return out;
}

const requestTail = (v: unknown): string | null => (matches(v, REQUEST_ID) ? `#${v.slice(v.lastIndexOf(':') + 1)}` : null);

// ---- one builder per kind ---------------------------------------------------------------------------------------------------------------

type Built = { cells: TraceCell[]; seals: LabelName[]; stamp: VerdictState | null };
const built = (cells: TraceCell[], seals: LabelName[] = [], stamp: VerdictState | null = null): Built => ({ cells, seals, stamp });

function planRow(d: Record<string, unknown>): Built {
  const h = own(d, 'planSha256');
  return built(matches(h, HASH64) ? [text('plan', `PLAN ${h.slice(0, 12)}`)] : []);
}

function callRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const tool = own(d, 'tool');
  if (isToolName(tool)) cells.push(text('tool', tool));
  const label = labelName(own(d, 'label'));
  const raw = own(d, 'raw');
  if (label !== null && !label.startsWith('Untrusted:')) {
    cells.push(text('output', `${outsideText(raw).length} characters`));
  } else {
    // an untrusted label, or a label that is not one of the 15 names: the output is outside text either way
    push(cells, outside('output', raw, label === null ? 'other' : channelOf([label])));
  }
  return built(cells, label === null ? [] : [label]);
}

function extractRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const labels = labelNames(own(d, 'labels'));
  const fields = own(d, 'fields');
  if (isPlainObject(fields)) {
    for (const key of Object.keys(fields)) {
      if (cells.length >= MAX_CELLS) break;
      if (SCHEMA_KEY.test(key)) push(cells, outside(key, own(fields, key), channelOf(labels)));
    }
  }
  return built(cells, labels);
}

function lookupRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const labels = labelNames(own(d, 'labels'));
  const channel = channelOf(labels);
  push(cells, outside('key', own(d, 'key'), channel));
  const found = own(d, 'found');
  if (typeof found === 'boolean') {
    cells.push(text('found', found ? 'in your book' : 'not in your book'));
    if (found) push(cells, outside('result', own(d, 'result'), channel));
  }
  return built(cells, labels);
}

function calcRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const labels = labelNames(own(d, 'labels'));
  const op = own(d, 'op');
  if (isCalcOp(op)) cells.push(text('op', op));
  const result = own(d, 'result');
  if (typeof result === 'boolean') cells.push(text('result', String(result)));
  else if (matches(result, CANONICAL_DECIMAL)) cells.push(text('result', result));
  else push(cells, outside('result', result, channelOf(labels)));
  return built(cells, labels);
}

function branchRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const kind = own(d, 'kind');
  if (kind === 'if' || kind === 'for') cells.push(text('branch', kind));
  const taken = own(d, 'taken');
  if (typeof taken === 'boolean') cells.push(text('taken', taken ? 'yes' : 'no'));
  const iterations = own(d, 'iterations');
  if (isCount(iterations)) cells.push(text('iterations', String(iterations)));
  const truncated = own(d, 'truncated');
  if (typeof truncated === 'boolean') cells.push(text('truncated', truncated ? 'yes' : 'no'));
  else if (isCount(truncated)) cells.push(text('truncated', String(truncated)));
  return built(cells, sealsOf(own(d, 'pc')));
}

function amountText(digits: string, asset: unknown, registry: AssetRegistry | null): string {
  const entry = typeof asset === 'string' ? registry?.get(asset) : undefined;
  if (entry !== undefined) {
    try {
      return `${formatBaseUnits(BigInt(digits), entry.decimals)} ${entry.symbol}`;
    } catch {
      // out of range for the money formatter: show the digits
    }
  }
  return `${digits} base units`;
}

function proposedRow(d: Record<string, unknown>, registry: AssetRegistry | null): Built {
  const cells: TraceCell[] = [];
  const action = own(d, 'action');
  if (action === 'transfer' || action === 'evm_transfer') cells.push(text('action', action));
  const payee = own(d, 'payee');
  if (typeof payee === 'string') {
    let canonical = true;
    try {
      validatePayeeKey(payee);
    } catch {
      canonical = false;
    }
    if (canonical) cells.push(text('payee', payee));
    else push(cells, outside('payee', payee, channelOf(labelNames(own(d, 'recipientLabels')))));
  }
  const asset = own(d, 'asset');
  if (matches(asset, NEAR_OR_EVM_ASSET)) cells.push(text('asset', asset));
  const amount = own(d, 'amount');
  if (matches(amount, DIGITS)) cells.push(text('amount', amountText(amount, asset, registry)));
  return built(cells, sealsOf(own(d, 'recipientLabels'), own(d, 'amountLabels'), own(d, 'pc')));
}

function submittedRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const count = own(d, 'count');
  if (isCount(count)) cells.push(text('submitted', `${count} submitted`));
  const taskHash = own(d, 'taskHash');
  if (matches(taskHash, HASH64)) cells.push(text('task', taskHash.slice(0, 12)));
  const tx = own(d, 'txHash');
  if (matches(tx, BASE58_TX)) cells.push(text('tx', tx));
  return built(cells);
}

const STAMP_OF: Record<string, VerdictState> = { allowed: 'allowed', escalated: 'held', blocked: 'blocked' };

function verdictRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const outcome = own(d, 'outcome');
  const stamp = typeof outcome === 'string' && Object.hasOwn(STAMP_OF, outcome) ? (STAMP_OF[outcome] ?? null) : null;
  const reason = own(d, 'reason');
  if (matches(reason, WORD)) cells.push(text('reason', reason));
  const pending = own(d, 'pending_id');
  if (matches(pending, /^[0-9]{1,18}$/)) cells.push(text('pending', `#${pending}`));
  else if (isCount(pending)) cells.push(text('pending', `#${pending}`));
  const tail = requestTail(own(d, 'request_id'));
  if (tail !== null) cells.push(text('request', tail));
  return built(cells, [], stamp);
}

function signedRow(d: Record<string, unknown>): Built {
  const cells = [text('signed', 'SIGNED')];
  const tail = requestTail(own(d, 'request_id'));
  if (tail !== null) cells.push(text('request', tail));
  return built(cells);
}

function broadcastRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const hash = own(d, 'hash');
  if (matches(hash, HASH64_0X)) cells.push(text('hash', hash.slice(0, 10)));
  const status = own(d, 'status');
  if (status === 'success' || status === 'reverted') cells.push(text('status', status));
  return built(cells);
}

/** A step path of numbers and short lowercase words, joined by points; anything else is null. */
function stepPath(v: unknown): string | null {
  const parts = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (parts === null || parts.length === 0 || parts.length > MAX_STEP) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (isCount(p)) out.push(String(p));
    else if (matches(p, STEP_WORD)) out.push(p);
    else return null;
  }
  return out.join('.');
}

function errorRow(d: Record<string, unknown>): Built {
  const cells: TraceCell[] = [];
  const code = own(d, 'code');
  if (matches(code, WORD)) cells.push(text('code', code));
  const step = stepPath(own(d, 'step'));
  if (step !== null) cells.push(text('step', step));
  return built(cells, sealsOf(own(d, 'labels')));
}

/** The answer of a read-only run: text derived from outside data, so it is a Specimen like any other outside value. */
function sayRow(d: Record<string, unknown>): Built {
  const labels = labelNames(own(d, 'labels'));
  const text = own(d, 'text');
  const cell = typeof text === 'string' ? outside('answer', text, channelOf(labels)) : null;
  return built(cell === null ? [] : [cell], labels);
}

/** Builds the row of one event. `id` is the position the server gave it; `registry` turns an amount into text with its symbol. */
export function rowOf(id: number, e: TraceEventWire, registry: AssetRegistry | null): TraceRow {
  const d = e.data;
  let b: Built;
  switch (e.kind) {
    case 'plan':
      b = planRow(d);
      break;
    case 'call':
      b = callRow(d);
      break;
    case 'extract':
      b = extractRow(d);
      break;
    case 'lookup':
      b = lookupRow(d);
      break;
    case 'calc':
      b = calcRow(d);
      break;
    case 'branch':
      b = branchRow(d);
      break;
    case 'proposed':
      b = proposedRow(d, registry);
      break;
    case 'submitted':
      b = submittedRow(d);
      break;
    case 'verdict':
      b = verdictRow(d);
      break;
    case 'signed':
      b = signedRow(d);
      break;
    case 'broadcast':
      b = broadcastRow(d);
      break;
    case 'error':
      b = errorRow(d);
      break;
    case 'say':
      b = sayRow(d);
      break;
  }
  const rawItem = own(d, 'item');
  let item: string | null = null;
  if (matches(rawItem, ITEM)) item = rawItem;
  else if (str(rawItem) !== undefined) push(b.cells, outside('item', rawItem, 'other'));
  return { key: String(id), kind: e.kind, item, cells: b.cells, seals: b.seals, stamp: b.stamp };
}

// ---- reducer ----------------------------------------------------------------------------------------------------------------------------

export type EndState = 'done' | 'failed' | 'aborted';

export type TraceState = {
  rows: TraceRow[];
  /** Rows dropped from the front because the list keeps 300. */
  collapsed: number;
  malformed: number;
  stale: boolean;
  ended: EndState | null;
  /** The position of the last event applied; -1 before the first. */
  lastId: number;
};

export type TraceAction =
  | { type: 'event'; id: number; event: TraceEventWire; registry?: AssetRegistry | null }
  | { type: 'malformed' }
  | { type: 'drop' }
  | { type: 'open' }
  | { type: 'end'; state: EndState }
  | { type: 'reset' };

export function initialTraceState(): TraceState {
  return { rows: [], collapsed: 0, malformed: 0, stale: false, ended: null, lastId: -1 };
}

/** Pure. A finished run ignores everything; an id at or below `lastId` is a replay and adds nothing. */
export function reduce(s: TraceState, a: TraceAction): TraceState {
  if (a.type === 'reset') return initialTraceState();
  if (s.ended !== null) return s;
  switch (a.type) {
    case 'event': {
      if (a.id <= s.lastId) return s;
      const rows = [...s.rows, rowOf(a.id, a.event, a.registry ?? null)];
      const over = Math.max(0, rows.length - MAX_ROWS);
      return { ...s, rows: over > 0 ? rows.slice(over) : rows, collapsed: s.collapsed + over, lastId: a.id };
    }
    case 'malformed':
      return { ...s, malformed: s.malformed + 1 };
    case 'drop':
      return s.stale ? s : { ...s, stale: true };
    case 'open':
      return s.stale ? { ...s, stale: false } : s;
    case 'end':
      return { ...s, ended: a.state, stale: false };
  }
}

// ---- the store --------------------------------------------------------------------------------------------------------------------------

export interface TraceStore {
  connect(runId: string): void;
  disconnect(): void;
  subscribe(cb: () => void): () => void;
  getSnapshot(): TraceState;
}

export type TraceStoreDeps = {
  EventSource?: typeof EventSource;
  raf?: (cb: () => void) => unknown;
  registry?: () => AssetRegistry | null;
};

const RUN_ID = /^[0-9a-f]{32}$/;
const EVENT_ID = /^(0|[1-9][0-9]{0,8})$/;

const defaultRaf = (cb: () => void): unknown => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16));

function endStateOf(data: unknown): EndState {
  if (typeof data !== 'string') return 'failed';
  try {
    const v: unknown = JSON.parse(data);
    const state = isPlainObject(v) ? v.state : undefined;
    return state === 'done' || state === 'aborted' ? state : 'failed';
  } catch {
    return 'failed';
  }
}

const isFresh = (s: TraceState): boolean => s.rows.length === 0 && s.lastId === -1 && !s.stale && s.ended === null && s.malformed === 0 && s.collapsed === 0;

export function createTraceStore(deps: TraceStoreDeps = {}): TraceStore {
  const raf = deps.raf ?? defaultRaf;
  let state = initialTraceState();
  let source: EventSource | null = null;
  let generation = 0;
  let queue: TraceAction[] = [];
  let scheduled = false;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const cb of [...listeners]) cb();
  };

  function flush(): void {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const registry = deps.registry?.() ?? null;
    const before = state;
    for (const a of batch) state = reduce(state, a.type === 'event' ? { ...a, registry } : a);
    if (state !== before) notify();
  }

  function enqueue(a: TraceAction): void {
    queue.push(a);
    if (!scheduled) {
      scheduled = true;
      raf(flush);
    }
  }

  function close(): void {
    generation += 1;
    source?.close();
    source = null;
    queue = [];
  }

  return {
    connect(runId: string): void {
      if (!RUN_ID.test(runId)) throw new TypeError('bad run id: 32 lowercase hex digits expected');
      const ES = deps.EventSource ?? globalThis.EventSource;
      close();
      const wasFresh = isFresh(state);
      state = initialTraceState();
      if (!wasFresh) notify();
      const mine = generation;
      const es = new ES(`/runs/${runId}/events`);
      source = es;
      es.addEventListener('trace', (m: Event) => {
        if (mine !== generation) return;
        const msg = m as MessageEvent;
        const event = typeof msg.data === 'string' ? parseTraceEvent(msg.data) : null;
        const idText = msg.lastEventId;
        if (event === null || !EVENT_ID.test(idText)) return enqueue({ type: 'malformed' });
        // the id is at most nine digits, and JSON.parse of digits is the exact conversion with no float step
        enqueue({ type: 'event', id: JSON.parse(idText) as number, event });
      });
      es.addEventListener('end', (m: Event) => {
        if (mine !== generation) return;
        enqueue({ type: 'end', state: endStateOf((m as MessageEvent).data) });
        // closed here, in the handler: a finished run is not a dropped one and the browser must not reconnect
        es.close();
        if (source === es) source = null;
      });
      es.onopen = () => {
        if (mine === generation) enqueue({ type: 'open' });
      };
      es.onerror = () => {
        if (mine === generation) enqueue({ type: 'drop' });
      };
    },
    disconnect(): void {
      close();
    },
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot(): TraceState {
      return state;
    },
  };
}
