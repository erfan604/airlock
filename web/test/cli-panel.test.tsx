// AIR-182: the CLI approve command and its panel (cut ladder rung 7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { APPROVE_PREPAID_TGAS } from '../src/wallet/approve.ts';
import { CliPanel, approveCliCommand } from '../src/wallet/CliPanel.tsx';

// the example request of AIR-087 (scripts/test-approve-cli.sh, case 1)
const args = { id: '7', to: 'near:accountant.erfan-airlock.testnet', asset: 'NEAR', amount: '9.4', why: 'UntrustedAmount', book: 'in_book' };
const o = { contractId: 'airlock-policy.erfan-airlock.testnet', ownerId: 'erfan-airlock.testnet' };

test('cli panel: the command equals the line scripts/approve-cli.sh prints for the AIR-087 example', () => {
  assert.equal(
    approveCliCommand(args, o),
    `near contract call-function as-transaction airlock-policy.erfan-airlock.testnet approve json-args '{"id":"7","to":"near:accountant.erfan-airlock.testnet","asset":"NEAR","amount":"9.4","why":"UntrustedAmount","book":"in_book"}' prepaid-gas '${APPROVE_PREPAID_TGAS} Tgas' attached-deposit '1 yoctoNEAR' sign-as erfan-airlock.testnet network-config testnet sign-with-keychain send`,
  );
});

test('cli panel: the gas in the command is the exported constant', () => {
  assert.ok(approveCliCommand(args, o).includes(`prepaid-gas '${APPROVE_PREPAID_TGAS} Tgas'`));
});

test('cli panel: a value with a single quote throws', () => {
  for (const key of ['id', 'to', 'asset', 'amount', 'why', 'book'] as const) {
    assert.throws(() => approveCliCommand({ ...args, [key]: "it's" }, o), Error, key);
  }
});

test('cli panel: the panel renders the command read only under the two test ids', () => {
  const html = renderToStaticMarkup(<CliPanel args={args} contractId={o.contractId} ownerId={o.ownerId} />);
  assert.ok(html.includes('data-testid="cli-panel"'));
  assert.ok(html.includes('data-testid="cli-command"'));
  assert.ok(!/<(input|textarea|button)/.test(html));
  assert.ok(html.includes('sign-with-keychain send'));
});
