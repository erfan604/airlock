// A tiny JSON-RPC server over node:http for the RPC pool and transport tests: no sandbox, no network. It records every request and
// answers each one by a handler, so a test can say "the first URL answers 503 to every call" and count what each URL saw.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  method: string;
  params: unknown;
}

export interface MockReply {
  /** HTTP status, 200 by default */
  status?: number;
  /** the JSON body; a `result` or an `error` of a JSON-RPC answer */
  body?: unknown;
  /** destroy the socket instead of answering */
  drop?: boolean;
}

export interface MockRpc {
  url: string;
  calls: MockCall[];
  close(): Promise<void>;
}

export const rpcResult = (result: unknown): MockReply => ({ body: { jsonrpc: '2.0', id: 'x', result } });
export const rpcError = (error: unknown): MockReply => ({ body: { jsonrpc: '2.0', id: 'x', error } });
export const http503: MockReply = { status: 503 };

/** The answer of a `block` call: the header fields the client reads. */
export const blockReply = (nanos = '1800000000123456789'): MockReply =>
  rpcResult({ author: 'x', header: { hash: '11111111111111111111111111111111', height: 7, timestamp: 1, timestamp_nanosec: nanos }, chunks: [] });

export async function startMockRpc(handler: (call: MockCall, n: number) => MockReply | Promise<MockReply>): Promise<MockRpc> {
  const calls: MockCall[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        let call: MockCall = { method: '', params: null };
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: string; params?: unknown };
          call = { method: String(body.method ?? ''), params: body.params };
        } catch {
          // an unreadable body counts as a call with no method
        }
        calls.push(call);
        const reply = await handler(call, calls.length);
        if (reply.drop === true) {
          request.socket.destroy();
          return;
        }
        response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(reply.body ?? {}));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
