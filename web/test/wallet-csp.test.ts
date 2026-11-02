// AIR-182: the nonce reader, the wallet UI origin table and the wallet origin check. The nonce, script-src and proxy tests are AIR-183's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ICON_ORIGINS, NEAR_RPC, WALLET_ORIGINS, WALLET_UI_ORIGINS, buildCsp, defaultCspInputs } from '../csp.ts';
import { checkWalletOrigins } from '../scripts/check-wallet-origins.ts';
import snapshot from '../src/wallet/manifest-snapshot.json' with { type: 'json' };
import { readCspNonce } from '../src/wallet/nonce.ts';

const base = { runtimeOrigin: 'http://localhost:8787', nearRpc: NEAR_RPC, walletOrigins: WALLET_ORIGINS, iconOrigins: ICON_ORIGINS, nonce: 'N0nce' };

const directive = (policy: string, name: string): string[] => {
  const line = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  assert.ok(line, `no ${name} directive`);
  return line.split(/\s+/).slice(1);
};

test('wallet csp: readCspNonce returns the nonce of the csp-nonce meta tag', () => {
  let selector = '';
  const doc = {
    querySelector(s: string) {
      selector = s;
      return { nonce: 'abc123==', getAttribute: () => null };
    },
  };
  assert.equal(readCspNonce(doc), 'abc123==');
  assert.equal(selector, 'meta[property="csp-nonce"]');
});

test('wallet csp: readCspNonce falls back to the attribute when the property is empty', () => {
  const doc = { querySelector: () => ({ nonce: '', getAttribute: (n: string) => (n === 'nonce' ? 'fromAttr' : null) }) };
  assert.equal(readCspNonce(doc), 'fromAttr');
});

test('wallet csp: readCspNonce is undefined without the tag or with an empty nonce', () => {
  assert.equal(readCspNonce({ querySelector: () => null }), undefined);
  assert.equal(readCspNonce({ querySelector: () => ({ nonce: '', getAttribute: () => null }) }), undefined);
});

test('wallet csp: buildCsp adds the UI origins of a wallet only when it is in the snapshot', () => {
  const without = buildCsp(base);
  assert.ok(!without.includes('rsms.me'));
  assert.ok(!without.includes('mc.meteorwallet.app'));
  const withMeteor = buildCsp({ ...base, walletIds: ['meteor-wallet'] });
  assert.ok(directive(withMeteor, 'connect-src').includes('https://mc.meteorwallet.app'));
  assert.ok(directive(withMeteor, 'font-src').includes('https://rsms.me'));
  assert.ok(directive(withMeteor, 'style-src').includes('https://fonts.cdnfonts.com'));
  assert.ok(directive(withMeteor, 'img-src').includes('https://meteorwallet.app'));
  // the primary wallet needs none, so its policy is the plain one
  assert.equal(buildCsp({ ...base, walletIds: ['intear-wallet'] }), without);
  // an id the table does not know adds nothing
  assert.equal(buildCsp({ ...base, walletIds: ['nobody'] }), without);
});

test('wallet csp: the measured table keeps the Meteor and NEAR CLI rows and none for Intear', () => {
  assert.equal(WALLET_UI_ORIGINS['intear-wallet'], undefined);
  assert.deepEqual(WALLET_UI_ORIGINS['near-cli']?.font, ['https://rsms.me']);
  assert.ok(WALLET_UI_ORIGINS['meteor-wallet']?.connect?.includes('https://mc.meteorwallet.app'));
});

test('wallet csp: the default inputs carry the snapshot wallet ids and the policy stays free of third party styles', () => {
  const inputs = defaultCspInputs();
  assert.deepEqual(inputs.walletIds, snapshot.wallets.map((w) => w.id));
  const csp = buildCsp({ ...inputs, nonce: 'x' });
  assert.ok(!csp.includes('rsms.me'));
});

test('wallet csp: the origin check passes for the pinned snapshot under the default policy', () => {
  const r = checkWalletOrigins(snapshot, buildCsp({ ...defaultCspInputs(), nonce: 'x' }));
  assert.deepEqual(r.missing, []);
  assert.ok(r.origins >= 1);
});

test('wallet csp: the origin check fails for a snapshot whose executor origin is missing from the policy', () => {
  const moved = structuredClone(snapshot);
  const w = moved.wallets[0];
  assert.ok(w);
  w.executor = 'https://executor.elsewhere.example/near-selector.js';
  const r = checkWalletOrigins(moved, buildCsp({ ...defaultCspInputs(), nonce: 'x' }));
  assert.ok(r.missing.some((m) => m.includes('https://executor.elsewhere.example') && m.includes('connect-src')));
  assert.ok(r.missing.some((m) => m.includes('https://executor.elsewhere.example') && m.includes('frame-src')));
});

test('wallet csp: the origin check wants a non data icon in img-src and ignores a data icon', () => {
  const remote = structuredClone(snapshot);
  const w = remote.wallets[0];
  assert.ok(w);
  w.icon = 'https://icons.elsewhere.example/i.png';
  const r = checkWalletOrigins(remote, buildCsp({ ...defaultCspInputs(), nonce: 'x' }));
  assert.ok(r.missing.some((m) => m.includes('https://icons.elsewhere.example') && m.includes('img-src')));
  assert.deepEqual(checkWalletOrigins(snapshot, buildCsp({ ...defaultCspInputs(), nonce: 'x' })).missing, []);
});
