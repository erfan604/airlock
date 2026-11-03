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
