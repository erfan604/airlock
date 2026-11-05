// AIR-315: the flood-control origin of a request. The contract keeps its escalation counters per (agent, origin), so the runtime names, for
// every request it submits, where the untrusted part of it came from: `owner` when every label is trusted, otherwise `<kind>:<16 hex>`, the
// first 16 hex digits of the sha256 of the source's identity (a mail sender, a page host, a file name, a tool). The identity itself never
// reaches the chain. Browser safe: no Node module.
import { sha256Hex } from './dsl/task.ts';
import { isPcTrusted, isTrusted, isValueTrusted } from './dsl/labels.ts';

export const OWNER_ORIGIN = 'owner';

/** The shape the contract accepts: `owner`, or a kind of 1 to 8 lowercase letters, a colon and 16 lowercase hex digits. */
export const ORIGIN_PATTERN = /^(owner|[a-z]{1,8}:[0-9a-f]{16})$/;

export type SourceKind = 'mail' | 'web' | 'file' | 'feed' | 'mem' | 'tool' | 'pay' | 'paste' | 'plan';

/** One untrusted source: its kind and its identity (lowercased, trimmed). */
export interface Source {
  kind: SourceKind;
  identity: string;
}

const utf8 = new TextEncoder();
const hex16 = (text: string): string => sha256Hex(utf8.encode(text)).slice(0, 16);

/** The origin of one source. */
export function originOf(s: Source): string {
  return `${s.kind}:${hex16(s.identity.trim().toLowerCase())}`;
}

/**
 * The origin of a request: `owner` when its three label masks are all trusted, else the origin of its one source, else `mix:` over the sorted
 * origins of several sources, else (untrusted labels and no source, such as an ungrounded planner literal) the origin of the planner.
 */
export function requestOrigin(labels: { recipient: number; amount: number; pc: number }, sources: readonly Source[]): string {
  if (isTrusted(labels.recipient) && isValueTrusted(labels.amount) && isPcTrusted(labels.pc)) return OWNER_ORIGIN;
  const ids = [...new Set(sources.map(originOf))].sort();
  if (ids.length === 0) return originOf({ kind: 'plan', identity: 'planner' });
  if (ids.length === 1) return ids[0] ?? OWNER_ORIGIN;
  return `mix:${hex16(ids.join(','))}`;
}
