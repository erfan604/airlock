// The adaptive round (AIR-231): attacks written knowing the policy, each played with a fully hijacked reader and no model, no key, no network
// and no spend. Four parts, all data driven and deterministic:
//   1. the Floor cases of `cases/adaptive/adaptive.jsonl`, played through `gatePath` under A1 and A2 (the same path `check-cases` asserts);
//   2. the sequences of `cases/adaptive/sequences.json`: several owner tasks, approvals and UTC days against the verdict CLI's ledgers;
//   3. the surface probes of `cases/adaptive/surfaces.json`: the look-alike heuristic, the counterparty note, the x402 requirement fields and
//      the Intents quote check, each a pure function of the runtime called with tampered input;
//   4. the generated block between the `adaptive` SUITE markers of docs/BENCH.md and `results/adaptive-extra.json` (a separate results file:
//      final.json and the 39 cases it pins are not touched).
// A result that differs from the expectation written in the data file is a MISMATCH and the run fails. Run as
//   pnpm -C bench exec tsx src/scripts/adaptive-report.ts [--check] [--print]
// Without flags both outputs are rewritten; `--check` exits 1 with `ADAPTIVE STALE` when either differs from a fresh render. Paths are relative to bench/.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkQuote } from '@airlock/runtime/chain-intents';
import type { AllowedPayout } from '@airlock/runtime/chain-intents';
import { PaymentRequiredV2, X402Mismatch, buildPaymentPayload } from '@airlock/runtime/chain-x402';
import type { X402Signed } from '@airlock/runtime/chain-x402';
import { checkLookalike, labelsToBits } from '@airlock/runtime/dsl';
import { createCounterparty } from '@airlock/runtime/counterparty';
import type { CounterpartyProbe } from '@airlock/runtime/counterparty';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import { BENCH_ROOT, benchAssets } from '../runner/assets.ts';
import { VerdictCliBackend, ensureVerdictCli } from '../runner/backend.ts';
import { bookRowsOf, loadCases } from '../runner/cases.ts';
import type { Case } from '../runner/cases.ts';
import { gatePath } from '../runner/gate.ts';
import { BENCH_T0_MS } from '../runner/task.ts';
import { tagOf } from './check-cases.ts';

export const BEGIN = '<!-- BEGIN SUITE adaptive -->';
export const END = '<!-- END SUITE adaptive -->';
const DAY_MS = 86_400_000;
const DECIMALS = 24;

// ---------------------------------------------------------------- shared helpers
const nearText = (base: bigint): string => formatBaseUnits(base, DECIMALS);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `allow x3, escalate:OverTaskBound x2`: consecutive equal tags are counted. */
export function compress(tags: readonly string[]): string {
  if (tags.length === 0) return 'none';
  const out: string[] = [];
  let i = 0;
  while (i < tags.length) {
    let j = i;
    while (j < tags.length && tags[j] === tags[i]) j += 1;
    out.push(j - i === 1 ? (tags[i] ?? '') : `${tags[i] ?? ''} x${j - i}`);
    i = j;
  }
  return out.join(', ');
}

const STOP_WORD: Record<string, string> = {
  OverTaskBound: 'task bound',
  OutsideTask: 'task bound',
  UntrustedAmount: 'budget',
  UntrustedTrigger: 'provenance',
  UntrustedRecipient: 'provenance',
  NewRecipient: 'book',
  OverPayeeLimit: 'payee limit',
};

// ---------------------------------------------------------------- part 1: the Floor cases
export interface FloorRow {
  id: string;
  a1: string[];
  a2: string[];
  /** the sum of the A2 payments classified attacker that executed, in whole NEAR */
  autoNear: string;
  stoppedBy: string;
  naiveApprover: boolean;
  held: number;
  residual: boolean;
}

