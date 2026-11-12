// AIR-361: the data of the Break the proof page. web/public/mutants/manifest.json is written by scripts/break-proof-attacks.ts from
// scripts/canary/break-proof.tsv: each copy is the real verdict with one rule taken out (the patch), the attack the real gate refuses and the
// copy pays, the Kani harness that fails on the copy and the Lean theorem it breaks. The page runs every answer itself with the wasm files;
// the tags in the manifest are what the tests compare it with. Amounts stay BigInt or decimal strings.
import { REASONS } from '../try/verdictWasm.ts';
import type { ReasonName, VerdictModule, WasmVerdict } from '../try/verdictWasm.ts';

/** The coverage text the page shows word for word (AIR-361 design, Copy). */
export const COVERAGE =
  "The Lean theorems are proved about a model of the gate written in Lean from the Rust function; they do not read the Rust. Two checks tie the model to the code: Kani checks the same properties on the Rust function itself for every input its harness allows, and a test runs the Lean model and the Rust function on generated cases (40,000 in the full check, 2,000 in the quick one) and compares every answer. None of this covers the rest of the contract: storage, the address book proofs, the ledgers' bookkeeping, signatures, the agent, the model or the chain.";

export type Labels = { recipient: string[]; amount: string[]; pc: string[] };

export type Attack = {
  id: string;
  title: string;
  story: string;
  source: string;
  constructed: boolean;
  /** the payee as the page names it (an alias or a short account name) */
  payee: string;
  /** the amount in whole units, a decimal string, and its symbol */
  amount: string;
  symbol: string;
  labels: Labels;
  /** the 21 verdict columns as decimal strings (web/src/try/verdictWasm.ts) */
  columns: string[];
};

export type Copy = {
  id: string;
  title: string;
  patch: string;
  patchText: string;
  /** the lines of contracts/airlock-verdict/src/lib.rs the patch changes, in the unpatched file */
  rule: { file: string; from: number; to: number };
  attack: string;
  wasm: string;
  sha256: string;
  size: number;
  realTag: string;
  copyTag: string;
  harness: { name: string; file: string; line: number };
  lean: { name: string; file: string; line: number; statement: string };
  kani: string;
};

export type Manifest = { realSha256: string; attacks: Attack[]; copies: Copy[] };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function attackOk(a: unknown): a is Attack {
  if (!isObj(a)) return false;
  const l = a.labels;
  return (
    [a.id, a.title, a.story, a.source, a.payee, a.amount, a.symbol].every(isStr) &&
    typeof a.constructed === 'boolean' &&
    isObj(l) &&
    strs(l.recipient) &&
    strs(l.amount) &&
    strs(l.pc) &&
    strs(a.columns) &&
    a.columns.length === 21 &&
    a.columns.every((c) => /^[0-9]{1,39}$/.test(c))
  );
}

function copyOk(c: unknown): c is Copy {
  if (!isObj(c)) return false;
  const { rule, harness, lean } = c;
  return (
    [c.id, c.title, c.patch, c.patchText, c.attack, c.wasm, c.sha256, c.realTag, c.copyTag, c.kani].every(isStr) &&
    isNum(c.size) &&
    isObj(rule) &&
    isStr(rule.file) &&
    isNum(rule.from) &&
    isNum(rule.to) &&
    isObj(harness) &&
    isStr(harness.name) &&
    isStr(harness.file) &&
    isNum(harness.line) &&
    isObj(lean) &&
    isStr(lean.name) &&
    isStr(lean.file) &&
    isNum(lean.line) &&
    isStr(lean.statement)
  );
}

/** The manifest, or null for anything that is not one. */
export function parseManifest(v: unknown): Manifest | null {
  if (!isObj(v) || !isStr(v.realSha256) || !Array.isArray(v.attacks) || !Array.isArray(v.copies)) return null;
  if (!v.attacks.every(attackOk) || !v.copies.every(copyOk)) return null;
  return { realSha256: v.realSha256, attacks: v.attacks, copies: v.copies };
}

