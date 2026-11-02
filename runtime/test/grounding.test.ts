// AIR-127: literal grounding. One test per vector; rows marked L are documented limits (docs/KNOWN_LIMITATIONS.md, REDTEAM R2-04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inOwnerWords } from '../src/analyze/index.ts';
import { ground, grounder } from '../src/interpreter/index.ts';

const EVM = '0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const KELVIN = 'K';

// the contract of AIR-180's inOwnerWords
test('inOwnerWords: 25 in "Pay 25 to landlord" at 24 decimals', () => assert.equal(inOwnerWords('25', 'Pay 25 to landlord', 24), true));
test('inOwnerWords: 25 equals 25.0 by value', () => assert.equal(inOwnerWords(25, 'Pay 25.0 to landlord', 24), true));
test('inOwnerWords: 25 is not in "Pay 5 to landlord"', () => assert.equal(inOwnerWords('25', 'Pay 5 to landlord', 24), false));
test('inOwnerWords: landlord is a whole word, case-insensitive', () => assert.equal(inOwnerWords('landlord', 'Pay my Landlord 5'), true));
test('inOwnerWords: landlord is not in landlords', () => assert.equal(inOwnerWords('landlord', 'pay my landlords'), false));

// amount
test('amount: number literal 25 grounds', () => assert.equal(ground(25, 'amount', 'Pay 25 to landlord', 24), true));
test('amount: string literal 25 grounds', () => assert.equal(ground('25', 'amount', 'Pay 25 to landlord', 24), true));
test('amount: 2.50 grounds on 2.5', () => assert.equal(ground('2.50', 'amount', 'Pay 2.5 NEAR to landlord', 24), true));
test('amount: 25 does not ground on 5', () => assert.equal(ground('25', 'amount', 'Pay 5 to landlord', 24), false));
test('amount: no decimals is false', () => assert.equal(ground('25', 'amount', 'Pay 25 to landlord'), false));
test('amount: more places than the asset has is false and does not throw', () =>
  assert.equal(ground('0.0000000000000000000000001', 'amount', 'Pay 0.0000000000000000000000001', 24), false));

// name
test('name: landlord in "Pay 25 to landlord"', () => assert.equal(ground('landlord', 'name', 'Pay 25 to landlord'), true));
test('name: case-insensitive', () => assert.equal(ground('LANDLORD', 'name', 'pay 25 to Landlord'), true));
test('name: not in landlords', () => assert.equal(ground('landlord', 'name', 'pay my landlords'), false));
test('name: a number literal is false', () => assert.equal(ground(25, 'name', 'Pay 25 to landlord'), false));
test('name: empty literal is false', () => assert.equal(ground('', 'name', 'Pay 25 to landlord'), false));
test('name: blank literal is false', () => assert.equal(ground('  ', 'name', 'Pay 25 to  landlord'), false));
test('name: a non-ASCII literal is false', () => assert.equal(ground('landlörd', 'name', 'pay landlörd'), false));
test('name: the Kelvin sign in owner text does not ground kamal', () => assert.equal(ground('kamal', 'name', `pay ${KELVIN}amal`), false));
test('name: near:landlord.testnet in "Pay near:landlord.testnet 5"', () => assert.equal(ground('near:landlord.testnet', 'name', 'Pay near:landlord.testnet 5'), true));

