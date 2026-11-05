// The MCP session (AIR-313): what `airlock-mcp` knows between two tool calls, and every label it hands out. The client's model is an
// untrusted planner, so nothing it sends decides a label: read tools wrap every string they return in a handle whose label is the tool
// channel of TOOL_CHANNEL, and `pay` labels its two value arguments from the handle table, the product grounder and the book (the rules are
// in docs/ARCHITECTURE.md, section MCP server). The owner's request and the task bounds are fixed at construction from the owner's config;
// no method changes them. `pay` builds one ActionRequest and submits it with the chain client's submitBatch, and returns the contract's
// outcome as it came back. Amounts are bigint or decimal text throughout.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { registryFromRows } from '../analyze/index.ts';
import { ChainError } from '../chain/errors.ts';
import type { ChainClient } from '../chain/near.ts';
import { ActionRequest, KeyError, OwnerTask, TASK_TAG, labelsToBits, payeeKey, resolveAlias, sha256Hex } from '../dsl/index.ts';
import type { BookRows, LabelName } from '../dsl/index.ts';
import { grounder } from '../interpreter/grounding.ts';
import { ROOT_PC, bookResult, mk, sortedLabels } from '../interpreter/value.ts';
import type { LVal } from '../interpreter/value.ts';
import { AmountError, formatBaseUnits, toBaseUnits } from '../money/index.ts';
import { requestOrigin } from '../origin.ts';
import type { Source } from '../origin.ts';
import { TOOL_CHANNEL } from '../tools/channels.ts';
import type { InboxItem } from '../tools/world.ts';

/** What the session needs from the chain; the real ChainClient has all of it, tests pass a double. */
export type SessionChain = Pick<ChainClient, 'getBook' | 'listAssets' | 'getPolicy' | 'latestBlockMs' | 'submitBatch'>;

/** One bound of the owner's config: a book alias or a NEAR account, and the most the session may pay it in total, in whole NEAR. */
export interface OwnerBound {
  payee: string;
  max_total: string;
}

export interface SessionConfig {
  ownerId: string;
  contractId: string;
  agentId: string;
  /** the owner's request, from the owner's config file; the grounding text of every literal */
  request: string;
  bounds: OwnerBound[];
  maxActions: number;
  ttlMs: number;
  /** the explorer base for an Allow's transaction link, or null (a local sandbox has none) */
  explorer: string | null;
}

export interface SessionSources {
  inbox: InboxItem[];
  /** fixture pages by URL; a URL not listed goes to `fetchLive` when it is set, else the call is refused */
  pages: Readonly<Record<string, string>>;
  fetchLive?: (url: string) => Promise<string>;
  /** the sandbox directory of read_file, or null when the owner gave none */
  filesDir: string | null;
}

export interface SessionDeps {
  config: SessionConfig;
  chain: SessionChain;
  sources: SessionSources;
  /** the owner task key's Ed25519 signature over the borsh bytes of the task */
  signTask(task: OwnerTask): Uint8Array;
  clock(): number;
  randomHex(bytes: number): string;
}

/** A handle argument: the whole value of a handle, or a quoted substring of its text. */
export type HandleArg = { handle: string; quote?: string };
/** A value argument of pay: a literal the client typed, or a handle. */
export type ValueArg = string | HandleArg;

export interface PayArgs {
  payee: ValueArg;
  amount: ValueArg;
  asset?: 'near';
  why?: string;
}

export type Verdict = 'Allow' | 'Escalate' | 'Block';

/** What pay answers. `Refused` means the server refused before anything reached the chain; every other value is the contract's. */
export interface PayResult {
  verdict: Verdict | 'Refused';
  reason: string | null;
  request_id: string | null;
  pending_id: string | null;
  tx: string | null;
  explorer: string | null;
  approve: string | null;
  payee: string | null;
  amount: string | null;
  labels: { recipient: LabelName[]; amount: LabelName[]; pc: LabelName[] } | null;
  message: string;
}

const READ_FILE_MAX = 256 * 1024;
const HANDLE_TEXT_MAX = 1_000_000;
const QUOTE = 'Untrusted:quarantine' as const;
const TRUSTED_NAMES: ReadonlySet<LabelName> = new Set(['Owner', 'Book', 'Policy', 'Oracle']);
const SESSION_TAG = 'airlock-mcp-session-v1';
const utf8 = new TextEncoder();

/** A handle or quote the server cannot use; the message never echoes the argument. */
export class SessionRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionRefusal';
  }
}

interface Held {
  text: string;
  labels: ReadonlySet<LabelName>;
  /** AIR-315: where the text came from (a mail by its sender, a page by its host, a file by its name); none for the owner's and the book's */
  source: Source | null;
}

