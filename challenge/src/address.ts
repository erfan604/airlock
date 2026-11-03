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
  /** an IPv6 visitor is the prefix of this many bits (48 to 64, default 64): a client owns a whole /64, so one address is not one visitor */
  v6Prefix?: number;
}

export const DEFAULT_V6_PREFIX = 64;

export type Address = { ok: true; address: string } | { ok: false };

const MAX_HEADER = 256;

/** `::ffff:1.2.3.4` is `1.2.3.4`; anything that is not an IP address is null. */
export function normalizeIp(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/%.*$/, '');
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

function hextets(ip: string): number[] | null {
  let text = ip;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const n = (dotted[2] ?? '').split('.').map((x) => +x);
    text = `${dotted[1] ?? ''}${((n[0] ?? 0) * 256 + (n[1] ?? 0)).toString(16)}:${((n[2] ?? 0) * 256 + (n[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 && (halves[1] ?? '') !== '' ? (halves[1] ?? '').split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? +`0x${h}` : -1));
  return all.length === 8 && all.every((h) => h >= 0 && h <= 0xffff) ? all : null;
}

/**
 * The rate limit bucket of an address: an IPv4 address is its own bucket, an IPv6 address becomes its first `bits` bits (48 to 64) written as
 * `<prefix>::/<bits>`. Two addresses in one /64 are one visitor; the mapped form `::ffff:a.b.c.d` has already become plain IPv4.
 */
export function bucketOf(ip: string, bits: number = DEFAULT_V6_PREFIX): string {
  if (isIP(ip) !== 6) return ip;
  const parts = hextets(ip);
  if (parts === null) return ip;
  const b = Math.min(64, Math.max(48, Math.trunc(bits)));
  const kept = parts.map((h, i) => {
    const lo = i * 16;
    if (lo + 16 <= b) return h;
    if (lo >= b) return 0;
    return (h & (0xffff << (16 - (b - lo)))) & 0xffff;
  });
  const used = Math.ceil(b / 16);
  return `${kept.slice(0, used).map((h) => h.toString(16)).join(':')}::/${String(b)}`;
}

export function resolveAddress(rules: AddressRules, remote: string | null | undefined, header: (name: string) => string | undefined): Address {
  const socket = remote === null || remote === undefined ? null : normalizeIp(remote);
  if (socket === null) return { ok: false };
  const bits = rules.v6Prefix ?? DEFAULT_V6_PREFIX;
  if (rules.header === null || !isTrusted(socket, rules.trusted)) return { ok: true, address: bucketOf(socket, bits) };
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
  return ip === null ? { ok: false } : { ok: true, address: bucketOf(ip, bits) };
}
