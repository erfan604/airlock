// The home page's main content: three doors in one wall, each a real thing to do in under a minute. A door is a physical thing of the /break and
// /lend family: a frame, an engraved plate, a leaf that swings a little open on hover (and settles on press) to show the lit inside, a window
// with the one number that door has. Numbers come from doors.ts; until a read lands the recorded value shows, labelled.
// Motion is transform only and base.css turns it off under reduced motion.
import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { NEAR_RPC } from '../../csp.ts';
import { readPool } from '../credit/chain.ts';
import { CREDIT_POOL } from '../credit/net.ts';
import { countText } from '../live/tryChain.ts';
import { STATIC, url } from '../static.ts';
import { asOfText, bakedState, loadSiteState, SITE_STATE_COMMAND } from '../state/siteState.ts';
import type { SiteState } from '../state/siteState.ts';
import { lendOfState, readBreakDoor, readLendDoor, readRobDoor, recordedBreak, recordedLend, recordedRob, robOfState, sourceNote } from './doors.ts';
import type { BreakDoor, LendDoor, RobDoor } from './doors.ts';
import { poolLine } from './facts.ts';
import type { PoolRead } from './facts.ts';

type LeafProps = { plate: string; title: string; what: string; number: string; caption: ReactNode; note: string; live: boolean; testId: string };

// The inside of a door. The anchor around it is written out at each door below, so every link target is a constant on its own line
// (scripts/security-pass.sh reads them there).
// Until a read lands the number is the recorded one: it is dimmed, and the note in the same window says it is the recorded value, so a phone
// never shows a figure that changes a second later without saying so on the same screen.
function DoorLeaf({ plate, title, what, number, caption, note, live, testId }: LeafProps): ReactElement {
  return (
    <>
      <span className="door-inside" aria-hidden="true" />
      <span className="door-leaf">
        <span className="door-plate">{plate}</span>
        <span className="door-title">{title}</span>
        <span className="door-what">{what}</span>
        <span className="door-window" data-live={live ? 'true' : 'false'}>
          <span className="door-number" data-testid={`${testId}-number`}>
            {number}
          </span>
          <span className="door-caption">{caption}</span>
          <span className="door-note" data-testid={`${testId}-note`}>
            {note}
          </span>
        </span>
      </span>
    </>
  );
}

