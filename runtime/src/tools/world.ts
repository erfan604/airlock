// The one World type every fixture consumer shares (AIR-124), and its loader (AIR-125): fixtures/world.jsonl plus the payload and x402
// files it points at. This is the only file of src/tools that reads the disk (the node:fs import below); channels.ts and fixtures.ts
// stay free of it. There is no `label` field anywhere: a label is decided by the tool name (channels.ts), and a `label` key found in
// data is an error (every record schema is strict).
// Keys: `files` by attachment name, `web` and `paid402` by URL, `prices` and `balances` by asset id (`near`, `evm:84532:native`) with
// whole-unit decimal strings ('3.5', '100').
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { KeyError, validatePayeeKey } from '../dsl/keys.ts';

export interface InboxItem {
  id: string;
  from: string;
  subject: string;
  body: string;
  attachments: string[];
}

export interface FeedItem {
  id: string;
  from: string;
  text: string;
}

export interface TokenInfo {
  id: string;
  symbol: string;
  name: string;
  description: string;
}

export interface MemoryItem {
  key: string;
  text: string;
}

export interface HistoryItem {
  id: string;
  hash: string;
  from: string;
  to: string;
  amount: string;
  memo: string;
}

export interface BookPair {
  alias: string;
  key: string;
}

const X402RequirementsSchema = z.strictObject({
  payTo: z.string(),
  amount: z.string(),
  asset: z.string(),
  network: z.string(),
  resource: z.string(),
  description: z.string(),
});

export type X402Requirements = z.infer<typeof X402RequirementsSchema>;

/** A paid endpoint of the fixture world: what it asks for, and an optional signed offer (AIR-128 reads both). */
export const X402Server = z.strictObject({
  requirements: X402RequirementsSchema,
  offer: z.strictObject({ signer: z.string(), signature: z.string() }).optional(),
});

export type X402Server = z.infer<typeof X402Server>;

export interface World {
  inbox: InboxItem[];
  files: Record<string, string>;
  feed: FeedItem[];
  web: Record<string, string>;
  tokens: TokenInfo[];
  memory: MemoryItem[];
  history: HistoryItem[];
  prices: Record<string, string>;
  balances: Record<string, string>;
  book: BookPair[];
  paid402: Record<string, X402Server>;
  paste: string | null;
}

/**
 * Every list [], every map {}, paste null. Tests spread it: `{ ...EMPTY_WORLD, inbox: [...] }`. It is frozen all the way down, so a
 * test that pushes into a list it did not replace gets a TypeError instead of changing the world of every other test.
 */
export const EMPTY_WORLD: World = Object.freeze({
  inbox: Object.freeze([]) as unknown as InboxItem[],
  files: Object.freeze({}) as Record<string, string>,
  feed: Object.freeze([]) as unknown as FeedItem[],
  web: Object.freeze({}) as Record<string, string>,
  tokens: Object.freeze([]) as unknown as TokenInfo[],
  memory: Object.freeze([]) as unknown as MemoryItem[],
  history: Object.freeze([]) as unknown as HistoryItem[],
  prices: Object.freeze({}) as Record<string, string>,
  balances: Object.freeze({}) as Record<string, string>,
  book: Object.freeze([]) as unknown as BookPair[],
  paid402: Object.freeze({}) as Record<string, X402Server>,
  paste: null,
});

// ---- the loader (AIR-125) ----

/** Why a world file was refused. Messages name ids, refs, line numbers and key names, never the text of a payload. */
export type WorldErrorCode =
  | 'Unreadable'
  | 'BadLine'
  | 'UnknownKind'
  | 'BadRecord'
  | 'DuplicateId'
  | 'DuplicateKey'
  | 'DuplicatePaste'
  | 'BadRef'
  | 'DanglingRef'
  | 'UnreferencedFile'
  | 'NonAscii'
  | 'UnknownAttachment'
  | 'UnknownInbox'
  | 'UnknownScenario'
  | 'BadBookKey'
  | 'BadX402';

