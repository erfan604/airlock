// The one World type every fixture consumer shares (AIR-124; AIR-125 appends the loader and the JSONL record schemas). Types and the
// empty world only: no file access in this ticket. There is no `label` field anywhere: a label is decided by the tool name (channels.ts),
// and a `label` key found in data is ignored.
// Keys: `files` by attachment name, `web` and `paid402` by URL, `prices` and `balances` by asset id (`near`, `evm:84532:native`) with
// whole-unit decimal strings ('3.5', '100').
import { z } from 'zod';

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
