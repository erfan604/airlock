// The `.raw` ban (AIR-184): outsider text sits in the `raw` field of a trace event, and only the trace store and the Specimen may read a
// property of that name. The Node API lints the text as the file named, against the real config (as lint.test.ts does).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: webRoot });

async function ruleIds(code: string, file: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: `${webRoot}${file}` });
  assert.ok(res);
  assert.deepEqual(
    res.messages.filter((m) => m.fatal),
    [],
    'parse error',
  );
  return res.messages.map((m) => m.ruleId ?? 'parse');
}

const BAD = 'export const X = ({ e }) => <div>{e.data.raw}</div>;\n';

test('lint: reading .raw in src/task/Bad.tsx is an error', async () => {
  assert.ok((await ruleIds(BAD, 'src/task/Bad.tsx')).includes('no-restricted-syntax'));
});

test('lint: reading .raw anywhere else under src is an error too', async () => {
  for (const file of ['src/components/Other.tsx', 'src/approvals/Other.tsx', 'src/fixtures/x.tsx', 'src/x.tsx']) {
    assert.ok((await ruleIds(BAD, file)).includes('no-restricted-syntax'), file);
  }
});

test('lint: the same read is allowed as src/task/traceStore.ts and as src/components/Specimen.tsx', async () => {
  // a .ts file does not parse JSX, so the traceStore.ts case reads the same property without the element around it
  assert.deepEqual(await ruleIds('export const X = ({ e }) => e.data.raw;\n', 'src/task/traceStore.ts'), []);
  assert.deepEqual(await ruleIds(BAD, 'src/components/Specimen.tsx'), []);
});

test('lint: clean text has no error in src/task', async () => {
  assert.deepEqual(await ruleIds('export const X = ({ e }) => <div>{e.data.kind}</div>;\n', 'src/task/Good.tsx'), []);
});

test('lint: the HTML sinks stay banned in the two files allowed to read .raw', async () => {
  assert.ok((await ruleIds('el.innerHTML = x;\n', 'src/task/traceStore.ts')).includes('no-restricted-syntax'));
  assert.ok((await ruleIds('el.innerHTML = x;\n', 'src/components/Specimen.tsx')).includes('no-restricted-syntax'));
});

test('lint: Number(, parseInt and parseFloat are errors in src/task, and allowed elsewhere', async () => {
  for (const code of ['export const a = Number(x);\n', 'export const a = parseInt(x);\n', 'export const a = parseFloat(x);\n']) {
    assert.ok((await ruleIds(code, 'src/task/money.ts')).includes('no-restricted-syntax'), code);
    assert.ok((await ruleIds(code, 'src/task/traceStore.ts')).includes('no-restricted-syntax'), `traceStore: ${code}`);
    assert.deepEqual(await ruleIds(code, 'src/chain/other.ts'), [], `outside src/task: ${code}`);
  }
});
