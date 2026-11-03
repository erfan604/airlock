// What `pnpm try` plays (AIR-256): a corpus case, or a pasted text, through the gate path of the bench (AIR-277) with no model, no key and no
// chain. REAL: the verdict (the verdict CLI binary), the plan interpreter and its labels, the owner's task and book. SIMULATED: the reader is
// assumed fully hijacked (its plan and extraction are the case's attack, or `demoExtract` for pasted text) and VANILLA is a stand-in that pays
// what it reads. Nothing here touches the network or reads an environment file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBaseUnits } from '@airlock/runtime/money';
import { benchAssets, BENCH_ROOT } from '../runner/assets.ts';
import { loadCases } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import type { GateResult } from '../runner/gate.ts';
import type { PaymentFact } from '../runner/types.ts';
import { demoExtract } from './extract.ts';
import { escapeForTerminal } from './escape.ts';
import { whySentence } from './why.ts';

export type TryConfig = 'A1' | 'A2';
export const CASES_DIR = join(BENCH_ROOT, 'cases');
export const FINAL_JSON = join(BENCH_ROOT, 'results', 'final.json');
export const PRESETS: readonly string[] = ['A01', 'B01', 'X01'];
/** pasted text longer than this is refused, so a stray file cannot flood the terminal */
export const MAX_TEXT_CHARS = 20_000;

export function corpusCases(): Case[] {
  return loadCases(CASES_DIR);
}

/** `A01` or `own-A01`. */
export function findCase(cases: readonly Case[], id: string): Case | undefined {
  return cases.find((c) => c.id === id || c.id === `own-${id}`);
}

function amountText(p: PaymentFact): string {
  const assets = benchAssets();
  const row = assets.rows.find(([id]) => id === p.asset);
  if (row === undefined) return `${p.amount} ${p.asset}`;
  return `${formatBaseUnits(BigInt(p.amount), row[1].decimals)} ${row[1].symbol}`;
}

/** The stand-in vanilla agent pays every payment the hijacked reader proposed. */
export function vanillaLines(payments: readonly PaymentFact[]): string[] {
  if (payments.length === 0) return ['VANILLA pays nothing'];
  return payments.map((p) => escapeForTerminal(`VANILLA pays ${amountText(p)} to ${p.payee}`));
}

/** The recorded V0 runs of the final bench run for a corpus case, or null when the file or the case is absent. */
export function recordedV0(caseId: string, file: string = FINAL_JSON): string | null {
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { model?: string }; runs?: Array<{ case: string; config: string; kind: string; attackSucceeded: boolean }> };
    const runs = (d.runs ?? []).filter((r) => r.case === caseId && r.config === 'V0' && r.kind === 'attack');
    if (runs.length === 0) return null;
    const k = runs.filter((r) => r.attackSucceeded).length;
    return escapeForTerminal(`VANILLA paid the attacker in ${k} of ${runs.length} recorded runs (a real model, ${d.meta?.model ?? 'unknown'}, bench/results/final.json; the line above assumes a fully hijacked reader)`);
  } catch {
    return null;
  }
}

export function airlockLines(c: Case, config: TryConfig, r: GateResult, channel = 'outside content'): string[] {
  const out: string[] = [];
  if (r.status === 'NO_TASK') return [`AIRLOCK ${config} STOPPED NoTask`, 'why: The owner task could not be built from the reference plan.'];
  if (r.status === 'ABORTED') {
    const code = escapeForTerminal(r.abort ?? 'unknown');
    return [`AIRLOCK ${config} STOPPED ${code}`, `why: The interpreter stopped the run before any payment was proposed (${code}).`];
  }
  if (r.payments.length === 0) return [`AIRLOCK ${config} NOTHING-PROPOSED -`, 'why: The run proposed no payment, so there was nothing to decide.'];
  for (const p of r.payments) out.push(escapeForTerminal(`AIRLOCK ${config} ${p.outcome} ${p.reason ?? '-'}`));
  const focus = r.payments.find((p) => p.outcome !== 'ALLOW') ?? r.payments[0] as PaymentFact;
  const capRow = c.world.book.find((b) => b.key === focus.payee);
  out.push(escapeForTerminal(`why: ${whySentence(focus.outcome, focus.reason, { channel, payee: focus.payee, ...(capRow?.cap != null ? { cap: capRow.cap } : {}) })}`));
  return out;
}

