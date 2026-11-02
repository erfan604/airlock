// AIR-109: generates fixtures/eip3009-vectors.json, the EIP-3009 `TransferWithAuthorization` digests the contract's `x402::eip3009_digest`
// must reproduce. Run: `pnpm -C runtime exec tsx scripts/gen-eip3009-vectors.ts` (writes) or `... --check` (prints `vectors match`).
// BigInt and strings only; the PRNG is mulberry32 with a fixed seed, so a regeneration is byte identical.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress, hashDomain, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const TYPEHASH = '0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const PINNED_SEPARATOR = '0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818';
const M2_DIGEST = '0x2178b44a8b4de3e9911b1ae6639674f3f844d1ea965bc358ece95239ab834f8d';

const here = new URL('.', import.meta.url);
const OUT = fileURLToPath(new URL('../../fixtures/eip3009-vectors.json', here));

type Message = {
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};
type Domain = { name: string; version: string; chainId: bigint; verifyingContract: Hex };

function digestOf(domain: Domain, message: Message): Hex {
  return hashTypedData({ domain, types: TYPES, primaryType: 'TransferWithAuthorization', message });
}

function fail(text: string): never {
  console.error(`ASSERTION FAILED: ${text}`);
  process.exit(1);
}

function lower(a: Hex): string {
  return a.toLowerCase();
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. the three assertions that everything else rests on
const typeString =
  'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)';
const typehash = keccak256(toHex(typeString));
if (typehash !== TYPEHASH) fail(`typehash ${typehash}`);

const usdcDomain: Domain = { name: 'USDC', version: '2', chainId: 84532n, verifyingContract: USDC };
const separator = hashDomain({
  domain: usdcDomain,
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
  },
});
if (separator !== PINNED_SEPARATOR) fail(`domain separator ${separator}`);

const m2From = privateKeyToAddress(`0x${'11'.repeat(32)}`);
const m2: Message = {
  from: m2From,
  to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  value: 10000n,
  validAfter: 0n,
  validBefore: 1740672154n,
  nonce: `0x${'ab'.repeat(32)}`,
};
const m2Digest = digestOf(usdcDomain, m2);
if (m2Digest !== M2_DIGEST) fail(`M2 digest ${m2Digest}`);

// 2. the vectors
const rand = mulberry32(20261022);
const randBytes = (n: number): Hex => {
  let s = '0x';
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 256).toString(16).padStart(2, '0');
  return s as Hex;
};
const randBig = (bits: number): bigint => {
  let v = 0n;
  for (let i = 0; i < bits; i += 8) v = (v << 8n) | BigInt(Math.floor(rand() * 256));
  return v & ((1n << BigInt(bits)) - 1n);
};

type Row = {
  domain_separator: string;
  from: string;
  to: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
  digest: string;
};

function row(domain: Domain, m: Message): Row {
  const sep = hashDomain({
    domain,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  });
  return {
    domain_separator: sep,
    from: lower(m.from),
    to: lower(m.to),
    value: m.value.toString(),
    valid_after: m.validAfter.toString(),
    valid_before: m.validBefore.toString(),
    nonce: m.nonce,
    digest: digestOf(domain, m),
  };
}

const vectors: Row[] = [];
for (let i = 0; i < 100; i++) {
  const domain: Domain =
    i === 0
      ? usdcDomain
      : {
          name: rand() < 0.5 ? 'USDC' : 'USD Coin',
          version: '2',
          chainId: 1n + randBig(32),
          verifyingContract: getAddress(randBytes(20)),
        };
  const message: Message = {
    from: getAddress(randBytes(20)),
    to: getAddress(randBytes(20)),
    value: i === 1 ? 0n : i === 2 ? (1n << 128n) - 1n : randBig(i % 2 === 0 ? 64 : 120),
    validAfter: i % 3 === 0 ? 0n : randBig(32),
    validBefore: 1_700_000_000n + randBig(30),
    nonce: randBytes(32),
  };
  vectors.push(row(domain, message));
}

const doc = {
  typehash: TYPEHASH,
  domain_separator: PINNED_SEPARATOR,
  m2_example: {
    from: lower(m2.from),
    to: lower(m2.to),
    value: m2.value.toString(),
    valid_after: '0',
    valid_before: m2.validBefore.toString(),
    nonce: m2.nonce,
    digest: m2Digest,
  },
  vectors,
};
const text = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    fail(`${OUT} is missing`);
  }
  if (current !== text) fail('fixtures/eip3009-vectors.json differs from a regeneration');
  console.log('vectors match');
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${vectors.length} vectors to ${OUT}`);
}
