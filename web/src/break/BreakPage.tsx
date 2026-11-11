// AIR-361: the /break route, a lazy chunk. The real gate (web/public/verdict.wasm, the function the contract runs) stands beside copies of
// itself with one rule taken out (web/public/mutants/, scripts/build-verdict-mutants.sh). The visitor picks an attack and a copy; both
// machines run the same 21 columns in the browser. Under them: the rule the copy lost, the Kani harness that fails on it with the recorded
// output, and the Lean theorem it breaks. Same-origin files only: no chain, no wallet, no network beyond this site.
import { useEffect, useRef, useState } from 'react';
import { url } from '../static.ts';
import { instantiateVerdict, loadVerdict } from '../try/verdictWasm.ts';
import type { VerdictModule } from '../try/verdictWasm.ts';
import { COVERAGE, hunkLines, parseManifest, payingCopy, reasonWords, resultOf } from './model.ts';
import type { Attack, Copy, Manifest, Side } from './model.ts';

export type Modules = { real: VerdictModule; copies: Record<string, VerdictModule> };

const TITLE = 'Break the proof';
const LEAD = 'The gate below is the same function the contract runs, compiled for your browser. Each broken copy of it has one rule taken out. Pick an attack: the page puts it through the real gate and through the copy that pays it, and you can then try any other copy.';
const NUMBER = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

function claim(n: number): string {
  const word = NUMBER[n] ?? String(n);
  return `${word} ${n === 1 ? 'copy' : 'copies'} of the gate, each with one rule removed, ${n === 1 ? 'pays' : 'pay'} an attack the real gate refuses. A named check of our model checker (Kani) fails on each copy (recorded output), and each copy breaks a machine-checked proof (Lean) about the model.`;
}

function Head() {
  return (
    <header className="brk-head">
      <h1 className="brk-title">{TITLE}</h1>
      <p className="brk-lede">{LEAD}</p>
    </header>
  );
}

function Coverage({ n }: { n: number | null }) {
  return (
    <section className="brk-cover" aria-labelledby="brk-cover-title">
      <h2 id="brk-cover-title" className="brk-h2">
        What this shows, and what it does not
      </h2>
      {n === null ? null : <p className="brk-claim">{claim(n)}</p>}
      <p className="brk-coverage" data-testid="brk-coverage">
        {COVERAGE}
      </p>
    </section>
  );
}

const labelText = (names: string[]): string => names.join(', ');

/** One machine: a nameplate, the slot the request drops into, the window that shows the answer, and the tray a payment comes out of. */
function Machine({ who, name, plate, side, attack, run }: { who: 'real' | 'copy'; name: string; plate: string; side: Side | null; attack: Attack; run: number }) {
  const state = side === null ? 'idle' : side.kind;
  return (
    <figure className={`brk-machine brk-machine-${who}`} data-state={state} data-testid={`brk-machine-${who}`}>
      <figcaption className="brk-plate">
        <span className="brk-plate-name">{name}</span>
        <span className="brk-plate-id">{plate}</span>
      </figcaption>
      <div className="brk-slot" aria-hidden="true">
        <span className="brk-slit" />
        <span key={`slip-${String(run)}`} className="brk-slip">
          {attack.amount} {attack.symbol}
          <span className="brk-slip-to"> to {attack.payee}</span>
        </span>
      </div>
      <div className="brk-window" key={`win-${String(run)}`}>
        {side === null ? (
          <p className="brk-word brk-word-idle">Loading</p>
        ) : side.kind === 'refused' ? (
          <>
            <span className="brk-shutter" aria-hidden="true" />
            <p className="brk-word brk-word-refused">Refused</p>
            <p className="brk-why" data-testid={`brk-line-${who}`}>
              {side.line}
              {side.reason === null ? null : <span className="brk-why-words">{` (${reasonWords(side.reason)})`}</span>}
            </p>
          </>
        ) : (
          <>
            <p className="brk-word brk-word-paid">Paid</p>
            <p className="brk-why" data-testid={`brk-line-${who}`}>
              {side.line}
            </p>
          </>
        )}
      </div>
      <div className="brk-tray" aria-hidden="true">
        {side?.kind === 'paid' ? (
          <span key={`out-${String(run)}`} className="brk-payout">
            {attack.amount} {attack.symbol} out
          </span>
        ) : null}
      </div>
    </figure>
  );
}

