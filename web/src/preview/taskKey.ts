// The local task key (AIR-185): a WebCrypto Ed25519 key pair whose private half can never be exported, kept in IndexedDB. There is no
// extractable fallback and no JavaScript implementation: a key that script can read is a key that cross-site scripting can take. A browser
// without Ed25519 gets KeyUnsupported and the console refuses to sign. The public half is always exportable.

export class KeyUnsupported extends Error {
  constructor() {
    super('KeyUnsupported');
    this.name = 'KeyUnsupported';
  }
}

export interface KeyStore {
  load(): Promise<CryptoKeyPair | null>;
  save(pair: CryptoKeyPair): Promise<void>;
  saveSalt(taskId: string, saltHex: string): Promise<void>;
  loadSalt(taskId: string): Promise<string | null>;
}

/** Keys and salts in memory, for tests and the fixture routes. */
export function memoryKeyStore(): KeyStore {
  let pair: CryptoKeyPair | null = null;
  const salts = new Map<string, string>();
  return {
    async load() {
      return pair;
    },
    async save(p) {
      pair = p;
    },
    async saveSalt(taskId, saltHex) {
      salts.set(taskId, saltHex);
    },
    async loadSalt(taskId) {
      return salts.get(taskId) ?? null;
    },
  };
}

const PAIR_KEY = 'task-key';

function open(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('keys');
      req.result.createObjectStore('salts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function run<T>(name: string, store: 'keys' | 'salts', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(name);
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/** A CryptoKeyPair with a non-extractable private key survives the structured clone into IndexedDB. */
export function indexedDbKeyStore(name = 'airlock-console'): KeyStore {
  return {
    async load() {
      const v = await run<unknown>(name, 'keys', 'readonly', (s) => s.get(PAIR_KEY));
      return v === undefined ? null : (v as CryptoKeyPair);
    },
    async save(pair) {
      await run(name, 'keys', 'readwrite', (s) => s.put(pair, PAIR_KEY));
    },
    async saveSalt(taskId, saltHex) {
      await run(name, 'salts', 'readwrite', (s) => s.put(saltHex, taskId));
    },
    async loadSalt(taskId) {
      const v = await run<unknown>(name, 'salts', 'readonly', (s) => s.get(taskId));
      return typeof v === 'string' ? v : null;
    },
  };
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin alphabet; each leading zero byte is a leading `1`. */
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // base 58 digits, least significant first
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += ALPHABET.charAt(digits[k] ?? 0);
  return out;
}

export type TaskKey = { publicKey: string; sign(bytes: Uint8Array): Promise<Uint8Array> };

/** Loads the key pair or makes one on first use. Throws KeyUnsupported when the browser has no Ed25519, and then stores nothing. */
export async function ensureKey(store: KeyStore): Promise<TaskKey> {
  let pair = await store.load();
  if (pair === null) {
    try {
      pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign'])) as CryptoKeyPair;
    } catch {
      throw new KeyUnsupported();
    }
    await store.save(pair);
  }
  const loaded = pair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', loaded.publicKey));
  return {
    publicKey: `ed25519:${base58(raw)}`,
    async sign(bytes) {
      return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, loaded.privateKey, new Uint8Array(bytes)));
    },
  };
}

/** The near-cli line that registers the key; wallet registration is not built (AIR-182 has no set_task_key). */
export function registrationCommand(o: { contractId: string; publicKey: string; ownerId: string }): string {
  return `near contract call-function as-transaction ${o.contractId} set_task_key json-args '{"public_key":"${o.publicKey}"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${o.ownerId} network-config testnet sign-with-keychain send`;
}
