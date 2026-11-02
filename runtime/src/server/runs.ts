// The run store (AIR-163): an in-memory map plus one file per run, `<dataDir>/runs/<id>.json`, written atomically (temp file, then rename)
// on every state change and at the end, for the replay demo. It also holds the set of task ids that were ever confirmed, persisted in
// `<dataDir>/task-ids.json`, so a restart does not make a spent id usable again. It implements the event source of the SSE route.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceEvent } from '../interpreter/trace.ts';
import type { RunEventSource } from './sse.ts';
import type { RunState } from './state.ts';

export interface RunRecord {
  id: string;
  owner: string;
  state: RunState;
  planSha256: string;
  taskHash: string | null;
  events: TraceEvent[];
  error: string | null;
}

/** What GET /runs/:id answers: the record without its owner, and the last 300 events. */
export type RunView = Omit<RunRecord, 'owner'>;

export const VIEW_EVENTS = 300;

// the id is a path part: never anything but the 32 lowercase hex characters (or a short test id of the same alphabet) reaches a file name
const SAFE_ID = /^[0-9a-zA-Z_-]{1,64}$/;

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

export class RunStore implements RunEventSource {
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Map<string, Set<(e: TraceEvent) => void>>();
  private readonly taskIds: Set<string>;
  private readonly runsDir: string;
  private readonly idsFile: string;

  constructor(opts: { dataDir?: string } = {}) {
    const dataDir = opts.dataDir ?? 'runtime/data';
    this.runsDir = join(dataDir, 'runs');
    this.idsFile = join(dataDir, 'task-ids.json');
    mkdirSync(this.runsDir, { recursive: true });
    this.taskIds = new Set();
    if (existsSync(this.idsFile)) {
      // fail closed: a file that does not parse stops the server instead of forgetting the spent ids
      const parsed: unknown = JSON.parse(readFileSync(this.idsFile, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) throw new Error('task-ids.json is not a list of strings');
      for (const id of parsed as string[]) this.taskIds.add(id);
    }
  }

  create(rec: RunRecord): void {
    if (this.runs.has(rec.id)) throw new Error('run id already exists');
    if (!SAFE_ID.test(rec.id)) throw new RangeError('run id is not a file name part');
    this.runs.set(rec.id, { ...rec, events: [...rec.events] });
    this.persist(rec.id);
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  append(id: string, e: TraceEvent): void {
    const rec = this.runs.get(id);
    if (rec === undefined) return;
    rec.events.push(e);
    for (const cb of [...(this.listeners.get(id) ?? [])]) cb(e);
  }

  setState(id: string, state: RunState, error?: string): void {
    const rec = this.runs.get(id);
    if (rec === undefined) return;
    rec.state = state;
    if (error !== undefined) rec.error = error;
    this.persist(id);
  }

  setPlanSha256(id: string, planSha256: string): void {
    const rec = this.runs.get(id);
    if (rec !== undefined) rec.planSha256 = planSha256;
  }

  setTaskHash(id: string, taskHash: string): void {
    const rec = this.runs.get(id);
    if (rec !== undefined) rec.taskHash = taskHash;
  }

  viewOf(rec: RunRecord): RunView {
    return { id: rec.id, state: rec.state, planSha256: rec.planSha256, taskHash: rec.taskHash, events: rec.events.slice(-VIEW_EVENTS), error: rec.error };
  }

  /** Marks a task id as used and writes the set before returning; false when it was used before. A write failure throws and marks nothing. */
  useTaskId(taskId: string): boolean {
    if (this.taskIds.has(taskId)) return false;
    writeAtomic(this.idsFile, JSON.stringify([...this.taskIds, taskId]));
    this.taskIds.add(taskId);
    return true;
  }

  taskIdUsed(taskId: string): boolean {
    return this.taskIds.has(taskId);
  }

  // ---- RunEventSource ----
  replay(id: string): TraceEvent[] | null {
    const rec = this.runs.get(id);
    return rec === undefined ? null : [...rec.events];
  }

  subscribe(id: string, cb: (e: TraceEvent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    this.listeners.set(id, set);
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  stateOf(id: string): string | null {
    return this.runs.get(id)?.state ?? null;
  }

  private persist(id: string): void {
    const rec = this.runs.get(id);
    if (rec === undefined || !SAFE_ID.test(id)) return;
    writeAtomic(join(this.runsDir, `${id}.json`), JSON.stringify(rec));
  }
}
