// AIR-300: the autopilot driver. It plays the fixed stream of bench/autopilot/stream.json through the real verdict CLI (the contract's own
// verdict and ledger functions, AIR-023 and AIR-034), one request at a time. An Allow is a payment made by itself, a Block a payment refused
// by itself, an Escalate a question to the owner. The simulated owner is fixed in advance: for a legitimate request he approves, and for a
// payee outside the book he also remembers it (the rules of AIR-299 approve_and_remember: per-payment cap 2 times the amount but never above
// the asset hard cap, daily limit 4 times the amount but never below the cap, untrusted-amount budget 0, label from the payee key); for an
// attack he rejects. The CLI has no command that adds a book entry, so a remember is a `reset` with the larger book followed by a replay of
// the day's charging steps (every Allow and every approval so far, in order) to restore the ledgers; the replay must reproduce the same verdicts.
// No LLM, no key, no chain. Output: a table per day, the AUTOPILOT line and bench/results/autopilot.json (the --no-remember twin is not written).
//   usage: tsx scripts/autopilot.ts [--no-remember] [--stream <file>] [--out <file>]
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOPILOT_DAY0, MS_PER_DAY, REPO_ROOT, streamSha256 } from './gen-autopilot-stream.ts';
import type { Stream, StreamItem } from './gen-autopilot-stream.ts';

// ---- the CLI process: one JSON line in, one JSON line out ----
export class VerdictCli {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiting: ((line: string) => void) | undefined;
  private lines: string[] = [];
  private dead: Error | undefined;

  constructor(path: string) {
    this.child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        const w = this.waiting;
        if (w !== undefined) {
          this.waiting = undefined;
          w(line);
        } else this.lines.push(line);
      }
    });
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code) => this.fail(new Error(`verdict_cli exited with code ${String(code)}`)));
  }

  private fail(e: Error): void {
    this.dead ??= e;
  }

  async call(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.dead !== undefined) throw this.dead;
    const line = await new Promise<string>((resolveLine, reject) => {
      const queued = this.lines.shift();
      if (queued !== undefined) return resolveLine(queued);
      const timer = setTimeout(() => reject(new Error('verdict_cli gave no reply within 10 s')), 10_000);
      this.waiting = (l) => {
        clearTimeout(timer);
        resolveLine(l);
      };
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
      return undefined;
    });
    const reply = JSON.parse(line) as Record<string, unknown>;
    return reply;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** `$VERDICT_CLI`, else the release example of this worktree's cargo target dir, built first when missing (as the bench does). */