function Evidence({ copy, kani }: { copy: Copy; kani: string | undefined }) {
  const lines = hunkLines(copy.patchText);
  return (
    <section className="brk-evidence" aria-labelledby="brk-ev-title" data-testid="brk-evidence">
      <h2 id="brk-ev-title" className="brk-h2">
        Why this copy is ruled out
      </h2>
      <div className="brk-ev-grid">
        <article className="brk-ev">
          <h3 className="brk-h3">The rule it lost</h3>
          <p className="brk-ev-meta">
            {copy.title}. <span className="brk-mono">{`${copy.rule.file}:${String(copy.rule.from)}-${String(copy.rule.to)}`}</span>, removed by <span className="brk-mono">{`scripts/canary/${copy.patch}`}</span>.
          </p>
          <pre className="brk-code brk-diff" data-testid="brk-diff">
            {lines.map((l, i) => (
              <span key={i} className={l.sign === '-' ? 'brk-del' : l.sign === '+' ? 'brk-add' : 'brk-ctx'}>
                {`${l.sign === ' ' ? ' ' : l.sign} ${l.text}\n`}
              </span>
            ))}
          </pre>
        </article>
        <article className="brk-ev">
          <h3 className="brk-h3">The model checker (Kani) check that fails on it</h3>
          <p className="brk-ev-meta">
            <code className="brk-mono brk-name">{copy.harness.name}</code> at <span className="brk-mono">{`${copy.harness.file}:${String(copy.harness.line)}`}</span>. Recorded output of Kani on this copy, then on the unpatched crate:
          </p>
          <pre className="brk-code brk-log" data-testid="brk-kani" tabIndex={0}>
            {kani ?? 'Loading the recorded output.'}
          </pre>
        </article>
        <article className="brk-ev">
          <h3 className="brk-h3">The machine-checked proof (Lean) it breaks</h3>
          <p className="brk-ev-meta">
            <code className="brk-mono brk-name">{copy.lean.name}</code> at <span className="brk-mono">{`${copy.lean.file}:${String(copy.lean.line)}`}</span>, proved about the model of the gate. The copy answers Allow where the theorem says it cannot:
          </p>
          <pre className="brk-code brk-lean" data-testid="brk-lean" tabIndex={0}>
            {copy.lean.statement}
          </pre>
        </article>
      </div>
    </section>
  );
}

