// AIR-362: the shape of docs/terms.json and the words the term sheet uses for it, shared by the /terms page and scripts/terms-lib.ts (which
// adds the checks and the Markdown). Pure functions, no I/O.
export const STATUSES = ['in force', 'from the upgrade'] as const;
export type Status = (typeof STATUSES)[number];
export const ROLES = ['Enforced', 'Proved', 'Kani', 'Tested', 'Measured', 'Shown'] as const;
export type Role = (typeof ROLES)[number];

/** A reference: lines of a file that must contain `has`, or a transaction (with the EVIDENCE row that records it, when there is one). */
export type Ref =
  | { role: Exclude<Role, 'Shown'>; file: string; line: number; to?: number; has: string; name?: string }
  | { role: 'Shown'; tx: string; what: string; row?: number }
  | { role: 'Shown'; file: string; line: number; has: string; what: string };

export type Clause = { n: string; kind: 'term' | 'limit'; text: string; status: Status; refs: Ref[]; network?: boolean };
export type Part = { title: string; clauses: Clause[] };
export type Party = { role: string; account: string; code?: string };
export type Terms = { title: string; asOf: string; claim: string; parties: { lead: string; list: Party[]; row: number }; parts: Part[] };

export const EVIDENCE = 'docs/EVIDENCE.md';

export function clauses(t: Terms): Clause[] {
  return t.parts.flatMap((p) => p.clauses);
}

/** A path as the document shows it: without the leading contracts/ folder. */
export const shortPath = (p: string): string => p.replace(/^contracts\//, '');
export const shortTx = (tx: string): string => `${tx.slice(0, 8)}…`;

export function lineText(r: { line: number; to?: number }): string {
  return r.to !== undefined && r.to !== r.line ? `${String(r.line)} to ${String(r.to)}` : String(r.line);
}

/** One reference in words: "Proved: airlock-verdict/src/lib.rs 218 to 222, p3_allowed_in_book". */
export function refText(r: Ref): string {
  if ('tx' in r) return `Shown: ${r.what}, transaction ${shortTx(r.tx)}${r.row === undefined ? '' : ` (EVIDENCE.md ${String(r.row)})`}`;
  const name = 'name' in r && r.name !== undefined ? `, ${r.name}` : '';
  const what = r.role === 'Shown' && 'what' in r ? `${r.what}, ` : '';
  return `${r.role}: ${what}${shortPath(r.file)} ${lineText(r)}${name}`;
}

/** Every cited file, with the lines cited, in path order: the schedule at the end. */
export function schedule(t: Terms): { file: string; lines: string[] }[] {
  const m = new Map<string, Set<string>>();
  const add = (f: string, l: string) => {
    if (!m.has(f)) m.set(f, new Set());
    m.get(f)?.add(l);
  };
  for (const c of clauses(t))
    for (const r of c.refs) {
      if ('tx' in r) {
        if (r.row !== undefined) add(EVIDENCE, String(r.row));
      } else add(r.file, lineText(r));
    }
  add(EVIDENCE, String(t.parties.row));
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, s]) => ({ file, lines: [...s].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)) }));
}