export function ensureVerdictCli(): string {
  const target = process.env['CARGO_TARGET_DIR'] ?? join(homedir(), '.cache', 'airlock-target');
  const path = process.env['VERDICT_CLI'] ?? join(target, 'release', 'examples', 'verdict_cli');
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    if (process.env['VERDICT_CLI'] !== undefined) throw new Error('VERDICT_CLI does not name an executable file');
  }
  execFileSync('cargo', ['build', '-q', '--release', '--example', 'verdict_cli'], {
    cwd: join(REPO_ROOT, 'contracts', 'airlock-verdict'),
    env: { ...process.env, CARGO_TARGET_DIR: target },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  accessSync(path, constants.X_OK);
  return path;
}

// ---- the run ----
export interface DayRow {
  day: number;
  total: number;
  paid: number;
  blocked: number;
  asked: number;
  /** asks about a legitimate item (the owner approves) and asks about an attack (the owner rejects); they add up to `asked` */
  legit_asked: number;
  attack_asked: number;
  approved: number;
  rejected: number;
  remembered: number;
  attacks: number;
  attacks_paid: number;
}

export interface RunResult {
  mode: 'remember' | 'no-remember';
  days: DayRow[];
  paid: number;
  blocked: number;
  asked: number;
  attacks_paid: number;
  legit_asked: number;
  attack_asked: number;
  ask_rate_day1: string;
  ask_rate_day7: string;
  /** every asked legitimate item the owner approved, and every asked attack he rejected */
  approved: number;
  rejected: number;
  remembered: number;
}

type Book = Record<string, { cap: string | null; daily_untrusted_budget: string; daily_limit: string }>;

const rate = (asked: number, total: number): string => (total === 0 ? '0.00' : (Math.round((asked * 10000) / total) / 100).toFixed(2));

function nowMs(stream: Stream, item: StreamItem): number {
  const [h, m] = item.time.split(':');
  return (stream.day0 + item.day - 1) * MS_PER_DAY + (Number(h) * 60 + Number(m)) * 60_000;
}

function tasksOf(stream: Stream): Record<string, { bounds: Record<string, string> }> {
  const tasks: Record<string, { bounds: Record<string, string> }> = {};
  for (const item of stream.items) tasks[item.task_id] = { bounds: item.bounds };
  return tasks;
}

/** The book entry the owner's remember tap writes (AIR-299 rules), or null when the request cannot be remembered. */
export function rememberEntry(stream: Stream, item: StreamItem): Book[string] | null {
  const asset = stream.setup.assets[item.request.asset];
  if (asset === undefined) return null;
  const amount = BigInt(item.request.amount);
  const hard = BigInt(asset.hard_cap);
  if (amount > hard) return null;
  const twice = amount * 2n;
  const cap = twice > hard ? hard : twice;
  const four = amount * 4n;
  const daily = four < cap ? cap : four;
  return { cap: cap.toString(), daily_untrusted_budget: '0', daily_limit: daily.toString() };
}

/** Plays `stream` through the CLI at `cliPath` and returns the counts per day. */
export async function runStream(stream: Stream, cliPath: string, options: { remember: boolean }): Promise<RunResult> {
  const cli = new VerdictCli(cliPath);
  const book: Book = structuredClone(stream.setup.book);
  const tasks = tasksOf(stream);
  const mustOk = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await cli.call(command);
    if (reply['ok'] !== true) throw new Error(`verdict_cli refused ${String(command['cmd'])}: ${String(reply['error'])}`);
    return reply;
  };
  const reset = (): Promise<Record<string, unknown>> => mustOk({ cmd: 'reset', setup: { assets: stream.setup.assets, book, tasks, flags: { paused: false } } });
  const submit = async (item: StreamItem): Promise<string> => {
    const reply = await mustOk({ cmd: 'submit', now_ms: nowMs(stream, item), task_id: item.task_id, requests: [item.request] });
    const outcomes = reply['outcomes'] as { tag: string }[];
    return outcomes[0]?.tag ?? 'missing';
  };
  const approve = (item: StreamItem): Promise<Record<string, unknown>> => cli.call({ cmd: 'approve', now_ms: nowMs(stream, item), task_id: item.task_id, request: item.request });

  const rows = new Map<number, DayRow>();
  const row = (day: number): DayRow => {
    let r = rows.get(day);
    if (r === undefined) {
      r = { day, total: 0, paid: 0, blocked: 0, asked: 0, legit_asked: 0, attack_asked: 0, approved: 0, rejected: 0, remembered: 0, attacks: 0, attacks_paid: 0 };
      rows.set(day, r);
    }
    return r;
  };
  // the charging steps of the day so far, in order: replayed after a reset so the ledgers match what the contract would hold
  let dayLog: { item: StreamItem; step: 'allow' | 'approve' }[] = [];
  let logDay = 0;

  try {
    await reset();
    for (const item of stream.items) {
      if (item.day !== logDay) {
        logDay = item.day;
        dayLog = [];
      }
      const r = row(item.day);
      r.total += 1;
      const attack = item.kind === 'attack';
      if (attack) r.attacks += 1;
      const tag = await submit(item);
      if (tag === 'allow') {
        r.paid += 1;
        if (attack) r.attacks_paid += 1;
        dayLog.push({ item, step: 'allow' });
      } else if (tag.startsWith('block:')) {
        r.blocked += 1;
      } else if (tag.startsWith('escalate:')) {
        r.asked += 1;
        if (attack) r.attack_asked += 1;
        else r.legit_asked += 1;
        if (attack) {
          r.rejected += 1; // the owner rejects: nothing is charged and nothing is paid
          continue;
        }
        const reply = await approve(item);
        if (reply['ok'] !== true) throw new Error(`the owner's approval of ${item.task_id} was refused: ${String(reply['error'])}`);
        r.approved += 1;
        dayLog.push({ item, step: 'approve' });
        const entry = options.remember && book[item.request.payee] === undefined ? rememberEntry(stream, item) : null;
        if (entry !== null) {
          book[item.request.payee] = entry;
          r.remembered += 1;
          await reset();
          for (const logged of dayLog) {
            if (logged.step === 'allow') {
              const again = await submit(logged.item);
              if (again !== 'allow') throw new Error(`replay of ${logged.item.task_id} answered ${again}, not allow`);
            } else {
              const again = await approve(logged.item);
              if (again['ok'] !== true) throw new Error(`replay of the approval of ${logged.item.task_id} was refused: ${String(again['error'])}`);
            }
          }
        }
      } else {
        throw new Error(`unreadable verdict tag: ${tag}`);
      }
    }
  } finally {
    cli.close();
  }

  const days = [...rows.values()].sort((a, b) => a.day - b.day);
  const sum = (f: (d: DayRow) => number): number => days.reduce((n, d) => n + f(d), 0);
  const first = days[0];
  const last = days[days.length - 1];
  return {
    mode: options.remember ? 'remember' : 'no-remember',
    days,
    paid: sum((d) => d.paid),
    blocked: sum((d) => d.blocked),
    asked: sum((d) => d.asked),
    attacks_paid: sum((d) => d.attacks_paid),
    legit_asked: sum((d) => d.legit_asked),
    attack_asked: sum((d) => d.attack_asked),
    ask_rate_day1: first === undefined ? '0.00' : rate(first.asked, first.total),
    ask_rate_day7: last === undefined ? '0.00' : rate(last.asked, last.total),
    approved: sum((d) => d.approved),
    rejected: sum((d) => d.rejected),
    remembered: sum((d) => d.remembered),
  };
}

