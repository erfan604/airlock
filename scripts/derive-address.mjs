#!/usr/bin/env node
// AIR-049: the Base Sepolia address the MPC signer controls for (policy account, path). Offline (chainsig.js key derivation).
//   node scripts/derive-address.mjs <policy account> <path>      prints the EIP-55 address
// adapted from the research repo spike spikes/real-mpc/derive.mjs (own code, same author): contract id and path are arguments.
import { contracts, chainAdapters } from 'chainsig.js';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

const [contractId, derivationPath] = process.argv.slice(2);
if (process.argv.length !== 4 || !contractId || !derivationPath) {
  process.stderr.write('usage: node scripts/derive-address.mjs <policy account> <path>\n');
  process.exit(2);
}
const contract = new contracts.ChainSignatureContract({ networkId: 'testnet', contractId: 'v1.signer-prod.testnet' });
const evm = new chainAdapters.evm.EVM({ publicClient: createPublicClient({ chain: baseSepolia, transport: http() }), contract });
const { address } = await evm.deriveAddressAndPublicKey(contractId, derivationPath);
console.log(address);
