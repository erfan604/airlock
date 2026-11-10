// AIR-359: one cycle of the economy loop. The order: the live switch and maintenance (files), the lock shared with the arena, the
// preflight (views only), the state, the loop's own past-time holds expired, an open loop line repaid first (recovery), the stop rules,
// then the four transactions (collateral, line, payment, repay) and the merchant's send-back. Every write goes through `io`, so the dry
// mode and the tests can show that nothing is sent. The loop only ever calls expire on a held request.
import { EXPIRE_MARGIN_MS, LOOP_FEE_BPS, LOOP_LIMIT_YOCTO, LOOP_TERM_MS } from './facts.ts';
import { LIVE_OFF, LOCK_HELD, MAINTENANCE, collateralNeeded, economyStop, feeOf, isLoopHold, nearText, ownLine, poolBuffer, recycleDue } from './stops.ts';
import type { EconomyRecord, EconomyState, LineView } from './stops.ts';

export type PayOut = { tx: string | null; outcome: string; reason: string | null; pendingId: string | null };

export type EconomyIo = {
  nowMs(): number;
  /** target/economy/LIVE_OK exists */
  liveOk(): boolean;
  /** target/credit/MAINTENANCE exists */
  maintenance(): boolean;
  /** takes the lock shared with the arena; null when another job holds it */
  lock(): (() => void) | null;
  /** the agent's signer, the book vault and the task key, checked with views only: a reason to fail, or null */
  preflight(): Promise<string | null>;
  state(): Promise<EconomyState>;
  /** the card's line on the pool */
  line(): Promise<LineView | null>;
  expire(id: string): Promise<string>;
  /** the borrower posts collateral for the card's next line */
  postCollateral(amount: bigint): Promise<string>;
  /** the issuer opens the line and the pool funds the card */
  openLine(limit: bigint, feeBps: number, dueMs: number): Promise<string>;
  /** the agent pays the booked merchant under an owner task that states the amount */
  pay(amount: bigint): Promise<PayOut>;
  /** the borrower repays what the card kept plus the fee */
  repay(amount: bigint): Promise<string>;
  /** the merchant sends NEAR back to the borrower */
  recycle(amount: bigint): Promise<string>;
  sleep(ms: number): Promise<void>;
  records(): EconomyRecord[];
  append(r: EconomyRecord): void;
  log(line: string): void;
};

export type CycleOut = { code: number; line: string };

const stamp = (ms: number): string => new Date(ms).toISOString();
/** A balance for a log line: NEAR with four fraction digits, rounded down. */
const near4 = (yocto: bigint): string => nearText(yocto - (yocto % 10n ** 20n));

/** The state as a few lines for the log of a dry run and of `check`. */
export function stateLines(s: EconomyState): string[] {
  const own = ownLine(s.pool);
  const p = s.pool;
  return [
    `pool: idle ${nearText(p.idle)} NEAR, impaired ${nearText(p.impaired)}, losses ${nearText(p.losses)}, collateral held ${nearText(p.collateralHeld)}, fees earned ${nearText(p.feesEarned)}, storage buffer ${poolBuffer(p) < 0n ? 'below 0' : near4(poolBuffer(p))} NEAR`,
    `lines: ${p.lines.length === 0 ? 'none' : p.lines.map((l) => `${l.card} ${l.state} limit ${nearText(l.limit)}`).join('; ')}${own !== null && own.state === 'Open' ? ' (the loop line is open)' : ''}`,
    `passport: ${s.passport === null ? 'the pool has no Passport view (before the upgrade)' : `base ${nearText(s.passport.base)} NEAR, borrower score ${String(s.passport.score)}, cap ${nearText(s.passport.cap)} NEAR`}`,
    `card: paused ${String(s.card.paused)}, held requests ${String(s.card.pending.length)}`,
    `balances: borrower ${near4(s.balances.borrower)}, agent ${near4(s.balances.agent)}, issuer ${near4(s.balances.issuer)}, merchant ${near4(s.balances.merchant)} NEAR`,
    `last loop cycle ${s.lastCycleMs === null ? 'none seen' : stamp(s.lastCycleMs)}, last arena attempt ${s.lastArenaMs === null ? 'none seen' : stamp(s.lastArenaMs)}`,
  ];
}

