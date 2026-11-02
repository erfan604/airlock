// The seam between the chain client and the network. `ChainTransport` is the only thing the client calls; `LiveTransport` is the only
// code here that touches the network or a key. `RecordingTransport` records the live traffic and `ReplayTransport` answers the
// recorded views without a signer and without the network (AIR-246 reads recorded views only; no consumer replays a submit).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Account, actions, baseEncode } from 'near-api-js';
import type { JsonRpcProvider, Provider, SignedTransaction, Signer } from 'near-api-js';
import { InvalidNonceError, UnknownTransactionError } from 'near-api-js/rpc-errors';
import { z } from 'zod';
import { ChainError } from './errors.ts';
import { decodeOutcomeEvents } from './events.ts';
import type { RpcPool } from './rpc.ts';
import type { ChainEvent } from './types.ts';

/** One transaction outcome as the client reads it. `failure` is the panic text without the prefix `Smart contract panicked: `. */
export interface RpcTx {
  hash: string | null;
  returnValue: unknown;
  logs: ChainEvent[];
  failure: string | null;
}

/** A signed transaction whose hash is known before anything is sent; `signed` is opaque to the client. */
export interface PreparedTx {
  hash: string;
  signed: unknown;
}

export interface ChainTransport {
  /** The policy contract this transport talks to, when it knows (recordings carry it). */
  readonly contractId?: string;
  view(method: string, args: Record<string, unknown>): Promise<unknown>;
  prepare(method: 'submit_batch', args: Record<string, unknown>, gas: bigint): Promise<PreparedTx>;
  submit(tx: PreparedTx): Promise<RpcTx>;
  txStatus(hash: string): Promise<RpcTx | 'pending' | null>;
  blockNanosec(): Promise<string>;
}

// ---- reading a node's transaction outcome ----

const PANIC_PREFIX = 'Smart contract panicked: ';

interface OutcomeJson {
  status?: unknown;
  transaction?: { hash?: unknown };
  transaction_outcome?: { id?: unknown };
  receipts_outcome?: { outcome: { executor_id: string; logs: string[] } }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function failureText(failure: unknown): string {
  if (isRecord(failure)) {
    const action = failure.ActionError;
    const kind = isRecord(action) ? action.kind : undefined;
    const call = isRecord(kind) ? kind.FunctionCallError : undefined;
    const exec = isRecord(call) ? call.ExecutionError : undefined;
    if (typeof exec === 'string') return exec.startsWith(PANIC_PREFIX) ? exec.slice(PANIC_PREFIX.length) : exec;
  }
  return JSON.stringify(failure);
}

/** The outcome as an RpcTx when it is final (a SuccessValue or a Failure), else null. */
function toRpcTx(response: unknown, contractId: string): RpcTx | null {
  const outcome = response as OutcomeJson;
  const status = outcome.status;
  if (!isRecord(status)) return null;
  const hashValue = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
  const hash = typeof hashValue === 'string' ? hashValue : null;
  const logs = decodeOutcomeEvents({ receipts_outcome: outcome.receipts_outcome ?? [] }, contractId);
  if ('Failure' in status) return { hash, returnValue: undefined, logs, failure: failureText(status.Failure) };
  const value = status.SuccessValue;
  if (typeof value !== 'string') return null;
  const text = Buffer.from(value, 'base64').toString('utf8');
  return { hash, returnValue: text === '' ? null : (JSON.parse(text) as unknown), logs, failure: null };
}

// near-api-js `Account` reads the access key nonce and a block through its provider; route those reads through the pool so they fail over.
function poolProvider(pool: RpcPool): Provider {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return (...args: unknown[]) =>
        pool.run((provider) => {
          const method = (provider as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[prop];
          if (typeof method !== 'function') throw new TypeError(`provider has no method ${prop}`);
          return method.apply(provider, args);
        });
    },
  };
  return new Proxy({}, handler) as unknown as Provider;
}

export interface LiveTransportConfig {
  contractId: string;
  agentAccountId: string;
  signer: Signer;
  pool: RpcPool;
}