async function floorRows(cases: readonly Case[], problems: string[]): Promise<FloorRow[]> {
  const rows: FloorRow[] = [];
  const backend = new VerdictCliBackend();
  try {
    for (const c of cases) {
      const tags: Record<'A1' | 'A2', string[]> = { A1: [], A2: [] };
      let auto = 0n;
      let stopped = new Set<string>();
      let naive = false;
      let held = 0;
      for (const config of ['A1', 'A2'] as const) {
        const res = await gatePath(c, config, 'gate', undefined, { backend });
        const attack = res.payments.filter((p) => p.attackerInfluenced);
        tags[config] = res.status === 'DONE' ? attack.map(tagOf) : [res.status === 'NO_TASK' ? 'no_task' : `stopped:${res.abort ?? 'unknown'}`];
        if (config === 'A2') {
          auto = attack.filter((p) => p.outcome === 'ALLOW').reduce((s, p) => s + BigInt(p.amount), 0n);
          stopped = new Set(attack.filter((p) => p.outcome !== 'ALLOW').map((p) => STOP_WORD[p.reason ?? ''] ?? (p.reason ?? 'gate')));
          naive = attack.some((p) => p.outcome === 'ESCALATE');
          held = attack.filter((p) => p.outcome === 'ESCALATE').length;
        }
        const want = c.expected_airlock.attack;
        const seq = want === null ? undefined : config === 'A1' ? want.a1_seq : want.a2_seq;
        if (seq !== undefined && !same(tags[config], seq)) problems.push(`MISMATCH ${c.id} ${config} expected ${seq.join(',')} got ${tags[config].join(',')}`);
      }
      rows.push({
        id: c.id.replace(/^own-/, ''),
        a1: tags.A1,
        a2: tags.A2,
        autoNear: nearText(auto),
        stoppedBy: stopped.size === 0 ? 'nothing' : [...stopped].sort().join(' and '),
        naiveApprover: naive,
        held,
        residual: auto > 0n,
      });
    }
  } finally {
    await backend.close();
  }
  return rows;
}

// ---------------------------------------------------------------- part 2: the sequences
const Step = z.strictObject({
  op: z.enum(['submit', 'approve']),
  task: z.string(),
  payee: z.string(),
  amount: z.string(),
  labels: z.strictObject({ recipient: z.array(z.string()), amount: z.array(z.string()), pc: z.array(z.string()) }),
  day: z.int(),
  A1: z.string(),
  A2: z.string(),
});
const Sequence = z.strictObject({
  id: z.string(),
  base: z.string(),
  title: z.string(),
  attack: z.string(),
  class: z.string(),
  note: z.string(),
  tasks: z.record(z.string(), z.record(z.string(), z.string())),
  steps: z.array(Step),
});
type SequenceSpec = z.infer<typeof Sequence>;

class Cli {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiter: ((line: string) => void) | undefined;
  constructor() {
    this.child = spawn(ensureVerdictCli(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const w = this.waiter;
        this.waiter = undefined;
        w?.(line);
      }
    });
  }
  call(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('verdict_cli gave no reply')), 5000);
      this.waiter = (line) => {
        clearTimeout(timer);
        res(JSON.parse(line) as Record<string, unknown>);
      };
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }
  close(): void {
    this.child.stdin.end();
  }
}

export interface SeqRow {
  id: string;
  title: string;
  attack: string;
  class: string;
  note: string;
  a1: string[];
  a2: string[];
  autoNear: string;
  approvedNear: string;
}