export function summaryLine(r: RunResult): string {
  return `AUTOPILOT paid=${r.paid} blocked=${r.blocked} asked=${r.asked} attacks_paid=${r.attacks_paid} ask_rate_day1=${r.ask_rate_day1} ask_rate_day7=${r.ask_rate_day7} legit_asked=${r.legit_asked} attack_asked=${r.attack_asked} mode=${r.mode}`;
}

export function dayTable(r: RunResult): string {
  const widths = [3, 5, 4, 7, 11, 12, 12, 10];
  const lines = ['day total paid blocked legit_asked attack_asked attacks_paid remembered'];
  for (const d of r.days) {
    const cells = [d.day, d.total, d.paid, d.blocked, d.legit_asked, d.attack_asked, d.attacks_paid, d.remembered];
    lines.push(cells.map((n, i) => String(n).padStart(widths[i] ?? 4)).join(' '));
  }
  return lines.join('\n');
}

async function main(argv: string[]): Promise<void> {
  let remember = true;
  let streamFile = join(REPO_ROOT, 'bench', 'autopilot', 'stream.json');
  let out = join(REPO_ROOT, 'bench', 'results', 'autopilot.json');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-remember') remember = false;
    else if (argv[i] === '--stream') streamFile = resolve(argv[(i += 1)] ?? streamFile);
    else if (argv[i] === '--out') out = resolve(argv[(i += 1)] ?? out);
  }
  const stream = JSON.parse(readFileSync(streamFile, 'utf8')) as Stream;
  if (stream.day0 !== AUTOPILOT_DAY0) throw new Error('the stream starts on another day than the bench T0');
  const cliPath = ensureVerdictCli();
  const main_ = await runStream(stream, cliPath, { remember });
  console.log(dayTable(main_));
  console.log(summaryLine(main_));
  if (!remember) return;
  const twin = await runStream(stream, cliPath, { remember: false });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ seed: stream.seed, stream_sha256: streamSha256(stream), items: stream.items.length, ...main_, no_remember: twin }, null, 1)}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