/** `asOfMs`: the home page's history-derived numbers come from the site state file written at that time (none: they are read live or recorded). */
export function DoorsView({ lend, rob, brk, pool, asOfMs = null }: { lend: LendDoor; rob: RobDoor; brk: BreakDoor; pool: PoolRead; asOfMs?: number | null }): ReactElement {
  const p = poolLine(pool);
  // the Lend door shows two reads, the pool's size and its outside lenders: it says live when both are, and failed when either failed; a lender
  // count from the state file is dated, whatever the pool read did
  const lendSource = lend.source === 'failed' || pool.kind === 'failed' ? 'failed' : lend.source === 'state' ? 'state' : lend.source === 'live' && pool.kind === 'live' ? 'live' : 'recorded';
  return (
    <section className="doors" aria-labelledby="doors-title" data-testid="landing-doors">
      <h2 id="doors-title" className="doors-title">
        Three things to do in under a minute
      </h2>
      <ul className="door-wall" role="list">
        <li className="door door-rob">
          <a className="door-frame" href={url('rob')} data-testid="door-rob">
            <DoorLeaf
              plate="Rob it"
              title="Send a real attack"
              what="Your browser signs what a hijacked agent would send to a practice card, and the card's contract answers."
              number={String(rob.paidOutside)}
              caption={`paid to anyone but the booked shop, in ${countText(rob.attempts)} ${rob.attempts === 1 ? 'attempt' : 'attempts'}.`}
              note={sourceNote(rob.source, 'Read from the chain.', rob.asOfMs)}
              live={rob.source === 'live' || rob.source === 'state'}
              testId="door-rob"
            />
          </a>
        </li>
        <li className="door door-lend">
          <a className="door-frame" href={url('lend')} data-testid="door-lend">
            <DoorLeaf
              plate="Lend"
              title="Lend 1 NEAR to the agents"
              what="One click makes you a real account of your own and lends 1 NEAR from it into the live pool."
              number={p.held.replace(/ NEAR$/, '')}
              caption={`NEAR in the pool now. ${lend.lenders === 0 ? 'No lender from outside the team yet. Be one.' : `${String(lend.lenders)} lender ${lend.lenders === 1 ? 'account' : 'accounts'} from outside the team so far.`}`}
              note={sourceNote(lendSource, 'Read from the pool contract and its own deposit records.', lend.asOfMs)}
              live={lendSource === 'live' || lendSource === 'state'}
              testId="door-lend"
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
              caption={`broken copies of the gate; our model checker catches ${brk.kaniFails === brk.copies ? 'each one' : `${String(brk.kaniFails)} of them`}.`}
              note={sourceNote(brk.source, 'From the recorded model checker (Kani) runs the page shows.')}
              live={brk.source === 'live'}
              testId="door-break"
            />
          </a>
        </li>
      </ul>
      {asOfMs === null ? null : (
        <p className="doors-limits" data-testid="doors-asof">
          {`The attempt and lender counts are read from the chain's public history, ${asOfText(asOfMs)}, and refreshed every hour. To recompute them from the repository: `}
          <code>{SITE_STATE_COMMAND}</code>.
        </p>
      )}
      <p className="doors-limits" data-testid="doors-limits">
        Runs on the NEAR test network, where NEAR has no value. The borrower and the merchant in the hourly loop are accounts the team runs, and the issuer books the payees a card may pay. <a href={url('terms')}>Every term, with its code line, proof or test</a>.
      </p>
    </section>
  );
}

const poolOfState = (s: SiteState): PoolRead => ({ kind: 'state', assets: s.pool.assets, losses: s.pool.losses, asOfMs: s.as_of_ms });

export function Doors(): ReactElement {
  // a prerendered page carries the state file it was built with, so its first render is the HTML's
  const [baked] = useState(() => bakedState());
  const [lend, setLend] = useState<LendDoor>(() => (baked === null ? recordedLend() : lendOfState(baked)));
  const [rob, setRob] = useState<RobDoor>(() => (baked === null ? recordedRob() : robOfState(baked)));
  const [brk, setBrk] = useState<BreakDoor>(() => recordedBreak());
  const [pool, setPool] = useState<PoolRead>(() => (baked === null ? { kind: 'recorded' } : poolOfState(baked)));
  const [asOfMs, setAsOf] = useState<number | null>(baked?.as_of_ms ?? null);
  useEffect(() => {
    // the local console (replay mode, no keys) makes no request off its own origin: it keeps the recorded values, labelled
    if (!STATIC) return undefined;
    let live = true;
    // the lender and attempt counts come from the site state file (same origin) and the home page asks the history API for nothing; only
    // without the file (a local build) are they read from the history API as before
    void loadSiteState().then((s) => {
      if (!live) return;
      if (s !== null) {
        setLend(lendOfState(s));
        setRob(robOfState(s));
        setAsOf(s.as_of_ms);
        setPool((p) => (p.kind === 'live' ? p : poolOfState(s)));
        return;
      }
      readLendDoor().then((v) => live && setLend(v), () => live && setLend(recordedLend(true)));
      readRobDoor().then((v) => live && setRob(v), () => live && setRob(recordedRob(true)));
    });
    readBreakDoor().then((v) => live && setBrk(v), () => live && setBrk(recordedBreak(true)));
    readPool({ pool: CREDIT_POOL, rpcUrls: NEAR_RPC }).then(
      (v) => live && setPool({ kind: 'live', assets: v.assets, losses: v.losses }),
      () => live && setPool((p) => (p.kind === 'state' ? p : { kind: 'failed' })),
    );
    return () => {
      live = false;
    };
  }, []);
  return <DoorsView lend={lend} rob={rob} brk={brk} pool={pool} asOfMs={asOfMs} />;
}