/** Plain words for each reason the gate can hold or block with. */
const REASON_WORDS: Record<ReasonName, string> = {
  UnknownAsset: 'the asset is not registered',
  Paused: 'the owner paused payments',
  AmountOutOfBounds: 'the amount is over the hard cap',
  DailyLimit: 'the amount is over what is left today',
  FeeTooHigh: 'the fee is over the limit',
  MissingProvenance: 'a value has no origin',
  BookLabelNotInBook: 'the payee claims a book entry it does not have',
  OutsideTask: 'the payment is outside the signed task',
  OverTaskBound: 'nothing is left of the signed task for this payee',
  UntrustedTrigger: 'outside text decided to pay',
  UntrustedRecipient: 'outside text picked the payee',
  NewRecipient: 'the payee is not in the address book',
  OverPayeeLimit: 'the amount is over the payee limit',
  UntrustedAmount: 'the amount came from outside text and this payee has no cap',
  PendingFull: 'too many payments are waiting',
  EscalationsLocked: 'held payments are locked',
  EscalationBudget: 'the hold budget is used up',
};
export const reasonWords = (r: ReasonName): string => REASON_WORDS[r];
export const isReason = (r: string): r is ReasonName => (REASONS as readonly string[]).includes(r);

export type Side = { kind: 'paid'; line: string } | { kind: 'refused'; line: string; reason: ReasonName | null; held: boolean };

export function sideOf(a: Attack, v: WasmVerdict): Side {
  if (v.kind === 'allow') return { kind: 'paid', line: `${a.amount} ${a.symbol} sent to ${a.payee}` };
  if (v.kind === 'malformed') return { kind: 'refused', line: 'The request is outside the gate\'s domain', reason: null, held: false };
  return v.kind === 'escalate'
    ? { kind: 'refused', line: `Held for the owner: ${v.reason}`, reason: v.reason, held: true }
    : { kind: 'refused', line: `Blocked: ${v.reason}`, reason: v.reason, held: false };
}

export type Result = { real: Side; copy: Side; line: string };

/** Both sides of one run and the sentence under them. The off diagonal is said as it is. */
export function resultOf(a: Attack, real: WasmVerdict, copy: WasmVerdict): Result {
  const r = sideOf(a, real);
  const c = sideOf(a, copy);
  let line: string;
  if (r.kind === 'refused' && c.kind === 'paid') line = 'The real gate refuses. The broken copy pays.';
  else if (r.kind === 'refused' && c.kind === 'refused') line = 'This copy also refuses: the rule it lost is not the one this attack needs. Pick the copy named under the attack to see it pay.';
  else if (r.kind === 'paid' && c.kind === 'paid') line = 'Both pay: this request breaks no rule.';
  else line = 'The real gate pays and the copy refuses.';
  return { real: r, copy: c, line };
}

/**
 * The copy whose missing rule an attack exploits: the first copy that pays it while the real gate refuses, found by running every copy on the
 * attack in the browser. Before the gates have loaded it is the copy the manifest pairs with the attack; undefined when no copy pays it.
 */
export function payingCopy(m: Manifest, a: Attack, gates: { real: VerdictModule; copies: Record<string, VerdictModule> } | null): Copy | undefined {
  if (gates === null) return m.copies.find((c) => c.attack === a.id);
  const cols = a.columns.map((v) => BigInt(v));
  if (gates.real.decide(cols).kind === 'allow') return undefined;
  return m.copies.find((c) => gates.copies[c.id]?.decide(cols).kind === 'allow');
}

/** The changed lines of a unified diff (no file headers): what the page shows of the patch. */
export function hunkLines(patch: string): { sign: ' ' | '-' | '+'; text: string }[] {
  const out: { sign: ' ' | '-' | '+'; text: string }[] = [];
  let inHunk = false;
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || l === '') continue;
    const s = l[0];
    if (s === ' ' || s === '-' || s === '+') out.push({ sign: s, text: l.slice(1) });
  }
  return out;
}
