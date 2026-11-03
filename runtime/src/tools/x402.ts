// fetch_paid (AIR-128): the 402 payment requirements of a fixture server, returned as plain data. fixtureTools labels the whole output
// Untrusted:payment_protocol (channels.ts), so nothing read from it is ever Book or Owner by itself: Book comes from a `lookup` in the
// plan, Owner from the plan's own literals. No network, no file access, no clock, no number type: an amount stays the decimal string of
// the fixture and a payee key is built from strings only.
//
// `expect_payee` is an explicit all-or-nothing stop. When the plan passes it, a server that names another payee throws, and the
// interpreter turns any throwing tool into the abort ToolError (AIR-121's AbortCode list has no x402 code), so the check creates no
// branch and no pc taint. The errors carry fixed messages: a message never repeats a value the server sent.
// The signed `offer` is returned as data and nothing more. The Floor has no key, scheme or verifier for it, and an attacker's own
// server signs its own offer (verification is AIR-168).
import { KeyError, canonicalEvm, canonicalNear, validatePayeeKey } from '../dsl/keys.ts';
import { ToolArgError } from './fixtures.ts';
import type { World, X402Requirements, X402Server } from './world.ts';

/** The server names another payee than the one the plan expects, or a payee that is not a valid key. The message is fixed. */
export class X402PayeeMismatch extends Error {
  constructor() {
    super('x402: the payee of the server is not the expected payee');
    this.name = 'X402PayeeMismatch';
  }
}

/** The requirement is priced in another asset than the plan pays in (AIR-231): an amount means nothing without its unit. The message is fixed. */
export class X402AssetMismatch extends Error {
  constructor() {
    super('x402: the asset of the server is not the asset the plan pays in');
    this.name = 'X402AssetMismatch';
  }
}

/** The asset a plan pays in through fetch_paid unless it names another with `expect_asset`: the `transfer` action moves NEAR. */
export const DEFAULT_EXPECTED_ASSET = 'near';

/** The network of the server has no payee key scheme (only near:testnet and eip155:<chain id> have one). The message is fixed. */
export class X402NetworkError extends Error {
  constructor() {
    super('x402: the network of the server has no payee key scheme');
    this.name = 'X402NetworkError';
  }
}

export interface FetchPaidResult {
  requirements: X402Requirements | null;
  offer?: X402Server['offer'];
}

// a CAIP-2 EVM network: a chain id of decimal digits with no leading zero (validatePayeeKey bounds it to 2^64 - 1)
const EVM_NETWORK = /^eip155:([1-9][0-9]{0,19})$/;

/** The payee key prefix the network decides: `near:` or `evm:<chain id>:`. Any other network throws X402NetworkError. */
function keyPrefix(network: string): string {
  if (network === 'near:testnet') return 'near:';
  const match = EVM_NETWORK.exec(network);
  const id = match?.[1];
  if (id === undefined) throw new X402NetworkError();
  return `evm:${id}:`;
}

/**
 * The canonical payee key of what `payTo` names on `network`. A bare account or address is canonicalized by the network's scheme; a
 * payTo that is already a key must carry the scheme and chain id of the network. A KeyError and a scheme mismatch both end as
 * X402PayeeMismatch, and the key is validated whatever way it was built.
 */
function payeeKeyOf(network: string, payTo: string): string {
  const prefix = keyPrefix(network);
  try {
    let key: string;
    if (payTo.startsWith('near:') || payTo.startsWith('evm:')) {
      if (!payTo.startsWith(prefix)) throw new X402PayeeMismatch();
      key = payTo;
    } else {
      key = prefix === 'near:' ? `near:${canonicalNear(payTo)}` : `${prefix}${canonicalEvm(payTo)}`;
    }
    validatePayeeKey(key);
    return key;
  } catch (error) {
    if (error instanceof KeyError) throw new X402PayeeMismatch();
    throw error;
  }
}

/**
 * `args.url` must be a string; a url the world has no server for answers `{ requirements: null }` (an unknown server says nothing, like
 * fetch_url returning an empty page). A hit returns a copy of the stored server. `args.expect_asset`, when present, must equal the server's asset exactly (default `near`, what a `transfer` moves), else this throws X402AssetMismatch. `args.expect_payee`, when present, must be a string and
 * the server must name that payee on its own network, else this throws.
 */
export function fetchPaid(world: World, args: Readonly<Record<string, unknown>>, opts: { checkAsset?: boolean } = {}): FetchPaidResult {
  const url = Object.hasOwn(args, 'url') ? args['url'] : undefined;
  if (typeof url !== 'string') throw new ToolArgError('fetch_paid: argument url must be a string');
  let expectPayee: string | undefined;
  if (Object.hasOwn(args, 'expect_payee')) {
    const wanted = args['expect_payee'];
    if (typeof wanted !== 'string') throw new ToolArgError('fetch_paid: argument expect_payee must be a string');
    expectPayee = wanted;
  }

  let expectAsset = DEFAULT_EXPECTED_ASSET;
  if (Object.hasOwn(args, 'expect_asset')) {
    const wanted = args['expect_asset'];
    if (typeof wanted !== 'string') throw new ToolArgError('fetch_paid: argument expect_asset must be a string');
    expectAsset = wanted;
  }

  const stored = Object.hasOwn(world.paid402, url) ? world.paid402[url] : undefined;
  if (stored === undefined) return { requirements: null };
  const server = structuredClone(stored);
  // the amount is only meaningful with its asset: a requirement in another asset never reaches the plan (exact comparison, no folding)
  if (opts.checkAsset !== false && server.requirements.asset !== expectAsset) throw new X402AssetMismatch();
  if (expectPayee !== undefined && payeeKeyOf(server.requirements.network, server.requirements.payTo) !== expectPayee) {
    throw new X402PayeeMismatch();
  }
  return server.offer === undefined ? { requirements: server.requirements } : { requirements: server.requirements, offer: server.offer };
}
