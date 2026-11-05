// AIR-311: the landing's numbers, read from bench.json (the file the Bench page shows, written from the same tables as docs/BENCH.md). Every
// number is a cell of that file or the difference of two of its counts; when a cell is missing the fact is null and the band is not drawn,
// so the page never shows a number the bench did not produce.
import type { BenchData, Table } from '../bench/types.ts';

export type Count = { k: string; n: string };
export type Facts = {
  model: string;
  /** V0 runs where the attacker was paid, and how many of them paid a payee already in the owner's book */
  unguardedPaid: Count;
  bookedOfPaid: Count;
  strict: Count;
  dflt: Count;
  residualCase: string | null;
  residualRuns: string | null;
  /** benign payment tasks (read-only tasks left out): done with no owner tap, done after one tap, and failed, per mode */
  payTasks: string;
  honestAlone: Count;
  honestTapped: Count;
  honestFailed: Count;
  strictAlone: Count;
  strictTapped: Count;
};

const COUNT = /^([0-9]+)\/([0-9]+)\b/;
const count = (cell: string | undefined): Count | null => {
  const m = cell === undefined ? null : COUNT.exec(cell);
  return m === null ? null : { k: m[1] as string, n: m[2] as string };
};

function cell(t: Table, config: string, column: string, group?: string): string | undefined {
  const c = t.head.indexOf(column);
  const g = t.head.indexOf('Group');
  if (c < 0) return undefined;
  return t.rows.find((r) => r.cells[0] === config && (group === undefined || r.cells[g] === group))?.cells[c];
}

export function factsOf(d: BenchData): Facts | null {
  const b = d.breakdown;
  if (b === undefined || b === null) return null;
  const paid = count(cell(b, 'V0', 'Attacker paid'));
  const outside = count(cell(b, 'V0', 'Paid an address outside the book'));
  const strict = count(cell(d.attack, 'A1', 'Attack success, auto', 'ALL'));
  const dflt = count(cell(d.attack, 'A2', 'Attack success, auto', 'ALL'));
  // the payment tasks only: the read-only benign tasks propose no payment, so they say nothing about holds (README, Results)
  const pay = d.completion.find((t) => t.title.startsWith('Benign payment tasks only'));
  const alone = pay === undefined ? null : count(cell(pay, 'A2', 'Completed by itself'));
  const tapped = pay === undefined ? null : count(cell(pay, 'A2', 'Completed after one owner tap'));
  const failed = pay === undefined ? null : count(cell(pay, 'A2', 'Failed'));
  const strictAlone = pay === undefined ? null : count(cell(pay, 'A1', 'Completed by itself'));
  const strictTapped = pay === undefined ? null : count(cell(pay, 'A1', 'Completed after one owner tap'));
  const model = /^model ([^,]+),/.exec(d.header)?.[1];
  if (paid === null || outside === null || strict === null || dflt === null || alone === null || tapped === null || failed === null || strictAlone === null || strictTapped === null || model === undefined) return null;
  if (paid.n !== outside.n) return null;
  const booked = BigInt(paid.k) - BigInt(outside.k);
  const residual = d.residual?.cases.length === 1 ? d.residual.cases[0] : undefined;
  return {
    model,
    unguardedPaid: paid,
    bookedOfPaid: { k: booked.toString(), n: paid.k },
    strict,
    dflt,
    residualCase: residual?.id ?? null,
    residualRuns: residual === undefined ? null : String(residual.k),
    payTasks: alone.n,
    honestAlone: alone,
    honestTapped: tapped,
    honestFailed: failed,
    strictAlone,
    strictTapped,
  };
}