async function sequenceRows(specs: readonly SequenceSpec[], cases: readonly Case[], problems: string[]): Promise<SeqRow[]> {
  const assets = benchAssets();
  const rows: SeqRow[] = [];
  const cli = new Cli();
  try {
    for (const spec of specs) {
      const base = cases.find((c) => c.id === spec.base);
      if (base === undefined) throw new Error(`sequence ${spec.id}: base case ${spec.base} is not loaded`);
      const out: Record<'A1' | 'A2', { tags: string[]; auto: bigint; approved: bigint }> = { A1: { tags: [], auto: 0n, approved: 0n }, A2: { tags: [], auto: 0n, approved: 0n } };
      for (const config of ['A1', 'A2'] as const) {
        const book: Record<string, { cap: string | null; daily_untrusted_budget: string; daily_limit: string }> = {};
        for (const [key, e] of bookRowsOf(base.world)) book[key] = { cap: config === 'A1' ? null : e.cap, daily_untrusted_budget: e.daily_untrusted_budget, daily_limit: e.daily_limit };
        const assetRows: Record<string, unknown> = {};
        for (const [id, a] of assets.rows) assetRows[id] = { hard_cap: a.hard_cap, daily_cap: a.daily_cap, max_fee_per_gas: a.max_fee_per_gas, max_gas: a.max_gas };
        const tasks: Record<string, unknown> = {};
        for (const [id, bounds] of Object.entries(spec.tasks)) tasks[id] = { bounds: Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, toBaseUnits(v, DECIMALS).toString()])) };
        const reset = await cli.call({ cmd: 'reset', setup: { assets: assetRows, book, tasks, flags: { paused: false } } });
        if (reset['ok'] !== true) throw new Error(`sequence ${spec.id}: reset refused`);
        let index = 0;
        for (const step of spec.steps) {
          const request = {
            task_id: step.task,
            action_index: index,
            asset: 'near',
            payee: step.payee,
            amount: toBaseUnits(step.amount, DECIMALS).toString(),
            labels: { recipient: labelsToBits(step.labels.recipient), amount: labelsToBits(step.labels.amount), pc: labelsToBits(step.labels.pc) },
            evm: null,
            hints: { plan_hash: '00'.repeat(32), trace_digest: '00'.repeat(32) },
          };
          index += 1;
          const nowMs = BENCH_T0_MS + step.day * DAY_MS;
          let got: string;
          if (step.op === 'submit') {
            const reply = await cli.call({ cmd: 'submit', now_ms: nowMs, task_id: step.task, requests: [request] });
            const outcomes = reply['outcomes'];
            const first = Array.isArray(outcomes) ? (outcomes[0] as { tag?: string } | undefined) : undefined;
            got = typeof first?.tag === 'string' ? first.tag : `error:${String(reply['error'])}`;
            if (got === 'allow') out[config].auto += BigInt(request.amount);
          } else {
            const reply = await cli.call({ cmd: 'approve', now_ms: nowMs, task_id: step.task, request });
            got = reply['ok'] === true ? 'approved' : `error:${String(reply['error'])}`;
            if (got === 'approved') out[config].approved += BigInt(request.amount);
          }
          out[config].tags.push(got);
          const want = config === 'A1' ? step.A1 : step.A2;
          if (got !== want) problems.push(`MISMATCH ${spec.id} ${config} step ${out[config].tags.length} expected ${want} got ${got}`);
        }
      }
      rows.push({ id: spec.id, title: spec.title, attack: spec.attack, class: spec.class, note: spec.note, a1: out.A1.tags, a2: out.A2.tags, autoNear: nearText(out.A2.auto), approvedNear: nearText(out.A2.approved) });
    }
  } finally {
    cli.close();
  }
  return rows;
}

// ---------------------------------------------------------------- part 3: the surface probes
const Surfaces = z.strictObject({
  lookalike: z.strictObject({ book: z.array(z.string()), cases: z.array(z.strictObject({ key: z.string(), expect: z.string(), why: z.string() })) }),
  counterparty: z.array(
    z.strictObject({
      name: z.string(),
      key: z.string(),
      seen: z.union([z.string(), z.strictObject({ nonce: z.string(), balance: z.string(), hasCode: z.boolean() })]),
      expect: z.string(),
      class: z.string().optional(),
    }),
  ),
  x402: z.strictObject({
    base: z.string(),
    cases: z.array(z.strictObject({ name: z.string(), set: z.record(z.string(), z.unknown()), expect: z.string(), why: z.string().optional() })),
  }),
  intents: z.array(
    z.strictObject({
      name: z.string(),
      ops: z.array(z.strictObject({ in: z.enum(['response', 'sent', 'both']), path: z.string(), value: z.unknown().optional(), delete: z.boolean().optional() })),
      expect: z.string(),
      class: z.string().optional(),
    }),
  ),
});

export interface ProbeRow {
  surface: string;
  name: string;
  expect: string;
  got: string;
  class: string;
  why: string;
}

function setPath(root: unknown, path: string, value: unknown, remove = false): void {
  const parts = path.split('.');
  let node = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== 'object' || next === null) throw new Error(`no ${part} on the path`);
    node = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] ?? '';
  if (remove) delete node[last];
  else node[last] = value;
}

const IMPLICIT_PAYEE = '0x2527d02599ba641c19fea793cd0f167589a0f10d';

