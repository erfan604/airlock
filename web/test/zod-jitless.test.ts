// AIR-323 M1: zod probes `new Function("")` to decide whether it may compile its parsers, and a CSP without `unsafe-eval` reports that probe as a
// `securitypolicyviolation` on every page. The console's wire types load zod with `jitless` set, so no Function is constructed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('console wire types and DSL: loading them after zod-nojit and parsing a view constructs no Function (no eval for a CSP to report)', async () => {
  const RealFunction = globalThis.Function;
  let constructed = 0;
  globalThis.Function = new Proxy(RealFunction, {
    construct(target, args, newTarget) {
      constructed += 1;
      return Reflect.construct(target, args, newTarget) as object;
    },
    apply(target, thisArg, args) {
      constructed += 1;
      return Reflect.apply(target, thisArg, args) as unknown;
    },
  });
  try {
    await import('@airlock/runtime/zod-nojit');
    // the modules of the console that build zod schemas
    await import('@airlock/runtime/dsl');
    const types = await import('@airlock/runtime/chain-types');
    for (const bad of [{ nonsense: true }, null]) {
      try {
        types.parseRequestView(bad);
      } catch {
        // a refusal is fine; only a Function construction counts
      }
    }
  } finally {
    globalThis.Function = RealFunction;
  }
  assert.equal(constructed, 0);
});
