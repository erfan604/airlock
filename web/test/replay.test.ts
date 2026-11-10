// AIR-246: the replay approve and the mode probe. No network: the api and fetch are stubs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestView } from '@airlock/runtime/chain-types';
import correction from '../fixtures/card-correction-live.json' with { type: 'json' };
import { approveArgs } from '../src/approvals/cardModel.ts';
import { replayMode } from '../src/replay/api.ts';
import { REJECT_NOTE, replayApprove } from '../src/replay/replayApprove.ts';

const view = correction.view as RequestView;
const args = approveArgs(view);

function api() {
  const calls: string[] = [];
  return {
    calls,
    approve: async (no: string) => {
      calls.push(no);
      return { ok: true as const, tx: 'RecordedApproveTx1', url: 'https://example.invalid/tx' };
    },
  };
}

test('replayApprove posts the pending number and returns the recorded transaction when the arguments are the card arguments', async () => {
  const a = api();
  assert.deepEqual(await replayApprove(args, view, a), { ok: true, tx: 'RecordedApproveTx1' });
  assert.deepEqual(a.calls, [args.id]);
});

test('replayApprove refuses arguments that differ from approveArgs(view) in any of the six fields, and posts nothing', async () => {
  for (const key of ['id', 'to', 'asset', 'amount', 'why', 'book'] as const) {
    const a = api();
    const r = await replayApprove({ ...args, [key]: `${args[key]}x` }, view, a);
    assert.equal(r.ok, false, key);
    assert.deepEqual(a.calls, [], key);
  }
});

test('replayApprove maps a refused or failing post to a contract failure, never a throw', async () => {
  assert.deepEqual(await replayApprove(args, view, { approve: async () => ({ ok: false }) }), { ok: false, kind: 'contract', name: 'NotRecorded' });
  assert.deepEqual(
    await replayApprove(args, view, {
      approve: async () => {
        throw new Error('boom');
      },
    }),
    { ok: false, kind: 'contract', name: 'ReplayUnavailable' },
  );
  assert.equal(REJECT_NOTE, 'Reject is not part of this recording');
});

test('replayMode is true only for the x-airlock-mode: replay header, and false when the read fails', async () => {
  const answer = (headers: Record<string, string>): typeof fetch => (async () => new Response('{}', { headers })) as typeof fetch;
  assert.equal(await replayMode(answer({ 'x-airlock-mode': 'replay' })), true);
  assert.equal(await replayMode(answer({})), false);
  assert.equal(await replayMode(answer({ 'x-airlock-mode': 'live' })), false);
  assert.equal(
    await replayMode((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch),
    false,
  );
});

// AIR-346 (D18): the replay page has a title, so the outline and a screen reader start from it, and it comes before the recorded-run label.
test('replay shell: an h1 names the page, before the banner', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReplayShell } = await import('../src/replay/ReplayShell.tsx');
  const html = renderToStaticMarkup(createElement(ReplayShell));
  const h1 = html.indexOf('<h1');
  assert.ok(h1 >= 0, 'an h1');
  assert.ok(h1 < html.indexOf('data-testid="replay-banner"'));
  assert.ok(html.includes('The recorded run, act by act'));
});
