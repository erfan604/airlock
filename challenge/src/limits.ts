// Admission control: every cap of the challenge sits here and every one fails closed (an unreadable state, an unknown balance, a table that
// would grow without bound all refuse). Order of the checks: kill switch, door, size, concurrency, per visitor window, global window, daily
// count, model spend (reserved before the call, settled after it), NEAR float. Nothing is counted for a refused attempt.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatBaseUnits, toBaseUnits } from '@airlock/runtime/money';
import type { Refusal } from './types.ts';

export interface Limits {
  perIpMax: number;
  perIpWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
  dailyMax: number;
  maxChars: number;
  maxInFlight: number;
  /** model spend cap for the whole challenge, USD decimal string */
  llmCapUsd: string;
  /** reserved per attempt before the call, USD decimal string */
  llmEstimateUsd: string;
  /** NEAR the challenge may let through to booked payees in one UTC day, yocto decimal string (a cap on the policy's float use) */
  nearDailyCapYocto: string;
  /** the policy account must hold at least this much, yocto decimal string, or the door closes */
  nearFloatMinYocto: string;
}

export const DEFAULT_LIMITS: Limits = {
  perIpMax: 5,
  perIpWindowMs: 10 * 60_000,
  globalMax: 60,
  globalWindowMs: 60 * 60_000,
  dailyMax: 300,
  maxChars: 4000,
  maxInFlight: 2,
  llmCapUsd: '1.00',
  llmEstimateUsd: '0.01',
  nearDailyCapYocto: toBaseUnits('20', 24).toString(),
  nearFloatMinYocto: toBaseUnits('1', 24).toString(),
};

const MAX_KEYS = 10_000;

/** A sliding window of event times per key. `check` never records; `record` and `unrecord` are the pair around a decision. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number,
  ) {}

  private live(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /** null when the key may go on, else the milliseconds until its oldest hit leaves the window. A new key past the table bound is refused. */
  check(key: string): { retryAfterMs: number } | null {
    const kept = this.live(key);
    if (kept.length === 0 && this.hits.size >= MAX_KEYS) return { retryAfterMs: this.windowMs };
    if (kept.length < this.max) return null;
    return { retryAfterMs: Math.max(1000, (kept[0] ?? 0) + this.windowMs - this.clock()) };
  }

  record(key: string): void {
    const kept = this.live(key);
    kept.push(this.clock());
    this.hits.set(key, kept);
  }

  unrecord(key: string): void {
    const kept = this.live(key);
    kept.pop();
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
  }
}

interface SpendState {
  /** nano-USD, a decimal string */
  spentNano: string;
}

/** The model spend ledger: a file that holds the total spent so far. A file that exists and does not parse stops the start. */
export class SpendLedger {
  private spent: bigint;

  constructor(
    private readonly path: string | null,
    private readonly capNano: bigint,
  ) {
    this.spent = 0n;
    if (path !== null && existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SpendState>;
      if (typeof parsed.spentNano !== 'string' || !/^[0-9]{1,30}$/.test(parsed.spentNano)) throw new Error('spend ledger file is not valid');
      this.spent = BigInt(parsed.spentNano);
    }
  }

  get spentNano(): bigint {
    return this.spent;
  }

  /** true when `nano` more would still fit under the cap */
  fits(nano: bigint): boolean {
    return this.spent + nano <= this.capNano;
  }

  add(nano: bigint): void {
    this.spent += nano;
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ spentNano: this.spent.toString() } satisfies SpendState), 'utf8');
    renameSync(tmp, this.path);
  }
}

export interface AdmissionDeps {
  limits: Limits;
  clock(): number;
  /** the kill switch: true stops every attempt */
  paused(): boolean;
  /** door (a) is on only in live mode */
  liveEnabled: boolean;
  ledger: SpendLedger;
  /** the policy account's free balance in yocto; a throw or a null reads as unknown and closes the door */
  floatProbe: (() => Promise<bigint | null>) | null;
}

