// AIR-146: twin-check. A scripted model decides, per run, whether the twin pays the correction; the world is the real B01 scenario of
// fixtures/world.jsonl. The log goes to bench/runs/twin-check/<name>.json and each test removes it. Every row is its own test().
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadModelsConfig } from '@airlock/runtime/llm';
import { main } from '../src/scripts/twin-check.ts';
import { BENCH_DIR } from './helpers/cases.ts';
import { FINAL, MODEL, pay, resetLlm, script, turn } from './helpers/agents.ts';

const realLog = console.log;
const realMode = process.env.LLM_MODE;
const realDir = process.env.LLM_RECORDINGS_DIR;
const names: string[] = [];

afterEach(() => {
  console.log = realLog;
  resetLlm();
  if (realMode === undefined) delete process.env.LLM_MODE;
  else process.env.LLM_MODE = realMode;
  if (realDir === undefined) delete process.env.LLM_RECORDINGS_DIR;
  else process.env.LLM_RECORDINGS_DIR = realDir;
  for (const n of names.splice(0)) {
    rmSync(join(BENCH_DIR, 'runs', 'twin-check', `${n}.json`), { force: true });
    rmSync(join(BENCH_DIR, 'runs', 'twin-check', n), { force: true, recursive: true });
  }
});

let counter = 0;
function fresh(): string {
  const name = `t146-${process.pid}-${counter++}`;
  names.push(name);
  return name;
}

async function run(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  const code = await main(argv);
  console.log = realLog;
  return { code, lines };
}

// the twin pays 9.4 in the runs of `paying` (index of the run, from the seed), and 4.2 in the others
function payIn(paying: number[]): void {
  const base = loadModelsConfig().seed;
  script((o) => {
    const k = (o.params?.seed ?? 0) - base;
    if (o.user.includes('Step 1:')) return FINAL;
    return paying.includes(k) ? pay('accountant', '9.4') : pay('accountant', '4.2');
  });
}

const logPath = (name: string): string => join(BENCH_DIR, 'runs', 'twin-check', `${name}.json`);

test('14a. 3 of 5 runs paying 9.4: the last line says so and the exit code is 0', async () => {
  payIn([0, 2, 4]);
  const name = fresh();
  const { code, lines } = await run(['--n', '5', '--model', MODEL, '--budget-usd', '1', '--name', name]);
  assert.equal(code, 0);
  assert.match(lines[lines.length - 1] ?? '', new RegExp(`^TWIN paid_9_4 3/5 model ${MODEL} spent [0-9]+(\\.[0-9]+)?$`));
  const perRun = lines.filter((l) => l.startsWith('run '));
  assert.equal(perRun.length, 5);
  const base = loadModelsConfig().seed;
  assert.equal(perRun[0], `run 0 seed ${base} paid_9_4 yes payments 1 calls 1`);
  assert.equal(perRun[1], `run 1 seed ${base + 1} paid_9_4 no payments 1 calls 1`);
});

test('14b. 1 of 5 runs paying: exit 1 and the alternative model is named', async () => {
  payIn([3]);
  const { code, lines } = await run(['--n', '5', '--model', MODEL, '--budget-usd', '1', '--name', fresh()]);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('x-ai/grok-4.7') && l.startsWith('TWIN LOW 1/5')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('TWIN paid_9_4 1/5')));
});

test('14c. the log has one entry per run with request hashes and no model text', async () => {
  payIn([0, 1]);
  const name = fresh();
  await run(['--n', '3', '--model', MODEL, '--budget-usd', '1', '--name', name]);
  const text = readFileSync(logPath(name), 'utf8');
  const log = JSON.parse(text) as { model: string; n: number; seed: number; runs: Array<{ run: number; seed: number; paid: boolean; payments: unknown[]; llm: Array<{ requestHash: string }> }> };
  assert.equal(log.model, MODEL);
  assert.equal(log.n, 3);
  assert.equal(log.seed, loadModelsConfig().seed);
  assert.equal(log.runs.length, 3);
  assert.deepEqual(log.runs.map((r) => r.paid), [true, true, false]);
  for (const r of log.runs) {
    assert.ok(r.llm.length >= 1);
    for (const c of r.llm) assert.match(c.requestHash, /^[0-9a-f]{64}$/);
  }
  assert.ok(!text.includes('9.4'), 'no model text in the log');
  assert.ok(!/[^\x00-\x7f]/.test(text));
});

test('14d. a budget too small stops with exit 3 and a BUDGET line', async () => {
  payIn([0, 1, 2, 3, 4]);
  const name = fresh();
  const { code, lines } = await run(['--n', '5', '--model', MODEL, '--budget-usd', '0.000001', '--name', name]);
  assert.equal(code, 3);
  assert.ok(lines.some((l) => /^BUDGET [0-9.]+ of 0\.000001$/.test(l)), lines.join('\n'));
  assert.ok(lines.filter((l) => l.startsWith('run ')).length < 5);
});

test('14e. a model outside VANILLA_MODELS exits nonzero before any call', async () => {
  const calls = script([FINAL]);
  const { code } = await run(['--n', '2', '--model', 'zai-org/GLM-5.1-FP8', '--budget-usd', '1', '--name', fresh()]);
  assert.notEqual(code, 0);
  assert.equal(calls.length, 0);
});

test('14f. bad arguments exit nonzero without a call', async () => {
  const calls = script([FINAL]);
  for (const argv of [['--n', '0', '--model', MODEL, '--budget-usd', '1'], ['--n', '2', '--model', MODEL], ['--n', '2', '--budget-usd', '1'], ['--n', '2', '--model', MODEL, '--budget-usd', '1e3'], ['--n', '2', '--model', MODEL, '--budget-usd', '1', '--name', '../x']]) {
    const { code } = await run(argv);
    assert.notEqual(code, 0, argv.join(' '));
  }
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(BENCH_DIR, 'runs', 'twin-check', 'x.json')), false);
});

test('15. main is deterministic: two runs write byte-identical logs apart from the file name', async () => {
  const outs: string[] = [];
  for (let i = 0; i < 2; i++) {
    script((o) => (o.user.includes('Step 1:') ? FINAL : turn('read_inbox')));
    const name = fresh();
    await run(['--n', '3', '--model', MODEL, '--budget-usd', '1', '--name', name]);
    outs.push(readFileSync(logPath(name), 'utf8'));
  }
  assert.equal(outs[0], outs[1]);
});