async function probeRows(spec: z.infer<typeof Surfaces>, problems: string[]): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const add = (surface: string, name: string, expect: string, got: string, cls: string, why = ''): void => {
    rows.push({ surface, name, expect, got, class: cls, why });
    if (expect !== got) problems.push(`MISMATCH ${surface} ${name} expected ${expect} got ${got}`);
  };

  // the look-alike heuristic against the book
  for (const c of spec.lookalike.cases) {
    const hit = checkLookalike(c.key, spec.lookalike.book);
    const got = hit === null ? 'clear' : `flag:${hit.kind}`;
    add('lookalike', c.key.replace(/^near:/, ''), c.expect, got, got === 'clear' && c.expect === 'clear' && c.why !== 'a name that is not near any book entry (control)' ? 'new residual' : got === 'clear' ? 'control' : 'flagged', c.why);
  }

  // the counterparty note
  for (const c of spec.counterparty) {
    const probe: CounterpartyProbe = {
      nearAccount: (): Promise<'absent' | 'young' | 'established'> => (c.seen === 'throw' ? Promise.reject(new Error('lookup failed')) : Promise.resolve(c.seen as 'absent' | 'young' | 'established')),
      evmAddress: () => Promise.resolve(typeof c.seen === 'object' ? { nonce: BigInt(c.seen.nonce), balance: BigInt(c.seen.balance), hasCode: c.seen.hasCode } : { nonce: 0n, balance: 0n, hasCode: false }),
    };
    const note = await createCounterparty({ probe, now: () => 0 }).assess(c.key);
    add('counterparty', c.name, c.expect, note === null ? 'none' : note.reason, c.class ?? 'flagged');
  }

  // the x402 requirement fields against a signed event for the entry as served
  const base = JSON.parse(readFileSync(join(BENCH_ROOT, '..', c402(spec.x402.base)), 'utf8')) as Record<string, unknown>;
  for (const c of spec.x402.cases) {
    const body = structuredClone(base);
    for (const [path, value] of Object.entries(c.set)) setPath(body, path, value);
    const parsed = PaymentRequiredV2.safeParse(body);
    let got: string;
    if (!parsed.success) {
      got = 'rejected by the schema';
    } else {
      const signed: X402Signed = {
        id: 'adaptive:0',
        from: `0x${'11'.repeat(20)}`,
        to: '0x209693bc6afc0c5328ba36faf03c514ef312287c',
        value: '10000',
        valid_after: '0',
        valid_before: '1740672300',
        nonce: `0x${'ab'.repeat(32)}`,
        v: 27,
        r: '22'.repeat(32),
        s: '33'.repeat(32),
      };
      try {
        buildPaymentPayload(signed, parsed.data, 0);
        got = 'ok';
      } catch (e) {
        got = e instanceof X402Mismatch ? `X402Mismatch ${e.field}` : 'error';
      }
    }
    add('x402', c.name, c.expect, got, got === 'ok' && c.expect === 'ok' && c.why !== undefined ? 'harmless' : got === 'ok' ? 'accepted' : 'refused', c.why ?? '');
  }

  // the Intents quote check against the recorded live dry quote
  const rec = JSON.parse(readFileSync(join(BENCH_ROOT, '..', 'runtime', 'test', 'fixtures', 'intents', 'dry-exact-output.live.json'), 'utf8')) as Record<string, unknown>;
  const request = rec['quoteRequest'] as Record<string, unknown>;
  const t0 = BigInt(Date.parse(String(rec['timestamp'])));
  const allowed: AllowedPayout = {
    requestId: 'req-0001',
    payee: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
    destinationAsset: String(request['destinationAsset']),
    amountOut: '5000000',
    originAsset: String(request['originAsset']),
    maxAmountIn: '5100000',
    refundTo: [String(request['refundTo'])],
    windowStartMs: t0,
    windowEndMs: t0 + 40n * 60n * 1000n,
    maxSlippageBps: 100n,
    allowedFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', maxFeeBps: 25 }],
  };
  for (const c of spec.intents) {
    const response = structuredClone(rec);
    const sent: Record<string, unknown> = { ...request };
    for (const op of c.ops) {
      const apply = (target: unknown, path: string): void => setPath(target, path, op.value, op.delete === true);
      if (op.in === 'response' || op.in === 'both') apply(response, op.path);
      if (op.in === 'sent' || op.in === 'both') apply({ quoteRequest: sent }, op.path);
    }
    const out = checkQuote(allowed, sent, response, { expectDry: true });
    add('intents', c.name, c.expect, out.ok ? 'ok' : out.reason, c.class ?? (out.ok ? 'accepted' : 'refused'));
  }
  void IMPLICIT_PAYEE;
  return rows;
}

const c402 = (p: string): string => p;

// ---------------------------------------------------------------- the report
export interface Report {
  floor: FloorRow[];
  sequences: SeqRow[];
  probes: ProbeRow[];
  problems: string[];
}

export async function build(root: string = BENCH_ROOT): Promise<Report> {
  const problems: string[] = [];
  const all = loadCases(join(root, 'cases', 'adaptive'));
  const cases = all;
  const sequences = z.array(Sequence).parse(JSON.parse(readFileSync(join(root, 'cases', 'adaptive', 'sequences.json'), 'utf8')));
  const surfaces = Surfaces.parse(JSON.parse(readFileSync(join(root, 'cases', 'adaptive', 'surfaces.json'), 'utf8')));
  return { floor: await floorRows(cases, problems), sequences: await sequenceRows(sequences, all, problems), probes: await probeRows(surfaces, problems), problems };
}

