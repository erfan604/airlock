// AIR-362: the term sheet of the AIRLOCK credit pool. docs/terms.json is the one source: docs/TERMS.md is rendered from it (renderMarkdown)
// and the /terms page reads it. Every clause carries its status, and each reference names a file and lines that must still contain a named
// symbol, test or theorem, an EVIDENCE row that must still hold the transaction, or a transaction hash of full length. `checkTerms` returns
// one message per problem; scripts/terms-check.ts prints them and ends with `TERMS OK <n> covenants`. No dependencies beyond node.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { EVIDENCE, ROLES, STATUSES, clauses, lineText, refText, schedule } from '../web/src/terms/model.ts';
import type { Clause, Ref, Terms } from '../web/src/terms/model.ts';

export * from '../web/src/terms/model.ts';
export const ROOT = resolve(import.meta.dirname, '..');
export const SOURCE = 'docs/terms.json';
export const DOC = 'docs/TERMS.md';

/** Words this document never uses (AIR-362 design, the owner's list, and the claims rules). Whole words in prose, any case; a code
 * identifier joined by underscores (a test name) is not prose. */
export const BANNED_WORDS = ['guaranteed', 'trustless', 'risk-free', 'insured', 'no counterparty risk', 'enforced by a proof instead of a lawyer', 'first', 'only', 'unbreakable', 'proved secure', 'formally verified contract'];
const DASHES = new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}|--`);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export type Reader = (path: string) => string | null;
export const repoReader: Reader = (p) => {
  const f = join(ROOT, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

/** Every problem with the source, one line each; an empty list is a pass. */
export function checkTerms(t: Terms, read: Reader = repoReader): string[] {
  const out: string[] = [];
  const lines = new Map<string, string[] | null>();
  const fileLines = (p: string): string[] | null => {
    if (!lines.has(p)) lines.set(p, read(p)?.split('\n') ?? null);
    return lines.get(p) ?? null;
  };
  const seen = new Set<string>();
  for (const c of clauses(t)) {
    const at = `clause ${c.n}`;
    if (seen.has(c.n)) out.push(`${at}: the number is used twice`);
    seen.add(c.n);
    if (typeof c.text !== 'string' || !/^[A-Z].*[.]$/s.test(c.text.trim()) || c.text.trim().split(/\s+/).length < 4) out.push(`${at}: the ${c.kind} has no sentence`);
    if (!(STATUSES as readonly string[]).includes(c.status)) out.push(`${at}: the status is missing or not one of ${STATUSES.join(', ')}`);
    if (c.kind !== 'term' && c.kind !== 'limit') out.push(`${at}: kind must be term or limit`);
    if (c.kind === 'term' && !c.refs.some((r) => r.role === 'Enforced')) out.push(`${at}: a term needs the line that enforces it`);
    for (const r of c.refs) {
      if (!(ROLES as readonly string[]).includes(r.role)) out.push(`${at}: unknown role ${String(r.role)}`);
      if ('tx' in r) {
        if (!B58.test(r.tx)) out.push(`${at}: transaction ${r.tx} is not a full hash`);
        if (r.row !== undefined) {
          const row = fileLines(EVIDENCE)?.[r.row - 1];
          if (row === undefined || !row.includes(r.tx)) out.push(`${at}: ${EVIDENCE}:${String(r.row)} does not hold transaction ${r.tx}`);
        }
        continue;
      }
      const ls = fileLines(r.file);
      const to = 'to' in r && r.to !== undefined ? r.to : r.line;
      if (ls === null) {
        out.push(`${at}: ${r.file} does not exist`);
        continue;
      }
      if (!Number.isInteger(r.line) || r.line < 1 || to < r.line || to > ls.length) {
        out.push(`${at}: ${r.file}:${String(r.line)} is outside the file`);
        continue;
      }
      const span = ls.slice(r.line - 1, to).join('\n');
      if (r.has === '' || !span.includes(r.has)) out.push(`${at}: ${r.file}:${String(r.line)}${to !== r.line ? `-${String(to)}` : ''} does not contain "${r.has}"`);
    }
  }
  const p = t.parties;
  const row = fileLines(EVIDENCE)?.[p.row - 1] ?? '';
  for (const party of p.list) if (party.code !== undefined && !row.includes(party.code)) out.push(`parties: ${EVIDENCE}:${String(p.row)} does not hold code hash ${party.code}`);
  out.push(...wordingProblems(t));
  return out;
}

/** The text a reader sees, per clause and for the rest of the document. */
export function visibleTexts(t: Terms): { where: string; text: string; network: boolean }[] {
  const out: { where: string; text: string; network: boolean }[] = [
    { where: 'title', text: `${t.title} ${t.asOf} ${t.claim}`, network: false },
    { where: 'parties', text: `${t.parties.lead} ${t.parties.list.map((x) => `${x.role} ${x.account} ${x.code ?? ''}`).join(' ')}`, network: false },
  ];
  for (const part of t.parts) {
    out.push({ where: part.title, text: part.title, network: false });
    for (const c of part.clauses) out.push({ where: `clause ${c.n}`, text: `${c.text} ${c.status} ${c.refs.map(refText).join(' ')}`, network: c.network === true });
  }
  return out;
}

/** Banned words, the word testnet anywhere, the words "test network" outside the one clause that states it, and dashes. */
export function wordingProblems(t: Terms, extra: string[] = []): string[] {
  const out: string[] = [];
  const banned = [...BANNED_WORDS, ...extra];
  for (const v of visibleTexts(t)) {
    for (const w of banned) if (new RegExp(`(^|[^a-z_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z_]|$)`, 'i').test(v.text)) out.push(`${v.where}: banned wording "${w}"`);
    if (/testnet/i.test(v.text)) out.push(`${v.where}: the word testnet`);
    if (/test network/i.test(v.text) && !v.network) out.push(`${v.where}: "test network" outside the network clause`);
    if (DASHES.test(v.text)) out.push(`${v.where}: a dash`);
    if (/erfan/i.test(v.text)) out.push(`${v.where}: a personal name`);
  }
  if (clauses(t).filter((c) => c.network === true).length !== 1) out.push('exactly one clause must state the network');
  return out;
}

/** docs/TERMS.md, exactly. */
export function renderMarkdown(t: Terms): string {
  const out: string[] = [`# ${t.title}`, '', `As in force on ${t.asOf}. Generated from \`${SOURCE}\` by \`scripts/terms-check.ts --write\`; \`scripts/terms-check.ts\` checks every citation below.`, '', t.claim, '', '## Parties', '', t.parties.lead, ''];
  for (const p of t.parties.list) out.push(`- ${p.role}: \`${p.account}\`${p.code === undefined ? '' : `, code hash \`${p.code}\``}`);
  out.push('', `Code hashes: \`${EVIDENCE}\` line ${String(t.parties.row)}.`, '');
  for (const part of t.parts) {
    out.push(`## ${part.title}`, '');
    for (const c of part.clauses) {
      out.push(`**${c.n}** ${c.text} *(${c.status})*`, '');
      for (const r of c.refs) out.push(`- ${'tx' in r ? `Shown: ${r.what}, transaction \`${r.tx}\`${r.row === undefined ? '' : ` (\`${EVIDENCE}\` line ${String(r.row)})`}` : `${r.role}: ${'what' in r ? `${r.what}, ` : ''}\`${r.file}\` ${lineText(r)}${'name' in r && r.name !== undefined ? `, \`${r.name}\`` : ''}`}`);
      if (c.refs.length > 0) out.push('');
    }
  }
  out.push('## Schedule of cited files', '');
  for (const s of schedule(t)) out.push(`- \`${s.file}\`: ${s.lines.join(', ')}`);
  out.push('');
  return out.join('\n');
}

export function loadTerms(read: Reader = repoReader): Terms {
  const text = read(SOURCE);
  if (text === null) throw new Error(`${SOURCE} is missing`);
  return JSON.parse(text) as Terms;
}
