// AIR-141: no tool, interpreter, quarantine, chain or server code can reach the planner. An allowlist over the import closure
// of planner.ts, an importer rule, and a self-test on in-memory sources so the failure is exercised by every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf, exportTargets, outsideOf, readFromDisk, specifiersOf } from './helpers/imports.ts';
import type { ReadSource } from './helpers/imports.ts';

const RUNTIME = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const REPO = dirname(RUNTIME);
const ALLOWED = ['planner', 'llm', 'dsl', 'money'].map((d) => join(RUNTIME, 'src', d) + '/');

// ---- specifiersOf ----
test('specifiersOf lists every import form and marks a non-literal one dynamic', () => {
  const text = [
    "import a from './a.ts';",
    "import type { B } from './b.ts';",
    "export { c } from './c.ts';",
    "export * from './d.ts';",
    "import e = require('./e.ts');",
    "const f = await import('./f.ts');",
    "const g = require('./g.ts');",
    'const h = await import(v);',
    'const i = require(w);',
  ].join('\n');
  assert.deepEqual(specifiersOf('x.ts', text), ['./a.ts', './b.ts', './c.ts', './d.ts', './e.ts', './f.ts', './g.ts', '<dynamic>', '<dynamic>']);
});

// ---- the closure rule on in-memory trees ----
const VIRTUAL_ROOT = '/v/runtime';
const vfile = (rel: string) => join(VIRTUAL_ROOT, 'src', rel);
const vAllowed = ['planner', 'llm', 'dsl', 'money'].map((d) => join(VIRTUAL_ROOT, 'src', d) + '/');
const VMAP = { llm: vfile('llm/index.ts'), dsl: vfile('dsl/index.ts'), tools: vfile('tools/index.ts') };

function tree(files: Record<string, string>): ReadSource {
  const abs = new Map(Object.entries(files).map(([rel, text]) => [vfile(rel), text]));
  return (file) => abs.get(file);
}

const CLEAN = {
  'planner/planner.ts': "import { complete } from '../llm/index.ts';\nimport { checkPlan } from '@airlock/runtime/dsl';\nimport { p } from './prompt.ts';",
  'planner/prompt.ts': "import { TOOL_NAMES } from '../dsl/index.ts';",
  'llm/index.ts': "export { x } from './client.ts';",
  'llm/client.ts': "import { u } from '../money/index.ts';",
  'dsl/index.ts': 'export const a = 1;',
  'money/index.ts': 'export const m = 1;',
};

function violations(files: Record<string, string>): string[] {
  const c = closureOf(vfile('planner/planner.ts'), tree(files), VMAP);
  return [...outsideOf(c.files, vAllowed), ...c.dynamic];
}

test('closure rule: a clean tree passes', () => {
  assert.deepEqual(violations(CLEAN), []);
});

const PLANTED: Array<[string, string]> = [
  ['an import from tools', "import { x } from '../tools/fixtures.ts';"],
  ['a re-export from tools', "export { x } from '../tools/fixtures.ts';"],
  ['an import type from the interpreter', "import type { T } from '../interpreter/types.ts';"],
  ['a dynamic import of the server', "const m = await import('../server/s.ts');"],
  ['a require of the chain', "const c = require('../chain/c.ts');"],
  ['a non-literal import', 'const m = await import(v);'],
];
for (const [name, line] of PLANTED) {
  test(`closure rule: ${name} in a planner file fails`, () => {
    const files = { ...CLEAN, 'planner/planner.ts': CLEAN['planner/planner.ts'] + '\n' + line };
    assert.notDeepEqual(violations(files), []);
  });
}

test('closure rule: a planted import in a file that llm/client.ts imports fails', () => {
  const files = { ...CLEAN, 'llm/client.ts': CLEAN['llm/client.ts'] + "\nimport { s } from './shared.ts';", 'llm/shared.ts': "import { x } from '../tools/fixtures.ts';" };
  const out = violations(files);
  assert.ok(out.some((f) => f.includes('/tools/')));
});

test('closure rule: an exports-map target outside the allowlist fails', () => {
  const files = { ...CLEAN, 'planner/planner.ts': CLEAN['planner/planner.ts'] + "\nimport { t } from '@airlock/runtime/tools';" };
  assert.ok(violations(files).some((f) => f.includes('/tools/')));
});

// ---- the real tree ----
test('the closure of the real planner.ts stays inside planner, llm, dsl and money', () => {
  const entry = join(RUNTIME, 'src/planner/planner.ts');
  assert.ok(existsSync(entry));
  const c = closureOf(entry, readFromDisk, exportTargets(RUNTIME));
  assert.deepEqual(c.dynamic, []);
  assert.deepEqual(c.unresolved, []);
  assert.deepEqual(outsideOf(c.files, ALLOWED), []);
  assert.ok(c.files.length > 5, 'the walk reached the llm and dsl files');
});

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('only runtime/src/agent.ts imports the planner, and no exports entry points at it', () => {
  const plannerDir = join(RUNTIME, 'src/planner');
  const targets = new Set([join(plannerDir, 'planner'), join(plannerDir, 'index')]);
  const roots = [join(RUNTIME, 'src'), join(REPO, 'bench/src'), join(REPO, 'web/src')];
  const offenders: string[] = [];
  for (const file of roots.flatMap(sourceFiles)) {
    if (file === join(RUNTIME, 'src/agent.ts') || file.startsWith(plannerDir + '/')) continue;
    for (const spec of specifiersOf(file, readFileSync(file, 'utf8'))) {
      if (spec === '@airlock/runtime/planner' || spec.startsWith('@airlock/runtime/planner/')) offenders.push(file);
      else if (spec.startsWith('.') && targets.has(resolve(dirname(file), spec).replace(/\.tsx?$/, ''))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
  for (const target of Object.values(exportTargets(RUNTIME))) assert.ok(!target.startsWith(plannerDir + '/'), target);
  assert.ok(!Object.keys(exportTargets(RUNTIME)).some((k) => k.startsWith('planner')));
});

test('the importer rule catches a planted planner import in a bench file', () => {
  const plannerDir = join(RUNTIME, 'src/planner');
  const file = join(REPO, 'bench/src/x.ts');
  const spec = '../../runtime/src/planner/planner.ts';
  assert.ok(resolve(dirname(file), spec).replace(/\.tsx?$/, '') === join(plannerDir, 'planner'));
});