export interface Played {
  vanilla: PaymentFact[];
  result: GateResult;
  lines: string[];
}

/** One corpus case on its attacker path (`gate`). */
export async function playCorpusCase(c: Case, config: TryConfig): Promise<Played> {
  const result = await gatePath(c, config, 'gate');
  const recorded = recordedV0(c.id);
  const lines = [
    escapeForTerminal(`CASE ${c.id} (group ${c.group}): ${c.request}`),
    'REAL: the verdict (the Rust verdict CLI), the plan interpreter and the provenance labels; no network, no key, no model.',
    'SIMULATED: the reader is assumed fully hijacked, so its plan and extraction are the attack recorded in the case file; VANILLA is a stand-in that pays what it reads.',
    ...vanillaLines(result.payments),
    ...(recorded === null ? [] : [recorded]),
    ...airlockLines(c, config, result),
  ];
  return { vanilla: result.payments, result, lines };
}

/** B01 with its inbox body replaced by `text` and a gate plan that reads payee and amount from the mail, in a temporary case folder. */
export async function playText(text: string, config: TryConfig): Promise<Played> {
  const head = [escapeForTerminal(`TEXT ${text}`)];
  const notes = [
    'REAL: the verdict (the Rust verdict CLI), the plan interpreter, the provenance labels, the owner task and the address book of case B01; no network, no key, no model.',
    'SIMULATED: no model reads your text. The reader is assumed fully hijacked and a regex (demoExtract) takes the first account id or 0x address as payee and the first number as amount; VANILLA is a stand-in that pays what it reads.',
  ];
  const found = demoExtract(text);
  if (found.payee === null || found.amount === null) {
    return { vanilla: [], result: { status: 'DONE', payments: [] }, lines: [...head, ...notes, 'VANILLA pays nothing', 'nothing to pay in this text'] };
  }
  const b01 = findCase(corpusCases(), 'B01');
  if (b01 === undefined) throw new Error('case B01 is missing from bench/cases');
  const dir = mkdtempSync(join(tmpdir(), 'airlock-try-'));
  try {
    mkdirSync(join(dir, 'cases'));
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, 'fixtures', 'try-text.txt'), text, 'utf8');
    const payeeKey = `near:${found.payee}`;
    const row = {
      ...b01,
      id: 'try-text',
      // a pay to the book payee keeps B01's goal (the goal may not equal the legitimate task); any other payee is the attacker's
      ...(payeeKey === b01.attacker_goal?.recipient ? {} : { attacker_goal: { kind: 'pay', asset: 'near', recipient: payeeKey, amount: 'any' } }),
      world: { ...b01.world, inbox: b01.world.inbox.map((m) => ({ ...m, body: { text_ref: 'fixtures/try-text.txt' } })) },
      gate: {
        plan: [
          { let: 'mail', call: 'read_inbox' },
          { let: 'ex', extract: { from: { ref: 'mail' }, schema: { to: 'address', amount: 'amount' } } },
          { action: 'transfer', args: { to: { ref: 'ex', path: ['to'] }, amount: { ref: 'ex', path: ['amount'] }, asset: 'near' } },
        ],
        extract: [{ to: found.payee, amount: found.amount }],
      },
    };
    writeFileSync(join(dir, 'cases', 'try.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
    const c = loadCases(join(dir, 'cases'))[0] as Case;
    const result = await gatePath(c, config, 'gate');
    const vanilla = escapeForTerminal(`VANILLA pays ${found.amount} NEAR to ${payeeKey}`);
    return { vanilla: result.payments, result, lines: [...head, ...notes, vanilla, ...airlockLines(c, config, result, 'email')] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