export class WorldError extends Error {
  readonly code: WorldErrorCode;
  /** 1-based line of world.jsonl, when the problem belongs to one. */
  readonly line: number | undefined;
  constructor(code: WorldErrorCode, detail: string, opts: { line?: number; cause?: unknown } = {}) {
    super(`WorldError ${code}${opts.line === undefined ? '' : ` at line ${opts.line}`}: ${detail}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WorldError';
    this.code = code;
    this.line = opts.line;
  }
}

const Id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
/** A whole-unit decimal string: digits, optionally a point and more digits. No sign, no exponent, no number type. */
const Decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
/** The asset ids the plan language knows: `near`, `evm:<chain id>:native`, and `ft:<account>` for a token the registry lists. */
const AssetId = z.string().regex(/^(near|evm:[1-9][0-9]*:native|ft:[a-z0-9._-]{2,64})$/);

const record = <K extends string, S extends z.ZodRawShape>(kind: K, shape: S) => z.strictObject({ id: Id, kind: z.literal(kind), ...shape });

/** One strict schema per kind of line. `text_ref` and `ref` are plain strings here: their shape is checked next, so that a bad ref is a BadRef. */
export const RECORD_SCHEMAS = Object.freeze({
  inbox: record('inbox', { from: z.string(), subject: z.string(), text_ref: z.string(), attachments: z.array(z.string()) }),
  file: record('file', { name: z.string().min(1), text_ref: z.string() }),
  feed: record('feed', { from: z.string(), text_ref: z.string() }),
  web: record('web', { url: z.string().min(1), text_ref: z.string() }),
  token: record('token', { symbol: z.string(), name: z.string(), text_ref: z.string() }),
  memory: record('memory', { key: z.string(), text_ref: z.string() }),
  history: record('history', { hash: z.string(), from: z.string(), to: z.string(), amount: Decimal, text_ref: z.string().nullable() }),
  price: record('price', { asset: AssetId, value: Decimal }),
  balance: record('balance', { asset: AssetId, value: Decimal }),
  book: record('book', { alias: z.string().min(1), key: z.string() }),
  paid402: record('paid402', { url: z.string().min(1), ref: z.string() }),
  paste: record('paste', { text_ref: z.string() }),
  scenario: record('scenario', { request: z.string().min(1).max(4000), inbox: z.array(z.string()).max(1) }),
});

type RecordKind = keyof typeof RECORD_SCHEMAS;
export type WorldRecord = z.infer<(typeof RECORD_SCHEMAS)[RecordKind]>;

/** One owner request of the demo, and the inbox record it reads (at most one: the plan runs once per inbox item). */
export type Scenario = { id: string; request: string; inbox: string[] };

const PAYLOAD_REF = /^payloads\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.txt$/;
const X402_REF = /^x402\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;

// relative to the directory of world.jsonl, a single file name under one fixed folder: no `..`, no leading slash, no nesting
function checkRef(ref: string, pattern: RegExp, folder: string, line: number): void {
  if (!pattern.test(ref) || ref.includes('..')) throw new WorldError('BadRef', `a ref must be ${folder}/<name> with no .. and no nesting`, { line });
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'record'}: ${i.message}`)
    .join('; ')
    .slice(0, 300);
}

function regularFile(full: string, ref: string, line: number): void {
  let isFile = false;
  try {
    isFile = lstatSync(full).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new WorldError('DanglingRef', `${ref} is not a regular file`, { line });
}

class Reader {
  readonly referenced = new Set<string>();
  readonly #texts = new Map<string, string>();
  constructor(readonly dir: string) {}

  /** The text of a payload file, ASCII only. A file two records name is read once. */
  text(ref: string, line: number): string {
    checkRef(ref, PAYLOAD_REF, 'payloads', line);
    this.referenced.add(ref);
    const known = this.#texts.get(ref);
    if (known !== undefined) return known;
    const full = join(this.dir, ref);
    regularFile(full, ref, line);
    const bytes = readFileSync(full);
    if (bytes.some((b) => b > 0x7f)) throw new WorldError('NonAscii', `${ref} has a byte above 0x7F`, { line });
    const text = bytes.toString('utf8');
    this.#texts.set(ref, text);
    return text;
  }

  x402(ref: string, line: number): X402Server {
    checkRef(ref, X402_REF, 'x402', line);
    const full = join(this.dir, ref);
    regularFile(full, ref, line);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(full, 'utf8'));
    } catch (cause) {
      throw new WorldError('BadX402', `${ref} is not JSON`, { line, cause });
    }
    const parsed = X402Server.safeParse(json);
    if (!parsed.success) throw new WorldError('BadX402', `${ref} is not an X402Server: ${describeIssues(parsed.error)}`, { line });
    return parsed.data;
  }

