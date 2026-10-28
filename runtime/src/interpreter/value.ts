// Labelled values. Every label set and origin set in the interpreter is created in this file and nowhere else, so a rule that
// forgets a label has one place to be wrong in. A value created by a step carries the union of its inputs' labels plus the taint of
// the pc; a literal does not (the pc travels separately in `Proposed.pc`).
import { bitsToLabels, isTrusted, labelsToBits } from '../dsl/labels.ts';
import type { LabelName } from '../dsl/labels.ts';

/** The id of the `call` trace event a piece of data came from, for example `call:1`. */
export type Origin = string;

export type LabelSet = ReadonlySet<LabelName>;

export interface LVal {
  readonly raw: unknown;
  readonly labels: LabelSet;
  readonly origins: ReadonlySet<Origin>;
}

/** The program counter: the labels (and origins) of every condition and loop list that decided to run the current code. */
export interface Pc {
  readonly labels: LabelSet;
  readonly origins: ReadonlySet<Origin>;
}

/** Every run starts with pc = {Owner}; a request with an empty pc is malformed. */
export const ROOT_PC: Pc = { labels: new Set<LabelName>(['Owner']), origins: new Set<Origin>() };

/** A value with exactly these labels and origins. Literals use `lit`, steps use `derive`. */
export function mk(raw: unknown, labels: Iterable<LabelName>, origins: Iterable<Origin> = []): LVal {
  return { raw, labels: new Set(labels), origins: new Set(origins) };
}

/** A literal of the plan: `{Owner}` unless the grounding hook said otherwise. */
export function lit(raw: unknown, labels: Iterable<LabelName> = ['Owner']): LVal {
  return mk(raw, labels);
}

/** The pc without Owner: the root pc is never copied into a value, because it would put an Owner seal on a price or an extracted amount. */
export function taint(pc: LabelSet): LabelSet {
  return new Set([...pc].filter((label) => label !== 'Owner'));
}

/** The union of the labels of some values. */
export function join(...vals: readonly LVal[]): LabelSet {
  return new Set(vals.flatMap((v) => [...v.labels]));
}

/** A value computed from `inputs`: their labels, `extra` and the pc taint; their origins, and `origin` when this step is a source. */
export function derive(raw: unknown, inputs: readonly LVal[], pc: LabelSet, extra: Iterable<LabelName> = [], origin?: Origin): LVal {
  const origins = inputs.flatMap((v) => [...v.origins]);
  if (origin !== undefined) origins.push(origin);
  return mk(raw, [...join(...inputs), ...extra, ...taint(pc)], origins);
}

/** The pc inside a branch or loop: the current pc joined with the labels and origins of the deciding value. */
export function extendPc(pc: Pc, decider: LVal): Pc {
  return { labels: new Set([...pc.labels, ...decider.labels]), origins: new Set([...pc.origins, ...decider.origins]) };
}

/** The result of a lookup that found its payee: Book, plus the key's labels when the key was not trusted (selection taint), plus the pc taint. */
export function bookResult(raw: string, key: LVal, pc: LabelSet): LVal {
  const keyIsTrusted = isTrusted(labelsToBits([...key.labels]));
  const selection = keyIsTrusted ? [] : [...key.labels].filter((label) => label !== 'Owner');
  return mk(raw, ['Book', ...selection, ...taint(pc)], key.origins);
}

/** A literal that the grounding hook did not ground: Owner plus Unresolved. */
export function ungrounded(raw: unknown): LVal {
  return lit(raw, ['Owner', 'Unresolved']);
}

/** The labels in bit order. */
export function sortedLabels(s: LabelSet): LabelName[] {
  return bitsToLabels(labelsToBits([...s]));
}

/** The origins in call order (`call:2` before `call:10`). */
export function sortedOrigins(s: ReadonlySet<Origin>): Origin[] {
  return [...s].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}
