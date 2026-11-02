// AIR-182: the session gate. The sign in flow and its fixed error texts are tested as functions; the clicks run in the approvals e2e.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WalletRefused } from '../src/wallet/connector.ts';
import { LoginError } from '../src/wallet/login.ts';
import { SessionGateView, gateErrorText, signIn } from '../src/wallet/SessionGate.tsx';

const child = (s: { accountId: string }) => <p data-testid="inside">{s.accountId}</p>;

test('gate: a signed out visitor sees login-connect and nothing inside', () => {
  const html = renderToStaticMarkup(<SessionGateView state={{ kind: 'out', error: null, busy: false }} onConnect={() => undefined}>{child}</SessionGateView>);
  assert.ok(html.includes('data-testid="login-connect"'));
  assert.ok(!html.includes('data-testid="inside"'));
  assert.ok(!html.includes('data-testid="login-error"'));
});

test('gate: an error shows the fixed text under login-error', () => {
  const text = gateErrorText(new WalletRefused());
  const html = renderToStaticMarkup(<SessionGateView state={{ kind: 'out', error: text, busy: false }} onConnect={() => undefined}>{child}</SessionGateView>);
  assert.ok(html.includes('data-testid="login-error"'));
  assert.ok(html.includes('This wallet does not show what it signs. Use the wallet the console lists.'));
});

test('gate: a signed in owner sees session-account and the children', () => {
  const html = renderToStaticMarkup(<SessionGateView state={{ kind: 'in', accountId: 'erfan-airlock.testnet' }} onConnect={() => undefined}>{child}</SessionGateView>);
  assert.ok(html.includes('data-testid="session-account"'));
  assert.ok(html.includes('data-testid="inside"'));
  assert.ok(!html.includes('data-testid="login-connect"'));
});

test('gate: nothing is shown while the session is being read', () => {
  const html = renderToStaticMarkup(<SessionGateView state={{ kind: 'loading' }} onConnect={() => undefined}>{child}</SessionGateView>);
  assert.ok(!html.includes('data-testid="inside"'));
  assert.ok(!html.includes('data-testid="login-connect"'));
});

test('gate: gateErrorText gives the fixed text of a LoginError or WalletRefused and the wallet text for anything else', () => {
  assert.equal(gateErrorText(new LoginError('rejected')), new LoginError('rejected').message);
  assert.equal(gateErrorText(new LoginError('rpc')), new LoginError('rpc').message);
  assert.equal(gateErrorText(new Error('secret server text')), new LoginError('wallet').message);
  assert.ok(!gateErrorText(new Error('secret server text')).includes('secret'));
});

test('gate: signIn runs connectWallet then login with that wallet', async () => {
  const order: string[] = [];
  const wallet = { signMessage: async () => ({ accountId: 'a', publicKey: 'p', signature: 's' }) };
  const r = await signIn({
    connectWallet: async () => (order.push('connect'), { wallet: wallet as never, accountId: 'owner.testnet', walletId: 'intear-wallet' }),
    login: async (w) => (order.push(w === (wallet as never) ? 'login' : 'wrong'), { accountId: 'owner.testnet' }),
  });
  assert.deepEqual(order, ['connect', 'login']);
  assert.deepEqual(r, { accountId: 'owner.testnet' });
});

test('gate: a refused wallet stops before login', async () => {
  let logged = false;
  await assert.rejects(
    () =>
      signIn({
        connectWallet: async () => {
          throw new WalletRefused();
        },
        login: async () => ((logged = true), { accountId: 'x' }),
      }),
    (e: unknown) => e instanceof WalletRefused,
  );
  assert.equal(logged, false);
});
