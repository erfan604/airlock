// AIR-100: checks that the unsigned EIP-1559 bytes the contract built are the canonical encoding viem reads and writes.
// Usage: node scripts/check-evm-preimage.mjs <hex without 0x>
// Prints `preimage matches viem` and the keccak256 of the bytes, or `mismatch` (exit 1).
import { keccak256, parseTransaction, serializeTransaction } from 'viem';

const arg = process.argv[2];
if (!arg || !/^[0-9a-f]+$/.test(arg)) {
  console.log('mismatch: no lowercase hex argument');
  process.exit(1);
}
const hex = `0x${arg}`;
try {
  const tx = parseTransaction(hex);
  if (tx.type !== 'eip1559') {
    console.log('mismatch: type ' + tx.type);
    process.exit(1);
  }
  if (serializeTransaction(tx) !== hex) {
    console.log('mismatch');
    process.exit(1);
  }
  console.log('preimage matches viem');
  console.log(keccak256(hex));
} catch (error) {
  console.log('mismatch: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