// address
test('address: 0x mixed-case literal grounds on the same owner token', () => assert.equal(ground(EVM, 'address', `Send 1 ETH to ${EVM}.`), true));
test('address: bare lowercase hex literal grounds', () => assert.equal(ground('d8da6bf26964af9d7eed9e03e53415d37aa96045', 'address', `Send 1 to ${EVM}`), true));
test('address: 0x lowercase literal grounds', () => assert.equal(ground('0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'address', `Send 1 to ${EVM}`), true));
test('address: a 0X literal is false', () => assert.equal(ground(`0X${EVM.slice(2)}`, 'address', `Send 1 to ${EVM}`), false));
test('address: sentence-final period does not matter', () => assert.equal(ground('landlord.testnet', 'address', 'Send 25 NEAR to landlord.testnet.'), true));
test('address: sub.landlord.testnet does not ground landlord.testnet', () => assert.equal(ground('landlord.testnet', 'address', 'Send 25 NEAR to sub.landlord.testnet'), false));
test('address: evil-landlord.testnet does not ground landlord.testnet', () => assert.equal(ground('landlord.testnet', 'address', 'Send 25 NEAR to evil-landlord.testnet'), false));
test('address: landlord.testnet.evil.com does not ground landlord.testnet', () => assert.equal(ground('landlord.testnet', 'address', 'Send 25 NEAR to landlord.testnet.evil.com'), false));
test('address: the literal Landlord.testnet is false', () => assert.equal(ground('Landlord.testnet', 'address', 'Send 25 NEAR to Landlord.testnet'), false));
test('address: owner text Landlord.testnet does not ground landlord.testnet', () => assert.equal(ground('landlord.testnet', 'address', 'Send 25 NEAR to Landlord.testnet'), false));
test('address: near: literal equals owner text without the prefix', () => assert.equal(ground('near:landlord.testnet', 'address', 'Send 25 NEAR to landlord.testnet'), true));
test('address: a number literal is false', () => assert.equal(ground(25, 'address', 'Send 25 NEAR to landlord.testnet'), false));

// fail closed
test('grounder: ownerText undefined grounds nothing', () => assert.equal(grounder('25', 'amount', { ownerText: undefined, decimals: 24 }), false));
test('grounder: with ownerText it grounds', () => assert.equal(grounder('25', 'amount', { ownerText: 'Pay 25', decimals: 24 }), true));

// documented limits
test('L pairing: 900 and 25 both ground on "pay 25 and 900 to nobody"', () => {
  assert.equal(ground('900', 'amount', 'pay 25 and 900 to nobody', 24), true);
  assert.equal(ground('25', 'amount', 'pay 25 and 900 to nobody', 24), true);
});
test('L negation: bob grounds in "do not pay bob, pay landlord 100"', () => assert.equal(ground('bob', 'name', 'do not pay bob, pay landlord 100'), true));
test('L thousands: 1 grounds on "1,000" and 1000 does not', () => {
  assert.equal(ground('1', 'amount', 'send bob 1,000', 24), true);
  assert.equal(ground('1000', 'amount', 'send bob 1,000', 24), false);
});

// closed gaps (security review): non-ASCII never separates a token, scheme and chain id are kept
test('closed: Cyrillic a after an address does not ground it', () => assert.equal(ground('alice.testnet', 'address', 'pay alice.testnet\u0430 5'), false));
test('closed: e-acute after a name does not ground it', () => assert.equal(ground('landlord', 'name', 'pay landlord\u00E9'), false));
test('closed: near: plus 40 hex does not ground on the same 0x address', () => assert.equal(ground(`near:${EVM.slice(2).toLowerCase()}`, 'address', `Send to ${EVM}`), false));
test('closed: evm:8453 does not ground on evm:1', () => assert.equal(ground(`evm:8453:${EVM}`, 'address', `Send to evm:1:${EVM}`), false));
test('closed: evm:8453 grounds on the bare address in any case', () => {
  assert.equal(ground(`evm:8453:${EVM}`, 'address', `Send to ${EVM}`), true);
  assert.equal(ground(`evm:8453:${EVM}`, 'address', `Send to ${EVM.toLowerCase()}`), true);
});
test('closed: a bare literal does not ground on an owner token that names a chain', () => assert.equal(ground(EVM, 'address', `Send to evm:1:${EVM}`), false));
test('closed: evm:8453 grounds on evm:8453', () => assert.equal(ground(`evm:8453:${EVM}`, 'address', `Send to evm:8453:${EVM}`), true));
test('closed: near:alice.testnet grounds on alice.testnet', () => assert.equal(ground('near:alice.testnet', 'address', 'Send to alice.testnet.'), true));
