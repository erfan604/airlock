// freePortOr: the preferred port when it can be bound, else a port the OS hands out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { freePortOr } from '../src/listen.ts';

test('freePortOr returns a taken port\'s replacement and a free port as is', async () => {
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', () => r()));
  const taken = (holder.address() as AddressInfo).port;
  try {
    const other = await freePortOr(taken, '127.0.0.1');
    assert.notEqual(other, taken);
    assert.ok(other > 0);
  } finally {
    await new Promise<void>((r) => holder.close(() => r()));
  }
  assert.equal(await freePortOr(taken, '127.0.0.1'), taken);
});
