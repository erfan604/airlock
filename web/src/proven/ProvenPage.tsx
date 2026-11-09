// AIR-302: the /proven route. It renders docs/proven.json, the same file that docs/PROVEN.md and `pnpm proven` come from, so the three cannot drift
// (web/test/proven.test.tsx asserts it). Static text only: no network, no wallet, no untrusted input.
import source from '../../../docs/proven.json';
import { plain } from '../components/plain.ts';

type Proof = { kind: 'lean' | 'kani' | 'diff'; name: string; file?: string };
type Entry = { id: string; says: string; notCovered: string; bound: string; files: string[]; claims: string[]; proofs: Proof[] };
type Source = { title: string; lead: string; command: string; estimateMinutes: number; notCovered: string[]; entries: Entry[] };

const SRC = source as Source;
const KIND_LABEL = { lean: 'Lean theorems', kani: 'Kani harnesses', diff: 'Differential test' } as const;

function Checked({ proofs }: { proofs: Proof[] }) {
  return (
    <>
      {(['lean', 'kani', 'diff'] as const).map((k) => {
        const names = proofs.filter((p) => p.kind === k).map((p) => p.name);
        return names.length === 0 ? null : (
          <p key={k} className="proven-proofs">
            <span className="proven-key">{KIND_LABEL[k]}</span> {names.map((n) => (
              <code key={n} className="proven-name">{n}</code>
            ))}
          </p>
        );
      })}
    </>
  );
}

export function ProvenPage({ data = SRC }: { data?: Source }) {
  const n = data.entries.length;
  return (
    <main className="page proven" data-testid="proven">
      <h1 className="proven-title">{data.title}</h1>
      <p className="proven-lede">{plain(data.lead)}</p>
      <p className="proven-recheck" data-testid="proven-recheck">
        Recheck: <code>{data.command}</code> (about {data.estimateMinutes} minutes). It prints one line per entry below and ends with <code>{`PROVEN OK ${n} of ${n}`}</code>.
      </p>
      <section aria-labelledby="proven-not-title" className="proven-block">
        <h2 id="proven-not-title" className="proven-h2">What this does not cover</h2>
        <ul className="proven-list" data-testid="proven-not-covered">
          {data.notCovered.map((t) => (
            <li key={t}>{plain(t)}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="proven-is-title" className="proven-block">
        <h2 id="proven-is-title" className="proven-h2">What is proven</h2>
        <ol className="proven-entries" data-testid="proven-entries">
          {data.entries.map((e) => (
            <li key={e.id} className="proven-entry" data-testid={`proven-entry-${e.id}`}>
              <h3 className="proven-says">{plain(e.says)}</h3>
              <Checked proofs={e.proofs} />
              <p className="proven-meta"><span className="proven-key">Bound</span> {plain(e.bound)}</p>
              <p className="proven-meta"><span className="proven-key">Not covered</span> {plain(e.notCovered)}</p>
              <p className="proven-meta"><span className="proven-key">Files</span> {e.files.join(', ')}</p>
              <p className="proven-meta"><span className="proven-key">Claims</span> {e.claims.join(', ')}</p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