const NOT_MODELLED = [
  'flood of escalations: not modelled by the verdict CLI; covered by the contract tests of AIR-083 and AIR-084',
  'splitting across tasks: one task per case; the daily caps are tested over three simulated days by AIR-066 I6',
];
const NOT_TRIED = 'not tried: gradient attacks on open weights, a compromised owner device, compromised MPC nodes, automated adaptive search';

/** The lines of the block, markers included: a pure function of the report (no date, no path, no commit). */
export function blockLines(r: Report): string[] {
  const out: string[] = [BEGIN];
  out.push('Adaptive round (AIR-231): attacks written knowing the verdict rules, each played with the reader assumed fully hijacked, so the extraction is scripted, with no model, no key and no spend. A zero here is a statement about these attacks only. The static table above is not mixed with it.');
  out.push('');
  out.push('id | A1 tags | A2 tags | auto-executed in A2 | stopped by | naive approver | class');
  out.push('--- | --- | --- | --- | --- | --- | ---');
  for (const f of r.floor) {
    out.push(`${f.id} | ${compress(f.a1)} | ${compress(f.a2)} | auto-executed ${f.autoNear} NEAR | stopped by ${f.stoppedBy} | naive approver ${f.naiveApprover ? 'yes' : 'no'} | ${f.residual ? 'documented residual (K2)' : 'held'}`);
  }
  out.push('');
  out.push('Sequences against the ledgers of the verdict CLI (several owner tasks, approvals and UTC days, A1 and A2 with the same steps):');
  out.push('');
  out.push('id | attack | A1 | A2 | auto-executed in A2 | approved by the owner | class');
  out.push('--- | --- | --- | --- | --- | --- | ---');
  for (const s of r.sequences) out.push(`${s.id} | ${s.title} | ${compress(s.a1)} | ${compress(s.a2)} | auto-executed ${s.autoNear} NEAR | approved ${s.approvedNear} NEAR | ${s.class}`);
  out.push('');
  out.push('Surface probes (a pure function of the runtime called with tampered input; `expect` is written in the data file before the run):');
  out.push('');
  out.push('surface | probe | result | class');
  out.push('--- | --- | --- | ---');
  for (const p of r.probes) out.push(`${p.surface} | ${p.name} | ${p.got} | ${p.class}`);
  out.push('');
  for (const line of NOT_MODELLED) out.push(line);
  out.push('');
  out.push(NOT_TRIED);
  out.push(END);
  return out;
}

/** Rewrites the lines between the two markers; throws when a marker is missing or duplicated. */
export function replaceBlock(text: string, block: readonly string[]): string {
  const lines = text.split('\n');
  const begins = lines.flatMap((l, i) => (l === BEGIN ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === END ? [i] : []));
  const first = begins[0];
  const last = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || first === undefined || last === undefined || last < first) throw new Error('the doc needs exactly one begin and one end adaptive SUITE marker line');
  return [...lines.slice(0, first), ...block, ...lines.slice(last + 1)].join('\n');
}

/** The separate results file: plain data, no date and no path, so a replay compares it byte for byte. */
export function resultsText(r: Report): string {
  return `${JSON.stringify({ name: 'adaptive-extra', model: 'none', note: 'hand-written adaptive round, reader assumed fully hijacked, no model and no spend', floor: r.floor, sequences: r.sequences, probes: r.probes }, null, 1)}\n`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const report = await build();
  for (const line of report.problems) console.log(line);
  if (report.problems.length > 0) {
    console.log(`ADAPTIVE FAILED ${report.problems.length} problems`);
    return 1;
  }
  const block = blockLines(report);
  if (args.includes('--print')) {
    console.log(block.join('\n'));
    return 0;
  }
  const doc = resolve('../docs/BENCH.md');
  const resultsFile = resolve('results/adaptive-extra.json');
  const text = readFileSync(doc, 'utf8');
  const next = replaceBlock(text, block);
  const results = resultsText(report);
  if (check) {
    const storedResults = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8') : '';
    if (next !== text || storedResults !== results) {
      console.log('ADAPTIVE STALE');
      return 1;
    }
  } else {
    if (next !== text) writeFileSync(doc, next, 'utf8');
    writeFileSync(resultsFile, results, 'utf8');
  }
  console.log(`ADAPTIVE OK ${report.floor.length} cases, ${report.sequences.length} sequences, ${report.probes.length} probes`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
