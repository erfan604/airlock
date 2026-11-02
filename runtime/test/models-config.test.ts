// AIR-144: the models config loader. Cases edit an in-memory copy of the committed file and write it to a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelsConfigError, TEE_MODELS, loadModelsConfig } from '../src/llm/index.ts';

const COMMITTED = fileURLToPath(new URL('../config/models.json', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'models-config-'));
let counter = 0;

type Raw = Record<string, unknown>;
const base = (): Raw => JSON.parse(readFileSync(COMMITTED, 'utf8')) as Raw;

function write(edit: (raw: Raw) => void): string {
  const raw = base();
  edit(raw);
  const path = join(DIR, `c${counter++}.json`);
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

const rejects = (edit: (raw: Raw) => void, key?: string) => {
  const path = write(edit);
  assert.throws(
    () => loadModelsConfig(path),
    (e: unknown) => e instanceof ModelsConfigError && (key === undefined || e.message.includes(key)),
  );
};
const loads = (edit: (raw: Raw) => void) => assert.doesNotThrow(() => loadModelsConfig(write(edit)));

test('the committed file loads, and its planner is in TEE_MODELS and in vanilla', () => {
  const c = loadModelsConfig(COMMITTED);
  assert.ok((TEE_MODELS as readonly string[]).includes(c.planner));
  assert.ok(c.vanilla.includes(c.planner));
});

test('a missing key throws', () => rejects((r) => delete r.seed, 'seed'));
test('an extra top-level key throws', () => rejects((r) => (r.extra = 1)));
test('an extra evidence key throws', () => rejects((r) => ((r.evidence as Raw).extra = 'x')));

for (const role of ['planner', 'quarantine'] as const) {
  test(`${role} set to a vanilla-only model throws`, () => rejects((r) => (r[role] = 'x-ai/grok-4.7'), role));
  test(`${role} set to a non-allowlisted id throws`, () => rejects((r) => (r[role] = 'zai-org/GLM-5.1-FP8'), role));
}

test('vanilla without the planner id throws', () => rejects((r) => (r.vanilla = ['x-ai/grok-4.7']), 'vanilla'));
test('an empty vanilla throws', () => rejects((r) => (r.vanilla = []), 'vanilla'));
test('a vanilla id outside VANILLA_MODELS throws', () => rejects((r) => (r.vanilla = [r.planner, 'nobody/model']), 'vanilla'));

for (const t of [0, 1.5, '0.7']) test(`temperature ${JSON.stringify(t)} throws`, () => rejects((r) => (r.temperature = t), 'temperature'));
for (const t of [0.7, 1]) test(`temperature ${t} loads`, () => loads((r) => (r.temperature = t)));

for (const v of ['medium', 'none']) test(`reasoning ${v} throws`, () => rejects((r) => (r.reasoning = v), 'reasoning'));
test('a missing reasoning key throws', () => rejects((r) => delete r.reasoning, 'reasoning'));
for (const v of ['default', 'low']) test(`reasoning ${v} loads`, () => loads((r) => (r.reasoning = v)));

for (const s of [-1, 1.5, 1000000001]) test(`seed ${s} throws`, () => rejects((r) => (r.seed = s), 'seed'));
test('seed 20261101 loads', () => loads((r) => (r.seed = 20261101)));

test('decided_on 2026-13-01x throws', () => rejects((r) => (r.decided_on = '2026-13-01x'), 'decided_on'));
test('a 63-character hash throws', () => rejects((r) => ((r.evidence as Raw).results_sha256 = 'a'.repeat(63)), 'results_sha256'));
test('an uppercase hash throws', () => rejects((r) => ((r.evidence as Raw).decision_sha256 = 'A'.repeat(64)), 'decision_sha256'));
test('a bad spend_usd throws', () => rejects((r) => ((r.evidence as Raw).spend_usd = '$2'), 'spend_usd'));

test('the error message of a bad planner names planner and not the id', () => {
  const path = write((r) => (r.planner = 'secret/bad-id'));
  try {
    loadModelsConfig(path);
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ModelsConfigError);
    assert.ok(e.message.includes('planner'));
    assert.ok(!e.message.includes('secret/bad-id'));
  }
});

test('loadModelsConfig twice returns the same object; a missing file throws', () => {
  assert.equal(loadModelsConfig(), loadModelsConfig());
  assert.throws(() => loadModelsConfig('/nonexistent/x.json'), ModelsConfigError);
});

test('the default path is independent of the working directory', () => {
  const cwd = process.cwd();
  const expected = loadModelsConfig(COMMITTED);
  try {
    process.chdir(mkdtempSync(join(tmpdir(), 'models-cwd-')));
    assert.deepEqual(loadModelsConfig(), expected);
  } finally {
    process.chdir(cwd);
  }
});

test('AIRLOCK_MODELS_CONFIG switches configs inside one process', () => {
  const low = write((r) => (r.reasoning = 'low'));
  const def = write((r) => (r.reasoning = 'default'));
  const saved = process.env.AIRLOCK_MODELS_CONFIG;
  try {
    process.env.AIRLOCK_MODELS_CONFIG = low;
    assert.equal(loadModelsConfig().reasoning, 'low');
    process.env.AIRLOCK_MODELS_CONFIG = def;
    assert.equal(loadModelsConfig().reasoning, 'default');
  } finally {
    if (saved === undefined) delete process.env.AIRLOCK_MODELS_CONFIG;
    else process.env.AIRLOCK_MODELS_CONFIG = saved;
  }
});
