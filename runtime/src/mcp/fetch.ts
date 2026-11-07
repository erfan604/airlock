// fetch_page's live fetch (AIR-313): off unless the owner's config lists hosts in `fetch_hosts`, and then only those hosts, only https, only
// public addresses. The URL's host must be a DNS name on the owner's list (an IP literal in any spelling is refused; the WHATWG parser has
// already turned 0x7f000001 and 2130706433 into 127.0.0.1). The name is resolved once with every address, all of them must be public
// (no loopback, unspecified, RFC 1918, CGNAT, link-local, ULA, multicast, reserved, or an IPv4-mapped or NAT64 form of those), and the
// connection goes to the first vetted address through the request's own `lookup`, so a second resolution (DNS rebinding) cannot swap it.
// A redirect is an error, the body is capped, and the request times out.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { SessionRefusal } from './session.ts';

export const FETCH_MAX_BYTES = 200 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['::', 96],
  ['2002::', 16],
  ['2001::', 32],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Whether an address may be connected to: a public unicast address, IPv4 or IPv6. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // an IPv4-mapped address is refused outright (BlockList would match its IPv4 form against the IPv4 rules, and a DNS name has no
  // reason to answer one); it is checked here and not as a ::ffff:0:0/96 rule, which BlockList also applies to plain IPv4 addresses
  if (family === 6) return !/^::ffff:/i.test(address) && !/^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:/i.test(address) && !blocked.check(address, 'ipv6');
  return false;
}

export interface FetchDeps {
  /** every address of a name; the default is dns.lookup with `all: true` */
  resolve(host: string): Promise<{ address: string; family: number }[]>;
  /** the https request, the default is node:https; tests replace it */
  request(opts: RequestOptions, onResponse: (res: import('node:http').IncomingMessage) => void): import('node:http').ClientRequest;
}

const defaultDeps: FetchDeps = {
  resolve: (host) => dnsLookup(host, { all: true, verbatim: true }),
  request: (opts, cb) => httpsRequest(opts, cb),
};

const refuse = (code: string, message: string): SessionRefusal => new SessionRefusal(code, message);

/** The fetcher for an allowlist of hosts (lowercase DNS names). An empty list means no live fetch at all. */
export function makeFetchLive(hosts: readonly string[], deps: FetchDeps = defaultDeps): (url: string) => Promise<string> {
  const allowed = new Set(hosts.map((h) => h.toLowerCase().replace(/\.$/, '')));
  return async (raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw refuse('BadUrl', 'not a URL');
    }
    if (u.protocol !== 'https:') throw refuse('NotHttps', 'https only');
    if (u.username !== '' || u.password !== '') throw refuse('BadUrl', 'a URL with credentials is refused');
    if (u.port !== '' && u.port !== '443') throw refuse('BadUrl', 'only the default https port');
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    // an IPv6 literal keeps its brackets in hostname; every IPv4 spelling is already dotted decimal here
    if (host.startsWith('[') || isIP(host) !== 0) throw refuse('IpLiteral', 'an IP address is refused; the owner lists host names');
    if (!allowed.has(host)) throw refuse('HostNotAllowed', 'the host is not in the fetch_hosts list of the owner config');

    let addresses: { address: string; family: number }[];
    try {
      addresses = await deps.resolve(host);
    } catch {
      throw refuse('DnsFailed', 'the host does not resolve');
    }
    if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) throw refuse('PrivateAddress', 'the host resolves to a private or reserved address');
    const pinned = addresses[0] as { address: string; family: number };
    // the connection uses this address and no other: the request's own lookup never asks DNS again
    const lookup: LookupFunction = (_name, opts, cb) => {
      if (typeof opts === 'object' && opts !== null && 'all' in opts && opts.all === true) {
        (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
      } else cb(null, pinned.address, pinned.family);
    };

    return new Promise<string>((resolve, reject) => {
      const req = deps.request(
        { method: 'GET', host, servername: host, port: 443, path: `${u.pathname}${u.search}`, lookup, headers: { accept: 'text/*', 'user-agent': 'airlock-mcp' }, timeout: FETCH_TIMEOUT_MS },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            reject(refuse('Redirect', 'a redirect is refused'));
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(refuse('HttpStatus', `the page answered ${status}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size >= FETCH_MAX_BYTES) return;
            chunks.push(chunk.subarray(0, FETCH_MAX_BYTES - size));
            size += chunk.length;
            if (size >= FETCH_MAX_BYTES) res.destroy();
          });
          res.on('close', () => resolve(new TextDecoder().decode(Buffer.concat(chunks))));
          res.on('error', () => resolve(new TextDecoder().decode(Buffer.concat(chunks))));
        },
      );
      req.on('timeout', () => req.destroy(refuse('Timeout', 'the page took too long')));
      req.on('error', (e) => reject(e instanceof SessionRefusal ? e : refuse('FetchFailed', 'the page could not be fetched')));
      req.end();
    });
  };
}
