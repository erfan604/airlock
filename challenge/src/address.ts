// Who is asking: the visitor's address for the rate limits. The socket address is the default. A proxy header (`X-Forwarded-For`, `CF-Connecting-IP`)
// is read only when the socket itself belongs to a configured trusted proxy, and then strictly: `X-Forwarded-For` gives its rightmost hop (the
// one the trusted proxy added, everything left of it is the client's to forge), any other header must hold exactly one address, and a missing,
// malformed or over long value is refused, never replaced by the socket address (that would be the proxy's own address, one bucket for everyone).
// A request from a socket that is not a trusted proxy is judged by its socket address and its header is ignored.
import { isIP } from 'node:net';

export interface AddressRules {
  /** lower case header name, or null for no proxy */
  header: string | null;
  /** exact addresses, or IPv4 CIDR blocks (`10.0.0.0/8`) */
  trusted: readonly string[];
}

export type Address = { ok: true; address: string } | { ok: false };

const MAX_HEADER = 256;

/** `::ffff:1.2.3.4` is `1.2.3.4`; anything that is not an IP address is null. */
export function normalizeIp(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  const ip = v4?.[1] ?? s;
  return isIP(ip) === 0 ? null : ip;
}

function v4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + +part, 0);
}

/** True when `ip` equals a trusted address or lies in a trusted IPv4 block. */
export function isTrusted(ip: string, trusted: readonly string[]): boolean {
  for (const entry of trusted) {
    const [base, bits] = entry.split('/');
    if (base === undefined) continue;
    if (bits === undefined) {
      if (normalizeIp(base) === ip) return true;
    } else if (isIP(ip) === 4 && isIP(base) === 4 && /^\d{1,2}$/.test(bits) && +bits <= 32) {
      const mask = +bits === 0 ? 0 : (0xffffffff << (32 - +bits)) >>> 0;
      if ((v4Number(ip) & mask) >>> 0 === (v4Number(base) & mask) >>> 0) return true;
    }
  }
  return false;
}

/** Entries of CHALLENGE_TRUSTED_PROXIES must be addresses or IPv4 blocks. */
export function validTrustedEntry(entry: string): boolean {
  const [base, bits, extra] = entry.split('/');
  if (extra !== undefined || base === undefined) return false;
  if (bits === undefined) return normalizeIp(base) !== null;
  return isIP(base) === 4 && /^\d{1,2}$/.test(bits) && +bits <= 32;
}

export function resolveAddress(rules: AddressRules, remote: string | null | undefined, header: (name: string) => string | undefined): Address {
  const socket = remote === null || remote === undefined ? null : normalizeIp(remote);
  if (socket === null) return { ok: false };
  if (rules.header === null || !isTrusted(socket, rules.trusted)) return { ok: true, address: socket };
  const value = header(rules.header);
  if (value === undefined || value.length === 0 || value.length > MAX_HEADER) return { ok: false };
  let hop: string;
  if (rules.header === 'x-forwarded-for') {
    hop = value.split(',').at(-1) ?? '';
  } else {
    if (value.includes(',')) return { ok: false };
    hop = value;
  }
  const ip = normalizeIp(hop);
  return ip === null ? { ok: false } : { ok: true, address: ip };
}
