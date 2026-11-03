// Listens with an app and returns the port and a close function that also drops keep-alive and stream connections.
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AddressInfo } from 'node:net';

export async function listen(app: Hono, port: number, host: string): Promise<{ port: number; close(): Promise<void> }> {
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** `preferred` when a listener can bind it on `host`, else a port the OS hands out. */
export async function freePortOr(preferred: number, host: string): Promise<number> {
  const { createServer } = await import('node:net');
  const tryPort = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(null));
      s.listen({ host, port, exclusive: true }, () => {
        const got = (s.address() as AddressInfo).port;
        s.close(() => resolve(got));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0)) ?? preferred;
}
