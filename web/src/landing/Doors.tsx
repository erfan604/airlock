// The home page's main content: three doors in one wall, each a real thing to do in under a minute. A door is a physical thing of the /break and
// /lend family: a frame, an engraved plate, a leaf that swings a little open on hover (and settles on press) to show the lit inside, a window
// with the one number that door has, and a push bar. Numbers come from doors.ts; until a read lands the recorded value shows, labelled.
// Motion is transform only and base.css turns it off under reduced motion.
import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { readPool } from '../credit/chain.ts';
import { CREDIT_POOL } from '../credit/net.ts';
import { STATIC, url } from '../static.ts';
import { readBreakDoor, readLendDoor, readRobDoor, recordedBreak, recordedLend, recordedRob, sourceNote } from './doors.ts';
import type { BreakDoor, LendDoor, RobDoor } from './doors.ts';
import { poolLine } from './facts.ts';
import type { PoolRead } from './facts.ts';

type LeafProps = { plate: string; title: string; what: string; number: string; caption: ReactNode; note: string; testId: string };

// The inside of a door. The anchor around it is written out at each door below, so every link target is a constant on its own line
// (scripts/security-pass.sh reads them there).
function DoorLeaf({ plate, title, what, number, caption, note, testId }: LeafProps): ReactElement {
  return (
    <>
      <span className="door-inside" aria-hidden="true" />
      <span className="door-leaf">
        <span className="door-plate">{plate}</span>
        <span className="door-title">{title}</span>
        <span className="door-what">{what}</span>
        <span className="door-window">
          <span className="door-number" data-testid={`${testId}-number`}>
            {number}
          </span>
          <span className="door-caption">{caption}</span>
          <span className="door-note" data-testid={`${testId}-note`}>
            {note}
          </span>
        </span>
        <span className="door-bar" aria-hidden="true" />
      </span>
    </>
  );
}

export function DoorsView({ lend, rob, brk, pool }: { lend: LendDoor; rob: RobDoor; brk: BreakDoor; pool: PoolRead }): ReactElement {
  const p = poolLine(pool);
  // the Lend door shows two reads, the pool's size and its outside lenders: it says live when both are, and failed when either failed
  const lendSource = lend.source === 'failed' || pool.kind === 'failed' ? 'failed' : lend.source === 'live' && pool.kind === 'live' ? 'live' : 'recorded';
  return (
    <section className="doors" aria-labelledby="doors-title" data-testid="landing-doors">
      <h2 id="doors-title" className="doors-title">
        Three things to do in under a minute
      </h2>
      <ul className="door-wall" role="list">
        <li className="door door-lend">
          <a className="door-frame" href={url('lend')} data-testid="door-lend">
            <DoorLeaf
              plate="Lend"
              title="Lend 1 NEAR to the agents"
              what="One click makes you a real account of your own and lends 1 NEAR from it into the live pool."
              number={p.held.replace(/ NEAR$/, '')}
              caption={`NEAR in the pool now. ${String(lend.lenders)} lender ${lend.lenders === 1 ? 'account' : 'accounts'} not on the team's list so far.`}
              note={sourceNote(lendSource, 'Read from the pool contract and its own deposit records.')}
              testId="door-lend"
            />
          </a>
        </li>
        <li className="door door-rob">
          <a className="door-frame" href={url('rob')} data-testid="door-rob">
            <DoorLeaf
              plate="Rob it"
              title="Send a real attack"
              what="Your browser signs what a hijacked agent would send to a practice card, and the card's contract answers."
              number={String(rob.paidOutside)}
              caption={`paid to anyone but the booked shop, in ${String(rob.attempts)} ${rob.attempts === 1 ? 'attempt' : 'attempts'}.`}
              note={sourceNote(rob.source, 'Read from the chain.')}
              testId="door-rob"
            />
          </a>
        </li>
        <li className="door door-break">
          <a className="door-frame" href={url('break')} data-testid="door-break">
            <DoorLeaf
              plate="Break the proof"
              title="Take one rule out of the gate"
              what="Run an attack through the real gate and through a copy with one rule removed: the copy pays."
              number={String(brk.copies)}
              caption={`broken copies of the gate; Kani fails on ${brk.kaniFails === brk.copies ? 'each one' : `${String(brk.kaniFails)} of them`}.`}
              note={sourceNote(brk.source, 'From the recorded Kani runs the page shows.')}
              testId="door-break"
            />
          </a>
        </li>
      </ul>
      <p className="doors-limits" data-testid="doors-limits">
        Runs on the NEAR test network, where NEAR has no value. The borrower and the merchant in the hourly loop are accounts the team runs, and the issuer books the payees a card may pay. <a href={url('terms')}>Every term, with its code line, proof or test</a>.
      </p>
    </section>
  );
}

export function Doors(): ReactElement {
  const [lend, setLend] = useState<LendDoor>(() => recordedLend());
  const [rob, setRob] = useState<RobDoor>(() => recordedRob());
  const [brk, setBrk] = useState<BreakDoor>(() => recordedBreak());
  const [pool, setPool] = useState<PoolRead>({ kind: 'recorded' });
  useEffect(() => {
    // the local console (replay mode, no keys) makes no request off its own origin: it keeps the recorded values, labelled
    if (!STATIC) return undefined;
    let live = true;
    readLendDoor().then((v) => live && setLend(v), () => live && setLend(recordedLend(true)));
    readRobDoor().then((v) => live && setRob(v), () => live && setRob(recordedRob(true)));
    readBreakDoor().then((v) => live && setBrk(v), () => live && setBrk(recordedBreak(true)));
    readPool({ pool: CREDIT_POOL, rpcUrls: NEAR_RPC }).then(
      (v) => live && setPool({ kind: 'live', assets: v.assets, losses: v.losses }),
      () => live && setPool({ kind: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, []);
  return <DoorsView lend={lend} rob={rob} brk={brk} pool={pool} />;
}