/**
 * The live transport. A batch is signed exactly once (`prepare`) and every send carries the same bytes (`submit`), so a resend can
 * never become a second transaction. `Account.callFunctionRaw`, `callFunction` and `signAndSendTransaction` are never used for
 * `submit_batch`: they sign inside the call and sign again with a new nonce on InvalidNonceError.
 */
export class LiveTransport implements ChainTransport {
  readonly contractId: string;
  private account: Account;

  constructor(private readonly cfg: LiveTransportConfig) {
    this.contractId = cfg.contractId;
    this.account = this.newAccount();
  }

  // one Account per signer for the process lifetime: its NonceManager caches the nonce, so two batches in flight never share one;
  // a fresh one only after InvalidNonceError, when the cached nonce is known to be stale
  private newAccount(): Account {
    return new Account(this.cfg.agentAccountId, poolProvider(this.cfg.pool), this.cfg.signer);
  }

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    // a provider view takes `method` (an Account call takes `methodName`)
    const result = await this.cfg.pool.run((p) => p.callFunction({ contractId: this.contractId, method, args }));
    return result === undefined ? null : result;
  }

  async blockNanosec(): Promise<string> {
    // the numeric `timestamp` is above 2^53 and loses digits; `timestamp_nanosec` is a string
    const block = await this.cfg.pool.run((p) => p.viewBlock({ finality: 'final' }));
    return block.header.timestamp_nanosec;
  }

  async prepare(method: 'submit_batch', args: Record<string, unknown>, gas: bigint): Promise<PreparedTx> {
    const tx = await this.account.createTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(method, args, gas, 0n)],
      publicKey: await this.cfg.signer.getPublicKey(),
    });
    const { txHash, signedTransaction } = await this.cfg.signer.signTransaction(tx);
    return { hash: baseEncode(txHash), signed: signedTransaction };
  }

  async submit(tx: PreparedTx): Promise<RpcTx> {
    const signed = tx.signed as SignedTransaction;
    let response: unknown;
    try {
      response = await this.cfg.pool.send((p: JsonRpcProvider) => p.sendTransactionUntil(signed, 'FINAL'));
    } catch (error) {
      if (error instanceof InvalidNonceError) this.account = this.newAccount();
      throw error;
    }
    // sendTransactionUntil does not throw for a failed outcome: the panic is in the status
    const outcome = toRpcTx(response, this.contractId);
    if (outcome === null) throw new Error('send_tx answered without a final status');
    return { ...outcome, hash: outcome.hash ?? tx.hash };
  }

  async txStatus(hash: string): Promise<RpcTx | 'pending' | null> {
    let response: unknown;
    try {
      // 'NONE' answers at once; 'FINAL' holds an unknown hash for about 10 s and ends in HTTP 408
      response = await this.cfg.pool.run((p) => p.viewTransactionStatus({ txHash: hash, accountId: this.cfg.agentAccountId, waitUntil: 'NONE' }));
    } catch (error) {
      if (error instanceof UnknownTransactionError) return null;
      throw error;
    }
    const outcome = toRpcTx(response, this.contractId);
    return outcome === null ? 'pending' : { ...outcome, hash: outcome.hash ?? hash };
  }
}

// ---- recording and replay ----

/** Key order never changes the key: objects are written with sorted keys, a key whose value is undefined is left out. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((item: unknown) => canonicalJson(item)).join(',') + ']';
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) parts.push(JSON.stringify(key) + ':' + canonicalJson(record[key]));
  }
  return '{' + parts.join(',') + '}';
}

export interface RecordedEntry {
  kind: 'view' | 'submit' | 'block';
  method: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface RecordingFile {
  version: 1;
  contractId: string;
  entries: RecordedEntry[];
}

const RecordingFileSchema = z.object({
  version: z.literal(1),
  contractId: z.string(),
  entries: z.array(z.object({ kind: z.enum(['view', 'submit', 'block']), method: z.string(), args: z.record(z.string(), z.unknown()), result: z.unknown() })),
});

/**
 * Wraps a transport and writes every answer to `file` (`runtime/recordings/chain/<name>.json`). The file is rewritten after every call
 * through a temp file and a rename, so a crashed run leaves a valid file. A recording starts empty: it never reads an older file.
 * A `submit` entry carries the method and arguments given to `prepare` and is written after `submit` answers.
 */