export function BreakView({ data, kani, modules, initial, failed = false }: { data: Manifest | null; kani: Record<string, string>; modules: Modules | null; initial?: { attack: string; copy: string }; failed?: boolean }) {
  const first = data?.copies[0];
  const [attackId, setAttackId] = useState(initial?.attack ?? first?.attack ?? '');
  const [copyId, setCopyId] = useState(initial?.copy ?? first?.id ?? '');
  const [run, setRun] = useState(0);
  const pair = useRef<HTMLDivElement>(null);
  /** On a one-column screen the machines are away from the pickers: bring them into view after a pick, smoothly unless motion is reduced. */
  const reveal = (): void => {
    const el = pair.current;
    if (el === null || window.matchMedia('(min-width: 1080px)').matches) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
  };

  if (data === null || first === undefined) {
    return (
      <main className="page brk" data-testid="break">
        <Head />
        <p className="brk-status">{failed ? 'The gates did not load. Reload the page to try again.' : 'Loading the gates.'}</p>
        <Coverage n={null} />
      </main>
    );
  }

  const attack = data.attacks.find((a) => a.id === attackId) ?? (data.attacks[0] as Attack);
  const copy = data.copies.find((c) => c.id === copyId) ?? first;
  const cols = attack.columns.map((v) => BigInt(v));
  const copyMod = modules?.copies[copy.id];
  const result = modules === null || copyMod === undefined ? null : resultOf(attack, modules.real.decide(cols), copyMod.decide(cols));
  const pays = (a: Attack): Copy | undefined => payingCopy(data, a, modules);

  return (
    <main className="page brk" data-testid="break">
      <Head />

      <section className="brk-step" aria-labelledby="brk-attack-title">
        <h2 id="brk-attack-title" className="brk-h2">
          Pick an attack
        </h2>
        <ul className="brk-attacks" role="list" data-testid="brk-attacks">
          {data.attacks.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="brk-pick"
                aria-pressed={a.id === attack.id}
                data-testid={`brk-attack-${a.id}`}
                onClick={() => {
                  setAttackId(a.id);
                  // visitor test 2026-11-11: keeping the old copy left both sides saying Refused; switch to the copy this attack exploits
                  const c = pays(a);
                  if (c !== undefined) setCopyId(c.id);
                  setRun((r) => r + 1);
                  reveal();
                }}
              >
                <span className="brk-pick-title">{a.title}</span>
                <span className="brk-pick-line">
                  {a.constructed ? 'A constructed case. ' : 'From the bench. '}
                  {pays(a) === undefined ? null : (
                    <>
                      Paid by copy <span className="brk-nowrap">{pays(a)?.id}</span>.
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="brk-attack-sheet" data-testid="brk-attack-sheet">
          <p className="brk-story">{attack.story}</p>
          <dl className="brk-values">
            <div>
              <dt>Payee</dt>
              <dd>
                <span className="brk-mono">{attack.payee}</span> <span className="brk-origin">from {labelText(attack.labels.recipient)}</span>
              </dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                <span className="brk-mono">{`${attack.amount} ${attack.symbol}`}</span> <span className="brk-origin">from {labelText(attack.labels.amount)}</span>
              </dd>
            </div>
            <div>
              <dt>Decided by</dt>
              <dd>
                <span className="brk-origin">{labelText(attack.labels.pc)}</span>
              </dd>
            </div>
          </dl>
          <p className="brk-source">
            {attack.constructed ? <span className="brk-constructed">This is a constructed case, not a bench run. </span> : null}
            {attack.source}
          </p>
        </div>
      </section>

      <section className="brk-floor" aria-labelledby="brk-floor-title">
        <h2 id="brk-floor-title" className="brk-h2 sr-only">
          The same request into both gates
        </h2>
        <div className="brk-pair" ref={pair}>
          <Machine who="real" name="The real gate" plate={`verdict.wasm ${data.realSha256.slice(0, 12)}`} side={result?.real ?? null} attack={attack} run={run} />
          <Machine who="copy" name="Broken copy" plate={`${copy.id}.wasm ${copy.sha256.slice(0, 12)}`} side={result?.copy ?? null} attack={attack} run={run} />
          <p className="brk-result" data-testid="brk-result" aria-live="polite">
            {failed ? 'The gates did not load. Reload the page to try again.' : result === null ? 'Loading the gates.' : result.line}
          </p>
          <button type="button" className="card-btn card-btn-outline brk-again" data-testid="brk-again" disabled={result === null} onClick={() => setRun((r) => r + 1)}>
            Run it again
          </button>
        </div>
        <div className="brk-copies-wrap">
          <h3 className="brk-h3" id="brk-copies-title">
            Broken copies, one rule taken out of each
          </h3>
          <ul className="brk-copies" role="list" aria-labelledby="brk-copies-title" data-testid="brk-copies">
            {data.copies.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="brk-pick brk-copy"
                  aria-pressed={c.id === copy.id}
                  data-testid={`brk-copy-${c.id}`}
                  onClick={() => {
                    setCopyId(c.id);
                    setRun((r) => r + 1);
                    reveal();
                  }}
                >
                  <span className="brk-mono brk-copy-id">{c.id}</span>
                  <span className="brk-pick-line">{c.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Evidence copy={copy} kani={kani[copy.id]} />
      <Coverage n={data.copies.length} />
    </main>
  );
}

async function fetchOk(path: string): Promise<Response> {
  const res = await fetch(url(path), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${path}: ${String(res.status)}`);
  return res;
}

export function BreakPage() {
  const [data, setData] = useState<Manifest | null>(null);
  const [kani, setKani] = useState<Record<string, string>>({});
  const [modules, setModules] = useState<Modules | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const m = parseManifest(await (await fetchOk('mutants/manifest.json')).json());
      if (m === null) throw new Error('manifest.json does not parse');
      if (!live) return;
      setData(m);
      const [real, ...copies] = await Promise.all([loadVerdict(), ...m.copies.map(async (c) => instantiateVerdict(await (await fetchOk(c.wasm)).arrayBuffer()))]);
      if (!live || real === undefined) return;
      setModules({ real, copies: Object.fromEntries(m.copies.map((c, i) => [c.id, copies[i] as VerdictModule])) });
      const texts = await Promise.all(m.copies.map(async (c) => [c.id, await (await fetchOk(`mutants/${c.kani}`)).text()] as const));
      if (live) setKani(Object.fromEntries(texts));
    })().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  return <BreakView key={data === null ? 'loading' : 'ready'} data={data} kani={kani} modules={modules} failed={failed} />;
}

export default BreakPage;
