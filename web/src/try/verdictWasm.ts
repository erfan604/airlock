// AIR-311: the verdict of the NEAR contract, run in the browser. web/public/verdict.wasm is contracts/airlock-verdict-wasm built for
// wasm32-unknown-unknown (scripts/build-verdict-wasm.sh; a test checks the committed file equals a fresh build). It wraps
// `airlock_verdict::verdict` and nothing else: the caller writes the 21 columns of one case (the column order of the diff driver and of
// fixtures/verdict-vectors.lines) as little-endian u128 values and reads back one code. Amounts stay BigInt end to end.
import { url } from '../static.ts';

/** `Reason` of contracts/airlock-verdict/src/lib.rs, in the order of `ALL_REASONS`: the code's low byte is an index into this list. */
export const REASONS = [
  'UnknownAsset',
  'Paused',
  'AmountOutOfBounds',
  'DailyLimit',
  'FeeTooHigh',
  'MissingProvenance',
  'BookLabelNotInBook',
  'OutsideTask',
  'OverTaskBound',
  'UntrustedTrigger',
  'UntrustedRecipient',
  'NewRecipient',
  'OverPayeeLimit',
  'UntrustedAmount',
  'PendingFull',
  'EscalationsLocked',
  'EscalationBudget',
] as const;
export type ReasonName = (typeof REASONS)[number];

export type WasmVerdict = { kind: 'allow' } | { kind: 'escalate'; reason: ReasonName } | { kind: 'block'; reason: ReasonName } | { kind: 'malformed' };

export const COLUMNS = 21;
const U128_MAX = (1n << 128n) - 1n;

/** The code `run` returns, as a verdict. A code outside the table is malformed: it is never read as an allow. */
export function verdictOfCode(code: number): WasmVerdict {
  if (code === 0) return { kind: 'allow' };
  const reason = REASONS[code & 0xff];
  if (reason !== undefined && code >> 8 === 1) return { kind: 'escalate', reason };
  if (reason !== undefined && code >> 8 === 2) return { kind: 'block', reason };
  return { kind: 'malformed' };
}

/** The tag of the shared vector files: `allow`, `escalate:<Reason>`, `block:<Reason>` or `error:malformed`. */
export function tagOf(v: WasmVerdict): string {
  return v.kind === 'allow' ? 'allow' : v.kind === 'malformed' ? 'error:malformed' : `${v.kind}:${v.reason}`;
}

export type VerdictModule = { decide(columns: readonly bigint[]): WasmVerdict };

type Exports = { memory: WebAssembly.Memory; input_ptr(): number; run(): number };

/** Instantiates the module from its bytes. It imports nothing; any other export shape is refused. */
export async function instantiateVerdict(bytes: BufferSource): Promise<VerdictModule> {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports as Partial<Exports>;
  if (!(ex.memory instanceof WebAssembly.Memory) || typeof ex.input_ptr !== 'function' || typeof ex.run !== 'function') throw new Error('verdict.wasm has an unexpected shape');
  const { memory, input_ptr, run } = ex as Exports;
  return {
    decide(columns) {
      if (columns.length !== COLUMNS) return { kind: 'malformed' };
      const view = new DataView(memory.buffer, input_ptr(), COLUMNS * 16);
      for (let i = 0; i < COLUMNS; i++) {
        const v = columns[i] as bigint;
        if (v < 0n || v > U128_MAX) return { kind: 'malformed' };
        view.setBigUint64(i * 16, v & 0xffff_ffff_ffff_ffffn, true);
        view.setBigUint64(i * 16 + 8, v >> 64n, true);
      }
      return verdictOfCode(run());
    },
  };
}

let loading: Promise<VerdictModule> | null = null;

/** The page's module, fetched once from its own origin. A failed load is not cached, so a retry fetches again. */
export function loadVerdict(fetchFn: typeof fetch = fetch): Promise<VerdictModule> {
  if (loading === null) {
    loading = (async () => {
      const res = await fetchFn(url('verdict.wasm'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`verdict.wasm: ${String(res.status)}`);
      return instantiateVerdict(await res.arrayBuffer());
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
