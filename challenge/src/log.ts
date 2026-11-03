// The attempt log: one JSON line per attempt, appended and never rewritten, plus the scoreboard folded from it. The log is the single source
// of the board: restarting the service reads the file again and shows the same numbers. A line that does not parse is counted and skipped
// (a crash can leave a partial last line), and a line that parses but fails the schema is skipped the same way. Subscribers get every new
// attempt, which is what the live stream of the page is.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AttemptSchema, EMPTY_BOARD } from './types.ts';
import type { Attempt, Scoreboard } from './types.ts';

const KEEP = 500;

function fold(board: Scoreboard, a: Attempt): Scoreboard {
  const held = a.payments.filter((p) => p.outcome === 'ESCALATE').reduce((sum, p) => sum + BigInt(p.amount), 0n);
  return {
    attempts: board.attempts + 1,
    allow: board.allow + (a.verdict === 'Allow' ? 1 : 0),
    escalate: board.escalate + (a.verdict === 'Escalate' ? 1 : 0),
    block: board.block + (a.verdict === 'Block' ? 1 : 0),
    noAction: board.noAction + (a.verdict === 'NoAction' ? 1 : 0),
    doors: { ...board.doors, [a.door]: board.doors[a.door] + 1 },
    stolenYocto: (BigInt(board.stolenYocto) + BigInt(a.stolenYocto)).toString(),
    paidToBookYocto: (BigInt(board.paidToBookYocto) + BigInt(a.paidToBookYocto)).toString(),
    heldYocto: (BigInt(board.heldYocto) + held).toString(),
    firstAt: board.firstAt ?? a.at,
    lastAt: a.at,
  };
}

export class AttemptLog {
  private recent: Attempt[] = [];
  private board: Scoreboard = { ...EMPTY_BOARD, doors: { ...EMPTY_BOARD.doors } };
  private seq = 0;
  private readonly keySources = new Set<string>();
  private readonly subscribers = new Set<(a: Attempt) => void>();
  /** lines of the file that were skipped at load */
  skipped = 0;
  /** attempts that are on the board but could not be written to the file (disk full, permissions); the state route shows it */
  writeFailures = 0;

  /** `path` null keeps the log in memory only (tests and the selftest). */
  constructor(private readonly path: string | null) {
    if (path !== null && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line === '') continue;
        const a = this.parse(line);
        if (a === null) this.skipped += 1;
        else this.take(a);
      }
    }
  }

  private parse(line: string): Attempt | null {
    try {
      const parsed = AttemptSchema.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private take(a: Attempt): void {
    this.board = fold(this.board, a);
    this.seq = Math.max(this.seq, a.seq);
    if (a.door === 'key') this.keySources.add(a.source);
    this.recent.push(a);
    if (this.recent.length > KEEP) this.recent.shift();
  }

  /** The seq the next attempt gets. */
  nextSeq(): number {
    return this.seq + 1;
  }

  /**
   * Appends one attempt (the file first, then memory) and tells the subscribers. A record that fails the schema throws before anything changes.
   * A file that cannot be written does not drop the attempt from the board (money that moved must show): it is counted in `writeFailures`.
   */
  append(a: Attempt): void {
    const checked = AttemptSchema.parse(a);
    if (checked.seq !== this.seq + 1) throw new RangeError('attempt seq is not the next one');
    if (this.path !== null) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(checked)}\n`, 'utf8');
      } catch {
        this.writeFailures += 1;
      }
    }
    this.take(checked);
    for (const s of this.subscribers) {
      try {
        s(checked);
      } catch {
        this.subscribers.delete(s);
      }
    }
  }

  /** True when an attempt of the published key with this source (`key:<request id>`) is in the log, however old: the watcher's dedupe survives a restart. */
  hasKeySource(source: string): boolean {
    return this.keySources.has(source);
  }

  scoreboard(): Scoreboard {
    return { ...this.board, doors: { ...this.board.doors } };
  }

  /** Newest first. `before` is a seq: only attempts with a lower seq. */
  latest(limit: number, before?: number): Attempt[] {
    const rows = before === undefined ? this.recent : this.recent.filter((a) => a.seq < before);
    return rows.slice(-limit).reverse();
  }

  subscribe(cb: (a: Attempt) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  get size(): number {
    return this.board.attempts;
  }
}
