// The injected dependencies and the results of a run. Nothing here depends on tools, llm, chain or planner code: the interpreter is
// pure and reaches the outside only through these.
import type { LabelName, Target, ToolName } from '../dsl/index.ts';
import type { TraceEvent } from './trace.ts';
import type { LVal, Origin } from './value.ts';

export interface Tools {
  /** The label is a wire name decided by the tools layer, never by a model; the interpreter trusts it and never invents or changes one. */
  call(name: ToolName, args: Record<string, unknown>): Promise<{ raw: unknown; label: LabelName }>;
}

/** Gets the raw value of the `from` reference and owns turning it into text. One value per schema key, null for a field that failed validation. */
export type Extractor = (req: { data: unknown; schema: Readonly<Record<string, string>>; instruction: string }) => Promise<Record<string, unknown>>;

export interface Book {
  /** The canonical payee key an alias names, or undefined (built from resolveAlias). */
  resolve(alias: string): string | undefined;
}

/** Literal grounding (SPEC 6 rule 8): whether a literal of the plan occurs in the owner's own words. The real one is AIR-127's. */
export type Grounder = (lit: string | number, kind: 'amount' | 'name' | 'address', ctx: { ownerText: string | undefined; decimals?: number }) => boolean;

export type ToolArgPolicy = (tool: ToolName, args: Readonly<Record<string, LVal>>) => { allow: true } | { allow: false; code: string };

export interface RunDeps {
  tools: Tools;
  extract: Extractor;
  book: Book;
  /** From the asset registry; undefined for an asset that is not registered. */
  decimalsOf(asset: string): number | undefined;
  ownerText?: string;
  ground?: Grounder;
  toolArgPolicy?: ToolArgPolicy;
  now?: () => number;
  onEvent?: (e: TraceEvent) => void;
}

/** One payment the plan proposes: recipient, amount (base units) and pc labels, with where each came from. It does not stop the run. */
export interface Proposed {
  action: 'transfer' | 'evm_transfer';
  target: Target;
  payee: string;
  asset: string;
  amount: bigint;
  recipientLabels: LabelName[];
  amountLabels: LabelName[];
  /** the current pc; it always contains Owner */
  pc: LabelName[];
  origins: { recipient: Origin[]; amount: Origin[]; pc: Origin[] };
}

export type AbortCode =
  | 'BadNumber'
  | 'BadCalc'
  | 'BadCondition'
  | 'BadLoopList'
  | 'BadLookupKey'
  | 'BadAmount'
  | 'BadRecipient'
  | 'TargetMismatch'
  | 'UnknownAsset'
  | 'RefusedToolArg'
  | 'ToolError'
  | 'BadToolLabel';

export type RunOk = { ok: true; proposed: Proposed[]; trace: TraceEvent[]; says: LVal[] };
export type RunAborted = { ok: false; cause: { step: (string | number)[]; code: AbortCode; labels: LabelName[] }; trace: TraceEvent[] };
export type RunResult = RunOk | RunAborted;
