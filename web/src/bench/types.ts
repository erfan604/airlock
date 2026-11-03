// AIR-192: the shape of web/public/bench.json, written by bench/src/scripts/web-bench-json.ts from the same function that prints docs/BENCH.md.
// Every string is shown as text; the numbers (`k`, `n`, `p`, `lo`, `hi`) only place a marker. Nothing is computed here.
export type Row = { k: number; n: number; p: number; lo: number; hi: number };
export type Kind = 'attack' | 'intent' | 'tap' | 'plain';
export type TableRow = { cells: string[]; whiskers: (Row | null)[] };
export type Table = { title: string; note: string | null; head: string[]; kinds: (Kind | null)[]; rows: TableRow[] };
export type Dot = { text: string; row: Row };
export type CompareRow = { config: string; note: string | null; attack: Dot; itself: Dot; assisted: Dot };
export type Residual = { text: string; cases: { id: string; k: number; n: number; strict: number }[] };
export type BenchData = {
  draft: boolean;
  header: string;
  compare: CompareRow[];
  attack: Table;
  benign: Table;
  completion: Table[];
  outcomes: Table;
  owner: Table;
  gaps: Table | null;
  residual: Residual | null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isRow = (v: unknown): v is Row => isObj(v) && isNum(v['k']) && isNum(v['n']) && isNum(v['p']) && isNum(v['lo']) && isNum(v['hi']);
const isDot = (v: unknown): v is Dot => isObj(v) && isStr(v['text']) && isRow(v['row']);
const KINDS = ['attack', 'intent', 'tap', 'plain'];

function isTable(v: unknown): v is Table {
  if (!isObj(v) || !isStr(v['title']) || !(v['note'] === null || isStr(v['note']))) return false;
  const head = v['head'];
  const kinds = v['kinds'];
  const rows = v['rows'];
  if (!Array.isArray(head) || !head.every(isStr) || !Array.isArray(kinds) || kinds.length !== head.length || !Array.isArray(rows)) return false;
  if (!kinds.every((k) => k === null || (isStr(k) && KINDS.includes(k)))) return false;
  return rows.every((r) => isObj(r) && Array.isArray(r['cells']) && r['cells'].length === head.length && r['cells'].every(isStr) && Array.isArray(r['whiskers']) && r['whiskers'].length === head.length && r['whiskers'].every((w) => w === null || isRow(w)));
}

/** The data when `raw` has the shape above, else null: a malformed file shows the empty state, never zeros. */
export function parseBench(raw: unknown): BenchData | null {
  if (!isObj(raw) || typeof raw['draft'] !== 'boolean' || !isStr(raw['header'])) return null;
  const { compare, completion, gaps, residual } = raw;
  if (!Array.isArray(compare) || !compare.every((c) => isObj(c) && isStr(c['config']) && (c['note'] === null || isStr(c['note'])) && isDot(c['attack']) && isDot(c['itself']) && isDot(c['assisted']))) return null;
  if (!Array.isArray(completion) || !completion.every(isTable)) return null;
  if (!isTable(raw['attack']) || !isTable(raw['benign']) || !isTable(raw['outcomes']) || !isTable(raw['owner'])) return null;
  if (!(gaps === null || isTable(gaps))) return null;
  if (!(residual === null || (isObj(residual) && isStr(residual['text'])))) return null;
  return raw as unknown as BenchData;
}

/** Fetches the bench file from the page's own origin. Any failure, a non-200 status or a malformed body gives null. */
export async function loadBench(fetchFn: typeof fetch = fetch): Promise<BenchData | null> {
  try {
    const res = await fetchFn('/bench.json');
    if (!res.ok) return null;
    return parseBench((await res.json()) as unknown);
  } catch {
    return null;
  }
}