interface ActiveTask {
  task: OwnerTask;
  sig: Uint8Array;
  next: number;
}

const refused = (code: string, message: string): PayResult => ({
  verdict: 'Refused',
  reason: code,
  request_id: null,
  pending_id: null,
  tx: null,
  explorer: null,
  approve: null,
  payee: null,
  amount: null,
  labels: null,
  message,
});

/** The sha256 that every request of a session carries as plan hash: the session tag, the owner's request and the bounds. */
export function sessionPlanHash(request: string, bounds: readonly OwnerBound[]): string {
  return sha256Hex(utf8.encode(JSON.stringify({ tag: SESSION_TAG, request, bounds: bounds.map((b) => ({ payee: b.payee, max_total: b.max_total })) })));
}

export class Session {
  private readonly deps: SessionDeps;
  private readonly handles = new Map<string, Held>();
  /** every untrusted label the session has returned to the client so far */
  private readonly seen = new Set<LabelName>();
  /** every untrusted source the session has returned to the client so far (AIR-315), keyed by kind and identity */
  private readonly seenSources = new Map<string, Source>();
  private counter = 0;
  private active: ActiveTask | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  // ---- handles ----

  private hold(text: string, label: LabelName, source: Source | null): { h: string; text: string } {
    this.counter += 1;
    const h = `h${this.counter}`;
    this.handles.set(h, { text, labels: new Set([label]), source });
    if (!TRUSTED_NAMES.has(label)) {
      this.seen.add(label);
      if (source !== null) this.seenSources.set(`${source.kind}\n${source.identity}`, source);
    }
    return { h, text };
  }

