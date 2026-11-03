// AIR-303: GET /api/attestation and the boot wiring. Behind the owner session; a runtime with no record answers one UNATTESTED record.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { Attestation } from '../src/attest/index.ts';
import { createTestSession } from '../src/server/app.ts';
import { startRuntime } from '../src/server/main.ts';
import type { RunningRuntime } from '../src/server/main.ts';
import { U01 } from './helpers/agent.ts';
import { makeApp } from './helpers/server.ts';
import { stubChain, stubEnv, stubParts } from './helpers/stub-runtime.ts';

const recorded = JSON.parse(readFileSync(new URL('../recordings/attest/z-ai_glm-5.3-flash.json', import.meta.url), 'utf8')) as Attestation;

const running: RunningRuntime[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

test('the route needs a session', async () => {
  const h = makeApp();
  assert.equal((await h.app.request('/api/attestation')).status, 401);
});

test('without a source the answer is one UNATTESTED record, never an empty list', async () => {
  const h = makeApp({ mode: 'replay' });
  const cookie = await createTestSession(h.app);
  const res = await h.app.request('/api/attestation', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { attestations: Attestation[] };
  assert.equal(body.attestations.length, 1);
  assert.equal(body.attestations[0]?.status, 'UNATTESTED');
  assert.equal(body.attestations[0]?.checks[0]?.ok, false);
});

test('a source is served as it is', async () => {
  const h = makeApp({ mode: 'replay', attestation: { current: () => [recorded] } });
  const cookie = await createTestSession(h.app);
  const body = (await (await h.app.request('/api/attestation', { headers: { cookie } })).json()) as { attestations: Attestation[] };
  assert.deepEqual(body.attestations, [recorded]);
});

test('replay boot serves the recorded record of the planner model, labelled recorded', async () => {
  const rt = await startRuntime(stubEnv(), stubParts(stubChain(), { plan: U01 }));
  running.push(rt);
  const cookie = /airlock_session=[0-9a-f]{64}/.exec((await fetch(`${rt.url}/session`)).headers.get('set-cookie') ?? '')?.[0] ?? '';
  const body = (await (await fetch(`${rt.url}/api/attestation`, { headers: { cookie } })).json()) as { attestations: Attestation[] };
  assert.equal(body.attestations.length >= 1, true);
  assert.equal(body.attestations[0]?.source, 'recorded');
  assert.equal(body.attestations[0]?.status, 'VERIFIED');
  assert.equal(body.attestations[0]?.model, 'z-ai/glm-5.3-flash');
});