export type Admission = { ok: true; ticket: Ticket } | { ok: false; code: Refusal; retryAfterMs: number | null };

/** The slot an admitted attempt holds until `settle`. */
export interface Ticket {
  /** The attempt ended: `costUsd` is what the model calls cost, `movedYocto` what the gate let through to a booked payee. */
  settle(done: { costUsd: string; movedYocto: bigint }): void;
  /** The attempt never reached the engine: everything it held is given back. */
  abort(): void;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class AdmissionControl {
  private readonly perIp: SlidingWindow;
  private readonly global: SlidingWindow;
  private inFlight = 0;
  private day = '';
  private dayCount = 0;
  private dayMoved = 0n;
  private reservedNano = 0n;

  constructor(private readonly d: AdmissionDeps) {
    this.perIp = new SlidingWindow(d.limits.perIpMax, d.limits.perIpWindowMs, d.clock);
    this.global = new SlidingWindow(d.limits.globalMax, d.limits.globalWindowMs, d.clock);
  }

  private rollDay(): void {
    const today = dayOf(this.d.clock());
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
      this.dayMoved = 0n;
    }
  }

  /** `visitor` is a stable key for the person (a salted hash of the address), never the address. */
  async admit(visitor: string, text: string): Promise<Admission> {
    const { limits } = this.d;
    const no = (code: Refusal, retryAfterMs: number | null = null): Admission => ({ ok: false, code, retryAfterMs });
    if (this.d.paused()) return no('paused');
    if (!this.d.liveEnabled) return no('live_off');
    const chars = Array.from(text).length;
    if (text.trim() === '') return no('empty');
    if (chars > limits.maxChars) return no('too_long');
    this.rollDay();
    if (this.inFlight >= limits.maxInFlight) return no('busy', 2000);
    const ip = this.perIp.check(visitor);
    if (ip !== null) return no('rate_ip', ip.retryAfterMs);
    const all = this.global.check('*');
    if (all !== null) return no('rate_global', all.retryAfterMs);
    if (this.dayCount >= limits.dailyMax) return no('daily_cap');
    if (this.dayMoved >= BigInt(limits.nearDailyCapYocto)) return no('float_low');
    const estimate = toBaseUnits(limits.llmEstimateUsd, 9);
    if (!this.d.ledger.fits(this.reservedNano + estimate)) return no('llm_cap');

    // everything above is synchronous: claim the slot before the one await, so two attempts cannot both pass the same check
    this.perIp.record(visitor);
    this.global.record('*');
    this.dayCount += 1;
    this.inFlight += 1;
    this.reservedNano += estimate;
    let open = true;
    const release = (): void => {
      open = false;
      this.inFlight -= 1;
      this.reservedNano -= estimate;
    };
    const refund = (): void => {
      this.perIp.unrecord(visitor);
      this.global.unrecord('*');
      this.dayCount -= 1;
    };

    if (this.d.floatProbe !== null) {
      let free: bigint | null = null;
      try {
        free = await this.d.floatProbe();
      } catch {
        free = null;
      }
      if (free === null) {
        release();
        refund();
        return no('float_unknown', 30_000);
      }
      if (free < BigInt(limits.nearFloatMinYocto)) {
        release();
        refund();
        return no('float_low');
      }
    }
    const ticket: Ticket = {
      settle: ({ costUsd, movedYocto }) => {
        if (!open) return;
        release();
        this.d.ledger.add(toBaseUnits(costUsd, 9));
        this.dayMoved += movedYocto;
      },
      abort: () => {
        if (!open) return;
        release();
        refund();
      },
    };
    return { ok: true, ticket };
  }

  /** The spend so far, USD decimal string (for the state route). */
  spentUsd(): string {
    return formatBaseUnits(this.d.ledger.spentNano, 9);
  }
}