  /** Every file directly under payloads/ must be named by some record (an x402/ file is checked by whoever adds it). */
  checkAllReferenced(): void {
    let names: string[];
    try {
      names = readdirSync(join(this.dir, 'payloads'));
    } catch {
      return; // no payloads folder: nothing can be unreferenced
    }
    for (const name of names.sort()) {
      if (name === '.DS_Store') continue;
      if (!this.referenced.has(`payloads/${name}`)) throw new WorldError('UnreferencedFile', `payloads/${name} is named by no record`);
    }
  }
}

type Parsed = { rec: WorldRecord; line: number };

function parseLines(text: string): Parsed[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out: Parsed[] = [];
  const ids = new Set<string>();
  lines.forEach((source, index) => {
    const line = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (cause) {
      throw new WorldError('BadLine', 'the line is not one JSON object', { line, cause });
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new WorldError('BadLine', 'the line is not one JSON object', { line });
    const kind = (raw as Record<string, unknown>)['kind'];
    if (typeof kind !== 'string' || !Object.hasOwn(RECORD_SCHEMAS, kind)) {
      throw new WorldError('UnknownKind', `kind ${typeof kind === 'string' ? JSON.stringify(kind.slice(0, 40)) : 'missing'} is not a record kind`, { line });
    }
    const parsed = RECORD_SCHEMAS[kind as RecordKind].safeParse(raw);
    if (!parsed.success) throw new WorldError('BadRecord', `${kind} record: ${describeIssues(parsed.error)}`, { line });
    const rec: WorldRecord = parsed.data;
    if (ids.has(rec.id)) throw new WorldError('DuplicateId', `id ${rec.id} is used twice`, { line });
    ids.add(rec.id);
    out.push({ rec, line });
  });
  return out;
}

/** One key of a map the world builds: a second record with the same key is an error, never an overwrite. */
function claim(seen: Set<string>, key: string, what: string, line: number): void {
  if (seen.has(key)) throw new WorldError('DuplicateKey', `a second ${what} for ${key}`, { line });
  seen.add(key);
}

function load(path: string, scenarioId: string | undefined): { world: World; scenarios: Scenario[] } {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new WorldError('Unreadable', `cannot read ${file}`, { cause });
  }
  const parsed = parseLines(text);
  const reader = new Reader(dirname(file));

  const inboxIds = new Set<string>();
  const fileNames = new Set<string>();
  for (const { rec } of parsed) {
    if (rec.kind === 'inbox') inboxIds.add(rec.id);
    if (rec.kind === 'file') fileNames.add(rec.name);
  }

  // every list and map is built here, fresh: EMPTY_WORLD is frozen and one load must never share a structure with the next
  const inbox: InboxItem[] = [];
  const feed: FeedItem[] = [];
  const tokens: TokenInfo[] = [];
  const memory: MemoryItem[] = [];
  const history: HistoryItem[] = [];
  const book: BookPair[] = [];
  const scenarios: Scenario[] = [];
  const files: [string, string][] = [];
  const web: [string, string][] = [];
  const prices: [string, string][] = [];
  const balances: [string, string][] = [];
  const paid402: [string, X402Server][] = [];
  let paste: string | null = null;
  let pasteSeen = false;
  const seen = { file: new Set<string>(), web: new Set<string>(), price: new Set<string>(), balance: new Set<string>(), alias: new Set<string>(), paid: new Set<string>() };

  for (const { rec, line } of parsed) {
    switch (rec.kind) {
      case 'inbox': {
        for (const name of rec.attachments) {
          if (!fileNames.has(name)) throw new WorldError('UnknownAttachment', `inbox ${rec.id} lists ${JSON.stringify(name)}, which no file record names`, { line });
        }
        inbox.push({ id: rec.id, from: rec.from, subject: rec.subject, body: reader.text(rec.text_ref, line), attachments: [...rec.attachments] });
        break;
      }
      case 'file':
        claim(seen.file, rec.name, 'file', line);
        files.push([rec.name, reader.text(rec.text_ref, line)]);
        break;
      case 'feed':
        feed.push({ id: rec.id, from: rec.from, text: reader.text(rec.text_ref, line) });
        break;
      case 'web':
        claim(seen.web, rec.url, 'web page', line);
        web.push([rec.url, reader.text(rec.text_ref, line)]);
        break;
      case 'token':
        tokens.push({ id: rec.id, symbol: rec.symbol, name: rec.name, description: reader.text(rec.text_ref, line) });
        break;
      case 'memory':
        memory.push({ key: rec.key, text: reader.text(rec.text_ref, line) });
        break;
      case 'history':
        history.push({ id: rec.id, hash: rec.hash, from: rec.from, to: rec.to, amount: rec.amount, memo: rec.text_ref === null ? '' : reader.text(rec.text_ref, line) });
        break;
      case 'price':
        claim(seen.price, rec.asset, 'price', line);
        prices.push([rec.asset, rec.value]);
        break;
      case 'balance':
        claim(seen.balance, rec.asset, 'balance', line);
        balances.push([rec.asset, rec.value]);
        break;
      case 'book':
        try {
          validatePayeeKey(rec.key);
        } catch (cause) {
          throw new WorldError('BadBookKey', `book ${rec.alias}: the key fails validatePayeeKey${cause instanceof KeyError ? ` (${cause.code})` : ''}`, { line, cause });
        }
        claim(seen.alias, rec.alias, 'book alias', line);
        book.push({ alias: rec.alias, key: rec.key });
        break;
      case 'paid402':
        claim(seen.paid, rec.url, 'paid402 url', line);
        paid402.push([rec.url, reader.x402(rec.ref, line)]);
        break;
      case 'paste':
        if (pasteSeen) throw new WorldError('DuplicatePaste', 'a second paste record', { line });
        pasteSeen = true;
        paste = reader.text(rec.text_ref, line);
        break;
      case 'scenario':
        for (const id of rec.inbox) {
          if (!inboxIds.has(id)) throw new WorldError('UnknownInbox', `scenario ${rec.id} names ${JSON.stringify(id)}, which is not an inbox record`, { line });
        }
        scenarios.push({ id: rec.id, request: rec.request, inbox: [...rec.inbox] });
        break;
    }
  }
  reader.checkAllReferenced();

  let pick: Scenario | undefined;
  if (scenarioId !== undefined) {
    pick = scenarios.find((s) => s.id === scenarioId);
    if (pick === undefined) throw new WorldError('UnknownScenario', `no scenario ${JSON.stringify(scenarioId)}`);
  }
  const chosen = pick;
  const world: World = {
    inbox: chosen === undefined ? inbox : inbox.filter((m) => chosen.inbox.includes(m.id)),
    files: Object.fromEntries(files),
    feed,
    web: Object.fromEntries(web),
    tokens,
    memory,
    history,
    prices: Object.fromEntries(prices),
    balances: Object.fromEntries(balances),
    book,
    paid402: Object.fromEntries(paid402),
    paste,
  };
  return { world, scenarios };
}

/**
 * Reads world.jsonl (one strict JSON object per line) and the files its refs name, relative to the directory of `path`, and builds a
 * World. An inbox item's body is its file text. With `opts.scenario` the inbox keeps only that scenario's item. Anything wrong throws a
 * WorldError; nothing is repaired and nothing is read outside the world's own folder.
 */
export function loadWorld(path: string, opts: { scenario?: string } = {}): World {
  return load(path, opts.scenario).world;
}

/** The scenarios of a world file, in file order. The whole file is checked, as loadWorld does. */
export function loadScenarios(path: string): Scenario[] {
  return load(path, undefined).scenarios;
}
