// AIR-162: broadcasts the real signed transaction of the AIR-272 spike (runtime/test/fixtures/real-mpc/signed_tx.hex) to Base Sepolia and
// prints the last line `BROADCAST <hash> <status>`. The transaction is already mined, so the node answers `nonce too low`, the lookup
// finds the hash, and the line shows the receipt of the earlier broadcast. A network script: it is not part of the offline suite.
//   usage: tsx scripts/broadcast-fixture.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { broadcast } from '../src/chain/evm.ts';

const file = fileURLToPath(new URL('../test/fixtures/real-mpc/signed_tx.hex', import.meta.url));
const raw = readFileSync(file, 'utf8').trim() as Hex;
const { hash, status } = await broadcast(raw);
console.log(`BROADCAST ${hash} ${status}`);
