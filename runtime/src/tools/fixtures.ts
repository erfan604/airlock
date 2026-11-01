// Fixture-backed tools (AIR-124): every output comes from a World and carries TOOL_CHANNEL[name], nothing else. The label is never
// read from the data and never decided by a model. No network, no file access, no clock: names are map keys, never paths, so there is
// no SSRF surface and no path traversal to guard. `raw` is always a structuredClone, so a run cannot change the world (one world is
// run more than once).
import type { LabelName } from '../dsl/labels.ts';
import type { ToolName } from '../dsl/tools.ts';
import type { Tools } from '../interpreter/types.ts';
import { TOOL_CHANNEL } from './channels.ts';
import type { World } from './world.ts';
import { fetchPaid } from './x402.ts';

/** A required argument is missing or not a string, or an oracle has no value: the interpreter turns it into the abort ToolError. */
export class ToolArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgError';
  }
}

/** The type system forbids it and the plan checker rejects it earlier; the runtime still refuses. */
export class UnknownToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownToolError';
  }
}

type Args = Record<string, unknown>;

function strArg(tool: ToolName, args: Args, key: string): string {
  const value = Object.hasOwn(args, key) ? args[key] : undefined;
  if (typeof value !== 'string') throw new ToolArgError(`${tool}: argument ${key} must be a string`);
  return value;
}

/** A map read that never reaches an inherited property: `files['constructor']` is not a file. */
function own(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** An oracle value: a missing one stops the run, it never reads as zero. */
function oracle(tool: ToolName, map: Readonly<Record<string, string>>, asset: string): string {
  const value = own(map, asset);
  if (value === undefined) throw new ToolArgError(`${tool}: no value for the asset`);
  return value;
}

function read(world: World, name: ToolName, args: Args): unknown {
  switch (name) {
    case 'read_inbox':
      return world.inbox;
    case 'read_attachment':
      return own(world.files, strArg(name, args, 'name')) ?? '';
    case 'read_feed':
      return world.feed;
    case 'fetch_url':
      return own(world.web, strArg(name, args, 'url')) ?? '';
    case 'memory_read':
      return world.memory;
    case 'list_tokens':
      return world.tokens;
    case 'get_tx_history':
      return world.history;
    case 'read_paste':
      return world.paste ?? '';
    case 'fetch_paid':
      return fetchPaid(world, args);
    case 'get_balance':
      return oracle(name, world.balances, strArg(name, args, 'asset'));
    case 'get_price':
      return oracle(name, world.prices, strArg(name, args, 'asset'));
    case 'address_book':
      // the pairs come from the owner's book; the alias lookup itself stays in the interpreter
      return world.book;
    default:
      throw new UnknownToolError('unknown tool');
  }
}

export function fixtureTools(world: World): Tools {
  return {
    async call(name: ToolName, args: Args): Promise<{ raw: unknown; label: LabelName }> {
      if (typeof name !== 'string' || !Object.hasOwn(TOOL_CHANNEL, name)) throw new UnknownToolError('unknown tool');
      return { raw: structuredClone(read(world, name, args)), label: TOOL_CHANNEL[name] };
    },
  };
}