/** What a cycle would do on this state, with exact amounts. */
export function planLines(s: EconomyState, records: readonly EconomyRecord[], nowMs: number): string[] {
  const own = ownLine(s.pool);
  if (own !== null && own.state === 'Open') {
    const outstanding = own.limit - own.returned;
    return [`would repay the loop's open line first: ${nearText(outstanding + feeOf(outstanding, own.feeBps))} NEAR (recovery), and open no new line in that run`];
  }
  const need = collateralNeeded(LOOP_LIMIT_YOCTO, s.pool.collateralBps);
  const have = own !== null && own.state === 'Collecting' ? own.collateral : 0n;
  const fee = feeOf(LOOP_LIMIT_YOCTO, LOOP_FEE_BPS);
  const back = recycleDue({ merchant: s.balances.merchant, borrower: s.balances.borrower, records, nowMs });
  return [
    have >= need ? `collateral already posted (${nearText(have)} NEAR)` : `would post ${nearText(need - have)} NEAR of collateral (the borrower, post_collateral)`,
    `would open a line of ${nearText(LOOP_LIMIT_YOCTO)} NEAR, fee ${String(LOOP_FEE_BPS / 100)} percent, due in ${String(LOOP_TERM_MS / 3_600_000)} h (the issuer, open_line)`,
    `would pay the booked merchant ${nearText(LOOP_LIMIT_YOCTO)} NEAR (amount from the owner task, label Owner) (the agent, submit_batch)`,
    `would repay ${nearText(LOOP_LIMIT_YOCTO + fee)} NEAR, of which ${nearText(fee)} NEAR is the lenders' fee (the borrower, repay)`,
    back === null ? 'no send-back from the merchant now' : `would send ${nearText(back)} NEAR from the merchant back to the borrower`,
  ];
}

export async function runCycle(io: EconomyIo, opts: { dry: boolean }): Promise<CycleOut> {
  if (opts.dry) {
    const s = await io.state();
    io.log(`live switch ${io.liveOk() ? 'on' : 'off'} (target/economy/LIVE_OK), maintenance ${io.maintenance() ? 'on' : 'off'} (target/credit/MAINTENANCE)`);
    for (const l of stateLines(s)) io.log(l);
    for (const l of planLines(s, io.records(), io.nowMs())) io.log(l);
    const stop = economyStop(s, io.nowMs());
    return { code: 0, line: `ECONOMY DRY: nothing was sent; ${stop === null ? 'no stop rule holds' : `a live cycle would end with: ${stop}`}` };
  }
  if (!io.liveOk()) return { code: 0, line: LIVE_OFF };
  if (io.maintenance()) return { code: 0, line: MAINTENANCE };
  const release = io.lock();
  if (release === null) return { code: 0, line: LOCK_HELD };
  try {
    return await cycle(io);
  } finally {
    release();
  }
}

async function waitFor(io: EconomyIo, want: LineView['state']): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    const l = await io.line();
    if (l !== null && l.state === want) return true;
    await io.sleep(1500);
  }
  return false;
}

