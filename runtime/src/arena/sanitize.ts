// AIR-336: the recorded samples the /credit page shows are text a model wrote to steal money, so they are cleaned for what such a model
// writes, not only for URLs. Order: invisible controls out, NFKC, URLs out, every token shaped like an account or an address becomes [payee]
// (NEAR names, dotted account shapes, emails, 0x hex, long hex, base64 or base58 runs, punycode labels), then anything not printable ASCII
// is dropped (look-alike letters included), dash runs are cut to one hyphen. A sample is dropped whole when it still names the network or a
// person, matches the banned list, or is under 40 characters.
import { roundsOf } from './archive.ts';
import type { ArenaRecord, RoundRecord } from './archive.ts';

const INVISIBLE = /[­؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
const URL_RE = /\b(?:https?|ftp|wss?):\/\/\S+|\bwww\.\S+/giu;
const TOKENS: readonly RegExp[] = [
  /\bxn-{2}[\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)*/giu,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+/gu,
  /\b0x[0-9a-f]+\b/giu,
  /[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:near|testnet|tg|aurora|eth|sol|base)\b/giu,
  // a dotted account shape: two or more parts, at least one letter (an amount like 0.01 stays)
  /(?<![\p{L}\p{N}.])(?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?![\p{L}\p{N}])/gu,
  /\b[0-9a-f]{16,}\b/giu,
  /[A-Za-z0-9+/_-]{20,}={0,2}/gu,
];
const PAYEE = '[payee]';

export function sanitizeText(input: string): string {
  let s = input.replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '');
  s = s.replace(URL_RE, ' ');
  for (const re of TOKENS) s = s.replace(re, PAYEE);
  // typographic dashes and quotes to ASCII before the non-ASCII drop; dash runs to one hyphen (no double hyphens anywhere)
  s = s.replace(/[‒-―−]/gu, ', ').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"');
  s = s.replace(/[^\x20-\x7e\n]/g, '');
  s = s.replace(/-{2,}/g, '-').replace(/\[payee\](?:[\s.,:;-]*\[payee\])+/g, PAYEE);
  s = s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ ,/g, ',').replace(/,\s*,/g, ',');
  return s.trim();
}

/** The banned phrases of docs/banned-phrases.txt as case-insensitive expressions; README-only lines do not apply to the page. */
export function bannedRegexes(fileText: string): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of fileText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('README-only:')) continue;
    out.push(new RegExp(line, 'i'));
  }
  return out;
}

const DROP = /testnet|erfan/i;
export const MIN_SAMPLE_CHARS = 40;

/** The sanitized text, or null when the sample must be dropped. */
export function keepSample(text: string, banned: readonly RegExp[]): string | null {
  const s = sanitizeText(text);
  if (DROP.test(s) || s.length < MIN_SAMPLE_CHARS) return null;
  if (banned.some((re) => re.test(s))) return null;
  return s;
}

export type Sample = { at: string; subject: string; body: string; verdict: string; reason: string | null; tx: string | null; source: RoundRecord['source'] };

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  // never end on half a [payee] marker or half a word
  const head = s.slice(0, max).replace(/\[[a-z]*$/, '');
  const space = head.lastIndexOf(' ');
  return (space > max * 0.6 ? head.slice(0, space) : head).trimEnd();
}

/** The latest `n` live rounds whose receipts were read, as samples (each says who wrote the email: the model, or the rule fallback): subject and the first `chars` characters of the body, sanitized; a round that fails is skipped. */
export function samplesOf(records: readonly ArenaRecord[], banned: readonly RegExp[], n = 12, chars = 280): Sample[] {
  const rounds = roundsOf(records).filter((r) => !r.dry && r.tx !== null && r.verdict !== 'unread').sort((a, b) => b.atMs - a.atMs);
  const out: Sample[] = [];
  for (const r of rounds) {
    if (out.length >= n) break;
    const body = keepSample(r.body, banned);
    if (body === null) continue;
    const shortBody = cut(body, chars);
    if (keepSample(shortBody, banned) !== shortBody) continue;
    const subject = cut(sanitizeText(r.subject), 120);
    if (subject === '' || DROP.test(subject) || banned.some((re) => re.test(subject))) continue;
    out.push({ at: r.at, subject, body: shortBody, verdict: r.verdict, reason: r.reason, tx: r.tx, source: r.source });
  }
  return out;
}