  /** Every string and number leaf becomes `{ h, text }` with the one label of the tool; keys and structure stay. */
  private wrap(value: unknown, label: LabelName, source: Source | null = null): unknown {
    if (typeof value === 'string') return this.hold(value, label, source);
    if (typeof value === 'number' || typeof value === 'bigint') return this.hold(String(value), label, source);
    if (Array.isArray(value)) return value.map((v) => this.wrap(v, label, source));
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.wrap(v, label, source)]));
    return value;
  }

  /** The labels of a handle, for tests and the trace; undefined for an unknown id. */
  labelsOf(h: string): LabelName[] | undefined {
    const held = this.handles.get(h);
    return held === undefined ? undefined : sortedLabels(held.labels);
  }

  // ---- read tools ----

  ownerRequest(): { labels: LabelName[]; request: unknown; bounds: unknown; max_actions: number } {
    const { request, bounds, maxActions } = this.deps.config;
    return {
      labels: ['Owner'],
      request: this.wrap(request, 'Owner'),
      bounds: this.wrap(
        bounds.map((b) => ({ payee: b.payee, max_total: b.max_total })),
        'Owner',
      ),
      max_actions: maxActions,
    };
  }

  readEmail(): { labels: LabelName[]; emails: unknown } {
    const label = TOOL_CHANNEL.read_inbox;
    // each mail is its own source, named by its sender (AIR-315)
    const emails = structuredClone(this.deps.sources.inbox).map((m) => this.wrap(m, label, { kind: 'mail', identity: typeof m.from === 'string' ? m.from : 'read_inbox' }));
    return { labels: [label], emails };
  }

  async fetchPage(url: string): Promise<{ labels: LabelName[]; url: string; page: unknown }> {
    const label = TOOL_CHANNEL.fetch_url;
    const { pages, fetchLive } = this.deps.sources;
    let text: string;
    if (Object.hasOwn(pages, url)) text = pages[url] ?? '';
    else if (fetchLive !== undefined) text = await fetchLive(url);
    else throw new SessionRefusal('NoPage', 'this server has no such page and live fetching is off in the owner config');
    let host = 'fetch_url';
    try {
      host = new URL(url).host;
    } catch {
      // an unparsable URL is still one source, named by the tool
    }
    return { labels: [label], url, page: this.wrap(text, label, { kind: 'web', identity: host }) };
  }

  readFile(name: string): { labels: LabelName[]; name: string; content: unknown } {
    const label = TOOL_CHANNEL.read_attachment;
    const dir = this.deps.sources.filesDir;
    if (dir === null) throw new SessionRefusal('NoFiles', 'the owner config names no file directory');
    if (name === '' || isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new SessionRefusal('BadName', 'the name must be a relative path inside the file directory');
    const root = realpathSync(dir);
    const path = join(root, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new SessionRefusal('NoFile', 'no such file');
    }
    if (!stat.isFile()) throw new SessionRefusal('NotAFile', 'only regular files are read, never links or directories');
    const rel = relative(root, realpathSync(path));
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new SessionRefusal('BadName', 'the path leaves the file directory');
    if (stat.size > READ_FILE_MAX) throw new SessionRefusal('TooLarge', 'the file is over 256 KB');
    return { labels: [label], name, content: this.wrap(readFileSync(path, 'utf8'), label, { kind: 'file', identity: name }) };
  }

  async bookList(): Promise<{ labels: LabelName[]; book: unknown }> {
    const rows = await this.deps.chain.getBook();
    const book = rows.map(([key, entry]) => ({ alias: entry.label, key }));
    return { labels: ['Book'], book: this.wrap(book, 'Book') };
  }

  // ---- labels of pay's arguments ----

  /**
   * The labelled value of an argument and its untrusted sources (AIR-315: a handle's own source, or for an ungrounded literal every source
   * read so far). `kind` picks the grounding of a literal; `decimals` is the asset's, for an amount.
   */
  private sourcedValueOf(arg: ValueArg, kind: 'payee' | 'amount', decimals: number): { value: LVal; sources: Source[] } {
    if (typeof arg === 'string') {
      const value = this.literalOf(arg, kind, decimals);
      return { value, sources: value.labels.has('Owner') ? [] : [...this.seenSources.values()] };
    }
    const held = this.handles.get(arg.handle);
    return { value: this.handleOf(arg, kind), sources: held?.source === null || held?.source === undefined ? [] : [held.source] };
  }

  private literalOf(arg: string, kind: 'payee' | 'amount', decimals: number): LVal {
    const ownerText = this.deps.config.request;
    const grounded =
      kind === 'amount'
        ? grounder(arg, 'amount', { ownerText, decimals })
        : grounder(arg, 'name', { ownerText }) || grounder(arg, 'address', { ownerText });
    // a literal the model typed is untrusted unless the owner's request holds it: it may come from anything the session returned
    return grounded ? mk(arg, ['Owner']) : mk(arg, [QUOTE, ...this.seen]);
  }

  private handleOf(arg: HandleArg, kind: 'payee' | 'amount'): LVal {
    const held = this.handles.get(arg.handle);
    if (held === undefined) throw new SessionRefusal('UnknownHandle', `no handle with that id for ${kind}`);
    if (arg.quote === undefined) return mk(held.text, held.labels);
    if (arg.quote === '' || arg.quote.length > HANDLE_TEXT_MAX || !held.text.includes(arg.quote)) {
      throw new SessionRefusal('QuoteNotFound', `the quote for ${kind} does not occur in the handle's text`);
    }
    // a span picked by a model: the source labels plus quarantine, as an extraction (R3)
    return mk(arg.quote, [...held.labels, QUOTE]);
  }

  // ---- the task ----

  private async task(rows: BookRows, decimals: number): Promise<ActiveTask | PayResult> {
    const { config } = this.deps;
    if (this.active !== null) {
      if (this.deps.clock() >= this.active.task.expires_ms) return refused('TaskExpired', 'the task of this session has expired; the owner restarts the AIRLOCK server to sign a new one');
      if (this.active.next >= this.active.task.max_actions) return refused('NeedsNewTask', 'the task of this session has used all its actions; the owner restarts the AIRLOCK server');
      return this.active;
    }
    const policy = await this.deps.chain.getPolicy();
    const ttlCap = BigInt(policy.flags.max_task_ttl_ms);
    const ttl = BigInt(config.ttlMs) < ttlCap ? config.ttlMs : JSON.parse(ttlCap.toString()) as number;
    const maxActions = Math.min(config.maxActions, policy.flags.max_task_actions);
    const bounds = config.bounds.map((b) => {
      const key = resolveAlias(rows, b.payee) ?? payeeKey({ kind: 'near' }, b.payee);
      return { payee_key: key, max_total: toBaseUnits(b.max_total, decimals).toString() };
    });
    const issued = await this.deps.chain.latestBlockMs();
    const salt = this.deps.randomHex(16);
    const task = OwnerTask.parse({
      tag: TASK_TAG,
      task_id: `mcp-${this.deps.randomHex(8)}`,
      contract_id: config.contractId,
      agent_id: config.agentId,
      plan_sha256: sessionPlanHash(config.request, config.bounds),
      instruction_sha256_salted: sha256Hex(utf8.encode(`${salt}:${config.request}`)),
      issued_ms: issued,
      expires_ms: issued + ttl,
      max_actions: maxActions,
      bounds,
    });
    this.active = { task, sig: this.deps.signTask(task), next: 0 };
    return this.active;
  }

  // ---- pay ----

  /** One payment through the contract. Calls are serialized, so action indexes follow call order. */
  pay(args: PayArgs): Promise<PayResult> {
    const run = this.queue.then(() => this.payNow(args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async payNow(args: PayArgs): Promise<PayResult> {
    const asset = args.asset ?? 'near';
    if (asset !== 'near') return refused('UnsupportedAsset', 'this server pays NEAR only');
    const rows = await this.deps.chain.getBook();
    const registry = registryFromRows(await this.deps.chain.listAssets());
    const decimals = registry.get(asset)?.decimals;
    if (decimals === undefined) return refused('UnknownAsset', 'the policy has no NEAR asset registered');

    let to: LVal;
    let amountVal: LVal;
    const sources: Source[] = [];
    try {
      const p = this.sourcedValueOf(args.payee, 'payee', decimals);
      const a = this.sourcedValueOf(args.amount, 'amount', decimals);
      to = p.value;
      amountVal = a.value;
      sources.push(...p.sources, ...a.sources);
    } catch (e) {
      if (e instanceof SessionRefusal) return refused(e.code, e.message);
      throw e;
    }

    // the payee: a book alias or key gives the book's key with bookResult (R5), anything else stays an address with its own labels
    if (typeof to.raw !== 'string') return refused('BadRecipient', 'the payee is not text');
    const found = resolveAlias(rows, to.raw.trim());
    let payee: string;
    let recipient: LVal;
    if (found !== undefined) {
      payee = found;
      recipient = bookResult(found, to, ROOT_PC.labels);
    } else {
      try {
        payee = payeeKey({ kind: 'near' }, to.raw.trim());
      } catch (e) {
        if (e instanceof KeyError) return refused('BadRecipient', 'the payee is neither a book alias nor a NEAR account');
        throw e;
      }
      recipient = to;
    }

    let amount: bigint;
    try {
      amount = toBaseUnits(amountVal.raw, decimals);
    } catch (e) {
      if (e instanceof AmountError) return refused('BadAmount', 'the amount is not a plain decimal number of NEAR, like 4.2');
      throw e;
    }

    const got = await this.task(rows, decimals);
    if (!('task' in got)) return got;
    const { task, sig } = got;
    const index = got.next;
    got.next += 1;

    const labels = { recipient: sortedLabels(recipient.labels), amount: sortedLabels(amountVal.labels), pc: sortedLabels(ROOT_PC.labels) };
    const trace = { payee, amount: amount.toString(), labels, forms: { payee: typeof args.payee === 'string' ? 'literal' : 'handle', amount: typeof args.amount === 'string' ? 'literal' : 'handle' } };
    const bits = { recipient: labelsToBits(labels.recipient), amount: labelsToBits(labels.amount), pc: labelsToBits(labels.pc) };
    const req = ActionRequest.parse({
      task_id: task.task_id,
      action_index: index,
      asset,
      payee,
      amount: amount.toString(),
      labels: bits,
      evm: null,
      hints: { plan_hash: task.plan_sha256, trace_digest: sha256Hex(utf8.encode(JSON.stringify(trace))), origin: requestOrigin(bits, sources) },
    });

    const shown = { payee, amount: formatBaseUnits(amount, decimals), labels };
    let batch;
    try {
      batch = await this.deps.chain.submitBatch([req], task, sig);
    } catch (e) {
      // the code only: a chain message can carry text from outside
      const code = e instanceof ChainError ? e.code : 'Unexpected';
      return { ...refused(code, 'the request did not reach a verdict; nothing was paid by this call unless the chain says otherwise'), ...shown };
    }
    const o = batch.outcomes[0];
    if (o === undefined) return { ...refused('NoOutcome', 'the contract returned no outcome'), ...shown };
    const base = { request_id: o.request_id, reason: o.reason, ...shown };
    if (o.outcome === 'allowed') {
      const tx = batch.txHash;
      const explorer = tx !== null && this.deps.config.explorer !== null ? `${this.deps.config.explorer}${tx}` : null;
      return { ...base, verdict: 'Allow', pending_id: null, tx, explorer, approve: null, message: `paid ${shown.amount} NEAR to ${payee}` };
    }
    if (o.outcome === 'escalated') {
      const id = o.pending_id;
      return {
        ...base,
        verdict: 'Escalate',
        pending_id: id,
        tx: batch.txHash,
        explorer: null,
        approve: id === null ? null : `pnpm airlock approve ${id}`,
        message: `held for the owner (${o.reason ?? 'no reason'}); nothing was paid. Only the owner can approve it.`,
      };
    }
    return { ...base, verdict: 'Block', pending_id: null, tx: batch.txHash, explorer: null, approve: null, message: `blocked by the policy (${o.reason ?? 'no reason'}); nothing was paid` };
  }
}