async function cycle(io: EconomyIo): Promise<CycleOut> {
  const fail = (why: string): CycleOut => {
    io.append({ kind: 'failed', at: stamp(io.nowMs()), atMs: io.nowMs(), why });
    return { code: 1, line: `ECONOMY CYCLE FAILED ${why}` };
  };
  const unfit = await io.preflight();
  if (unfit !== null) return fail(`preflight: ${unfit}`);
  let s = await io.state();

  // the loop's own holds past their time are expired (expire is open to anyone after the time and counts no reject)
  const gone = new Set<string>();
  for (const h of s.card.pending) {
    if (!isLoopHold(h) || h.expiresMs + EXPIRE_MARGIN_MS > io.nowMs()) continue;
    const tx = await io.expire(h.id);
    io.append({ kind: 'expire', at: stamp(io.nowMs()), atMs: io.nowMs(), id: h.id, tx });
    gone.add(h.id);
  }
  if (gone.size > 0) s = { ...s, card: { ...s.card, pending: s.card.pending.filter((h) => !gone.has(h.id)) } };

  // recovery: a loop line left open by a run that died is repaid before anything else
  const own = ownLine(s.pool);
  if (own !== null && own.state === 'Open') {
    const outstanding = own.limit - own.returned;
    const owed = outstanding + feeOf(outstanding, own.feeBps);
    const tx = await io.repay(owed);
    io.append({ kind: 'recovered', at: stamp(io.nowMs()), atMs: io.nowMs(), amount: owed.toString(), tx });
    if (!(await waitFor(io, 'Repaid'))) return fail(`the loop's open line was repaid (${tx}) and the pool does not show it repaid`);
    return { code: 0, line: `ECONOMY RECOVERED the loop's open line was repaid (${tx}), ${nearText(owed)} NEAR; the next run opens a new line` };
  }

  const stop = economyStop(s, io.nowMs());
  if (stop !== null) return { code: 0, line: stop };

  const need = collateralNeeded(LOOP_LIMIT_YOCTO, s.pool.collateralBps);
  const have = own !== null && own.state === 'Collecting' ? own.collateral : 0n;
  const collateralTx = have >= need ? null : await io.postCollateral(need - have);
  const openTx = await io.openLine(LOOP_LIMIT_YOCTO, LOOP_FEE_BPS, io.nowMs() + LOOP_TERM_MS);
  if (!(await waitFor(io, 'Open'))) return fail(`open_line was sent (${openTx}) and the pool does not show the line open`);

  let paid: Awaited<ReturnType<EconomyIo['pay']>> | null = null;
  let payError: string | null = null;
  try {
    paid = await io.pay(LOOP_LIMIT_YOCTO);
  } catch (e) {
    payError = e instanceof Error ? e.message.slice(0, 200) : 'unknown error';
  }
  if (paid !== null && paid.pendingId !== null) io.append({ kind: 'hold', at: stamp(io.nowMs()), atMs: io.nowMs(), id: paid.pendingId, tx: paid.tx });

  // the line is repaid whatever the payment did: a line is never left open
  const line = await io.line();
  const outstanding = line === null ? LOOP_LIMIT_YOCTO : line.limit - line.returned;
  const fee = feeOf(outstanding, LOOP_FEE_BPS);
  const repayTx = await io.repay(outstanding + fee);
  const repaid = await waitFor(io, 'Repaid');
  io.append({ kind: 'cycle', at: stamp(io.nowMs()), atMs: io.nowMs(), limit: LOOP_LIMIT_YOCTO.toString(), fee: fee.toString(), txs: { collateral: collateralTx, open: openTx, pay: paid?.tx ?? null, repay: repayTx } });
  if (payError !== null) return fail(`the payment failed (${payError}); the line was repaid (${repayTx})`);
  if (paid === null || paid.outcome !== 'allowed') return fail(`the payment was ${paid?.outcome ?? 'not answered'}${paid?.reason === null || paid?.reason === undefined ? '' : ` ${paid.reason}`}, not allowed (${paid?.tx ?? 'no hash'}); the line was repaid (${repayTx})`);
  if (!repaid) return fail(`repay was sent (${repayTx}) and the pool does not show the line repaid`);

  const back = recycleDue({ merchant: s.balances.merchant, borrower: s.balances.borrower, records: io.records(), nowMs: io.nowMs() });
  if (back !== null) {
    try {
      const tx = await io.recycle(back);
      io.append({ kind: 'recycle', at: stamp(io.nowMs()), atMs: io.nowMs(), amount: back.toString(), tx });
      io.log(`ECONOMY SEND-BACK ${nearText(back)} NEAR from the merchant to the borrower (${tx})`);
    } catch (e) {
      // the cycle itself is complete; the send-back is tried again by the next run
      io.log(`ECONOMY NOTE the merchant's send-back failed: ${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}`);
    }
  }
  return { code: 0, line: `ECONOMY CYCLE OK pay ${paid.tx ?? 'no hash'} repay ${repayTx} fee ${nearText(fee)} NEAR` };
}