export class RecordingTransport implements ChainTransport {
  private readonly entries: RecordedEntry[] = [];
  private readonly prepared = new Map<string, { method: string; args: Record<string, unknown> }>();

  constructor(
    private readonly inner: ChainTransport,
    private readonly file: string,
  ) {}

  get contractId(): string | undefined {
    return this.inner.contractId;
  }

  private record(entry: RecordedEntry): void {
    this.entries.push(entry);
    const body: RecordingFile = { version: 1, contractId: this.inner.contractId ?? '', entries: this.entries };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(body, null, 1) + '\n');
    renameSync(temp, this.file);
  }

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.inner.view(method, args);
    this.record({ kind: 'view', method, args, result });
    return result;
  }

  async blockNanosec(): Promise<string> {
    const result = await this.inner.blockNanosec();
    this.record({ kind: 'block', method: 'block', args: {}, result });
    return result;
  }

  async prepare(method: 'submit_batch', args: Record<string, unknown>, gas: bigint): Promise<PreparedTx> {
    const tx = await this.inner.prepare(method, args, gas);
    this.prepared.set(tx.hash, { method, args });
    return tx;
  }

  async submit(tx: PreparedTx): Promise<RpcTx> {
    const result = await this.inner.submit(tx);
    const call = this.prepared.get(tx.hash) ?? { method: 'submit_batch', args: {} };
    this.record({ kind: 'submit', method: call.method, args: call.args, result });
    return result;
  }

  txStatus(hash: string): Promise<RpcTx | 'pending' | null> {
    return this.inner.txStatus(hash);
  }
}

const replayMiss = (what: string): ChainError => new ChainError('ReplayMiss', `replay: ${what}`);

/**
 * Answers `view` by the exact (method, canonical JSON of args) key and `blockNanosec` from the recorded block entries. Each key is a
 * queue: its recorded results in order, the last one repeating. An unrecorded view throws `ReplayMiss`, and `prepare`, `submit` and
 * `txStatus` always do. It never takes a signer and never touches the network.
 */
export class ReplayTransport implements ChainTransport {
  readonly contractId: string;
  private readonly views = new Map<string, { results: unknown[]; next: number }>();
  private readonly blocks: string[] = [];
  private blockNext = 0;

  constructor(file: string) {
    const parsed = RecordingFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    this.contractId = parsed.contractId;
    for (const entry of parsed.entries) {
      if (entry.kind === 'view') {
        const key = viewKey(entry.method, entry.args);
        const queue = this.views.get(key);
        if (queue) queue.results.push(entry.result);
        else this.views.set(key, { results: [entry.result], next: 0 });
      } else if (entry.kind === 'block' && typeof entry.result === 'string') {
        this.blocks.push(entry.result);
      }
    }
  }

  async view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const queue = this.views.get(viewKey(method, args));
    if (queue === undefined) throw replayMiss(`no recorded view ${method} ${canonicalJson(args).slice(0, 200)}`);
    const index = Math.min(queue.next, queue.results.length - 1);
    queue.next += 1;
    return structuredClone(queue.results[index]);
  }

  async blockNanosec(): Promise<string> {
    if (this.blocks.length === 0) throw replayMiss('no recorded block');
    const index = Math.min(this.blockNext, this.blocks.length - 1);
    this.blockNext += 1;
    return this.blocks[index] as string;
  }

  async prepare(): Promise<PreparedTx> {
    throw replayMiss('a replay transport cannot prepare a transaction');
  }

  async submit(): Promise<RpcTx> {
    throw replayMiss('a replay transport cannot submit');
  }

  async txStatus(): Promise<RpcTx | 'pending' | null> {
    throw replayMiss('a replay transport has no transaction status');
  }
}

const viewKey = (method: string, args: Record<string, unknown>): string => `${method}\n${canonicalJson(args)}`;
