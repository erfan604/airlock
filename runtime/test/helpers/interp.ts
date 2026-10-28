// Shared fixtures for the interpreter tests: stub tools, extractor and book, and plans written as JSON that go through checkPlan.
import { checkPlan, resolveAlias } from '../../src/dsl/index.ts';
import type { BookEntryJson, BookRows, CheckedPlan, LabelName, ToolName } from '../../src/dsl/index.ts';
import { run } from '../../src/interpreter/index.ts';
import type { Book, Extractor, Proposed, RunAborted, RunDeps, RunOk, RunResult, Tools } from '../../src/interpreter/index.ts';

export type ToolReply = { raw: unknown; label: string };

export const DEFAULT_REPLIES: Partial<Record<ToolName, ToolReply>> = {
  read_inbox: { raw: [{ id: 'm1', from: 'billing@accountant-firm.co', body: 'Invoice 9.4' }], label: 'Untrusted:email' },
  get_price: { raw: '3.5', label: 'Oracle' },
  get_tx_history: { raw: [{ from: 'carol.testnet', memo: 'thanks' }], label: 'Untrusted:tool_output' },
  read_paste: { raw: 'pasted text', label: 'Untrusted:other' },
  read_feed: { raw: [{ text: 'a post' }], label: 'Untrusted:social' },
  fetch_url: { raw: '<html>page</html>', label: 'Untrusted:web' },
};

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

// `map` overrides the defaults; a function is called per call (it may throw)
export function stubTools(map: Partial<Record<ToolName, ToolReply | (() => ToolReply | Promise<ToolReply>)>> = {}): { tools: Tools; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const tools: Tools = {
    async call(name, args) {
      calls.push({ name, args });
      const reply = map[name] ?? DEFAULT_REPLIES[name];
      if (reply === undefined) throw new Error(`no stub for ${name}`);
      const out = typeof reply === 'function' ? await reply() : reply;
      // the label is a plain string on purpose: some tests hand the interpreter a name that is not a label
      return out as { raw: unknown; label: LabelName };
    },
  };
  return { tools, calls };
}

export interface ExtractRequest {
  data: unknown;
  schema: Readonly<Record<string, string>>;
  instruction: string;
}

export function stubExtract(values: Record<string, unknown> | ((req: ExtractRequest) => Record<string, unknown> | Promise<Record<string, unknown>>)): {
  extract: Extractor;
  requests: ExtractRequest[];
} {
  const requests: ExtractRequest[] = [];
  const extract: Extractor = async (req) => {
    requests.push(req);
    return typeof values === 'function' ? values(req) : values;
  };
  return { extract, requests };
}

const entry = (label: string): BookEntryJson => ({ cap: null, daily_untrusted_budget: '0', daily_limit: '1000', label });

export function stubBook(pairs: ReadonlyArray<readonly [string, string]> = [['near:accountant.testnet', 'accountant'], ['near:landlord.testnet', 'landlord']]): Book {
  const rows: BookRows = pairs.map(([key, label]) => [key, entry(label)] as const);
  return { resolve: (alias) => resolveAlias(rows, alias) };
}

export const decimalsOf = (asset: string): number | undefined => ({ near: 24, 'evm:84532:native': 18 } as Record<string, number | undefined>)[asset];

export function makeDeps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    tools: stubTools().tools,
    extract: stubExtract({}).extract,
    book: stubBook(),
    decimalsOf,
    ...over,
  };
}

export const plan = (json: unknown): CheckedPlan => checkPlan(json);

export async function runPlan(json: unknown, over: Partial<RunDeps> = {}): Promise<RunResult> {
  return run(plan(json), makeDeps(over));
}

export function okOf(result: RunResult): RunOk {
  if (!result.ok) throw new Error(`run aborted: ${result.cause.code} at ${JSON.stringify(result.cause.step)}`);
  return result;
}

export function abortOf(result: RunResult): RunAborted {
  if (result.ok) throw new Error('run did not abort');
  return result;
}

export async function proposedOf(json: unknown, over: Partial<RunDeps> = {}): Promise<Proposed[]> {
  return okOf(await runPlan(json, over)).proposed;
}

// ---- plan snippets ----
export const pay = (to: unknown, amount: unknown, extra: Record<string, unknown> = {}) => ({ action: 'transfer', args: { to, amount, asset: 'near', ...extra } });
export const ref = (name: string, path?: string[]) => (path === undefined ? { ref: name } : { ref: name, path });
export const READ_MAIL = { let: 'mail', call: 'read_inbox' };
export const extractFrom = (name: string, from: string, schema: Record<string, string>) => ({ let: name, extract: { from: ref(from), schema } });
