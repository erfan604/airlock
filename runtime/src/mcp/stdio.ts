// AIR-322 (M3): the stdio transport of airlock-mcp with one guard in front of the SDK. The SDK drops a request whose `params` is not an
// object (it fails its message schema before any handler runs), so the client never gets a reply and may wait forever. This transform reads
// the input line by line and answers such a request itself with JSON-RPC -32602 (invalid params); every other line goes on to the SDK
// unchanged. The reply carries no input text.
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const MAX_LINE = 8 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The id and a reply when the line is a request with params that are present but not an object, else null. */
export function invalidParamsReply(line: string): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(msg) || typeof msg.method !== 'string' || !Object.hasOwn(msg, 'params') || isRecord(msg.params)) return null;
  const id = msg.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null; // a notification has no reply
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: params must be an object' } })}\n`;
}

export function guardStdin(stdin: Readable, stdout: Writable): Readable {
  const out = new PassThrough();
  let pending = '';
  stdin.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString('utf8');
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      const reply = invalidParamsReply(line);
      if (reply === null) out.write(`${line}\n`);
      else stdout.write(reply);
      nl = pending.indexOf('\n');
    }
    if (pending.length > MAX_LINE) {
      out.write(pending);
      pending = '';
    }
  });
  stdin.on('end', () => {
    if (pending !== '') out.write(pending);
    out.end();
  });
  stdin.on('error', (e) => out.destroy(e));
  return out;
}

export function createStdioTransport(stdin: Readable = process.stdin, stdout: Writable = process.stdout): StdioServerTransport {
  return new StdioServerTransport(guardStdin(stdin, stdout), stdout);
}
