// The recorded engine (AIR-301 selftest, and the board before the live parts are switched on): the bench's own run path, the production
// planner, analyzer, orchestrator and the contract's verdict function behind the verdict CLI, with every model answer read from the committed
// recordings and no network. It runs a bench case, never a visitor's text. Model answers are found by the exact request hash first. The
// extractor prompt changed after the recordings were made (AIR-297, one added line), so its calls no longer hash the same: those are found by
// the recorded request's role, user text and schema field names instead, and `contentMatched` counts them. Everything downstream of the model
// (validators, labels, interpreter, task bounds, the verdict) is the current code.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NoRecording, readRecording, requestHashOf, setLlmOverride } from '@airlock/runtime/llm';
import type { LlmOpts, LlmResult } from '@airlock/runtime/llm';
import { BenchSession } from '../../../bench/src/runner/run.ts';
import { VerdictCliBackend } from '../../../bench/src/runner/backend.ts';
import { loadCases } from '../../../bench/src/runner/cases.ts';
import type { Case } from '../../../bench/src/runner/cases.ts';
import { defaultDeps } from '../../../bench/src/cli.ts';
import { resolveHooks } from '../../../bench/src/runner/hooks.ts';
import type { Engine, EngineOutput, PaymentRow } from '../types.ts';

const SEP = '\u0000';

/**
 * The cases the committed recordings cover: the bench's own cases that have recorded model output. The AIR-306 baseline cases are marked
 * `pending_recording` and the CrAIBench cases are not `own`; neither has a recording in `bench/runs/recorded`, so replaying them throws NoRecording.
 * The selftest and the board seeding both use this one list.
 */
export function recordedCases(root: string): Case[] {
  return loadCases(join(root, 'bench', 'cases')).filter((c) => c.source_id['pending_recording'] !== true && c.source === 'own');
}

const fieldsOf = (schema: unknown): string => {
  const props = (schema as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  return props === undefined ? '' : Object.keys(props).sort().join(',');
};

export interface RecordedModel {
  install(): void;
  uninstall(): void;
  /** answers found by the exact request hash / by content */
  stats(): { exact: number; contentMatched: number };
}

/** An LLM override that answers from `dir` and throws NoRecording for anything it has not recorded: it cannot reach the network. */
export function recordedModel(dir: string): RecordedModel {
  const byContent = new Map<string, string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { requestHash: string; request: { role: string; user: string; schema: unknown } };
    const key = [rec.request.role, rec.request.user, fieldsOf(rec.request.schema)].join(SEP);
    if (!byContent.has(key)) byContent.set(key, rec.requestHash);
  }
  let exact = 0;
  let contentMatched = 0;
  const answer = async (o: LlmOpts): Promise<LlmResult> => {
    const direct = await readRecording(dir, requestHashOf(o));
    if (direct !== null) {
      exact += 1;
      return direct;
    }
    const hash = byContent.get([o.role, o.user, fieldsOf(o.jsonSchema)].join(SEP));
    const found = hash === undefined ? null : await readRecording(dir, hash);
    if (found === null) throw new NoRecording(requestHashOf(o), o.role, o.model);
    contentMatched += 1;
    return found;
  };
  return {
    install: () => setLlmOverride(answer),
    uninstall: () => setLlmOverride(null),
    stats: () => ({ exact, contentMatched }),
  };
}

/** The error code that ended a run that submitted nothing (the last `error` event of its trace), else null. */
function stoppedByOf(trace: readonly { kind: string; data?: unknown }[]): string | null {
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const e = trace[i];
    if (e?.kind === 'error') {
      const code = (e.data as { code?: unknown } | undefined)?.code;
      return typeof code === 'string' ? code.slice(0, 64) : 'Error';
    }
  }
  return null;
}

export interface RecordedEngineOptions {
  cases: readonly Case[];
  /** the verdict CLI binary; the caller has checked that it exists (this engine never builds it) */
  verdictCli: string;
  /** the planner and quarantine model of the recording (bench/results meta) */
  model: string;
  /** defaults to `model` */
  quarantineModel?: string;
  temperature: number;
  seed: number;
  config?: 'A1' | 'A2';
}

export class RecordedEngine implements Engine {
  readonly mode = 'recorded' as const;
  private session: BenchSession | undefined;

  constructor(private readonly o: RecordedEngineOptions) {}

  private async open(): Promise<BenchSession> {
    if (this.session !== undefined) return this.session;
    const hooks = await resolveHooks('none');
    const deps = { ...defaultDeps(), backendFactory: () => new VerdictCliBackend({ cli: this.o.verdictCli }) };
    this.session = new BenchSession({
      cases: this.o.cases,
      model: this.o.model,
      quarantineModel: this.o.quarantineModel ?? this.o.model,
      temperature: this.o.temperature,
      seed: this.o.seed,
      hooksName: 'none',
      hooks,
      deps,
    });
    return this.session;
  }

  run(): Promise<EngineOutput> {
    return Promise.reject(new Error('the recorded engine runs bench cases only'));
  }

  /** One bench case through the real path; `run` is the recorded run index (0). */
  async runCase(c: Case, run = 0): Promise<EngineOutput> {
    const session = await this.open();
    const done = await session.execute(c, this.o.config ?? 'A2', run);
    if (done.thrown !== undefined) throw done.thrown;
    const book = new Set(c.world.book.map((b) => b.key));
    const payments: PaymentRow[] = done.record.payments.map((p) => ({
      payee: p.payee,
      asset: p.asset,
      amount: p.amount,
      outcome: p.outcome,
      reason: p.reason,
      toBook: book.has(p.payee),
    }));
    return {
      status: done.record.status === 'DONE' || done.record.status === 'NO_PLAN' || done.record.status === 'NO_TASK' ? done.record.status : 'ERROR',
      payments,
      stoppedBy: payments.length === 0 ? stoppedByOf(done.transcript.trace as unknown as { kind: string; data?: unknown }[]) : null,
      tx: null,
      costUsd: '0',
    };
  }

  async close(): Promise<void> {
    await this.session?.close();
    this.session = undefined;
  }
}
