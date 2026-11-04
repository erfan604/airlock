// The HTML-sink ban and the Untrusted import rules (AIR-183), checked through the ESLint Node API against the real config.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: webRoot });

async function ruleIds(code: string, file: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: `${webRoot}${file}` });
  assert.ok(res);
  const fatal = res.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], 'parse error');
  return res.messages.map((m) => m.ruleId ?? 'parse');
}

test('lint: innerHTML assignment is an error from no-restricted-syntax', async () => {
  assert.ok((await ruleIds('el.innerHTML = x;\n', 'src/x.tsx')).includes('no-restricted-syntax'));
});

test('lint: dangerouslySetInnerHTML is an error from no-restricted-syntax', async () => {
  const code = 'export const A = ({ x }: { x: string }) => <div dangerouslySetInnerHTML={{ __html: x }} />;\n';
  assert.ok((await ruleIds(code, 'src/x.tsx')).includes('no-restricted-syntax'));
});

test('lint: outerHTML, insertAdjacentHTML and document.write are errors too', async () => {
  for (const code of ['el.outerHTML = x;\n', 'el.insertAdjacentHTML("beforeend", x);\n', 'document.write(x);\n']) {
    assert.ok((await ruleIds(code, 'src/x.ts')).includes('no-restricted-syntax'), code);
  }
});

test('lint: clean text has no error', async () => {
  const code = 'export const A = ({ x }: { x: string }) => <pre>{x}</pre>;\n';
  assert.deepEqual(await ruleIds(code, 'src/x.tsx'), []);
});

test('lint: wrapUntrusted is allowed only in the evidence parser, the trace store and fixtures', async () => {
  const code = "import { wrapUntrusted } from '../components/untrusted.ts';\nexport const w = wrapUntrusted;\n";
  assert.ok((await ruleIds(code, 'src/components/Other.tsx')).includes('no-restricted-imports'));
  assert.ok((await ruleIds(code, 'src/approvals/other.ts')).includes('no-restricted-imports'));
  assert.deepEqual(await ruleIds(code, 'src/approvals/evidence.ts'), []);
  assert.deepEqual(await ruleIds(code, 'src/task/traceStore.ts'), []);
  assert.ok((await ruleIds(code, 'src/challenge/ChallengeView.tsx')).includes('no-restricted-imports'));
  assert.deepEqual(await ruleIds(code, 'src/challenge/model.ts'), []);
  assert.deepEqual(await ruleIds(code, 'src/try/model.ts'), []);
  assert.ok((await ruleIds(code, 'src/try/TryPage.tsx')).includes('no-restricted-imports'));
  assert.deepEqual(await ruleIds(code, 'src/fixtures/x.tsx'), []);
});

test('lint: revealUntrusted is allowed only in Specimen.tsx', async () => {
  const code = "import { revealUntrusted } from './untrusted.ts';\nexport const r = revealUntrusted;\n";
  assert.ok((await ruleIds(code, 'src/components/Other.tsx')).includes('no-restricted-imports'));
  assert.ok((await ruleIds(code, 'src/fixtures/x.tsx')).includes('no-restricted-imports'));
  assert.deepEqual(await ruleIds(code, 'src/components/Specimen.tsx'), []);
});

test('lint: a re-export of either function is refused as well', async () => {
  const code = "export { wrapUntrusted, revealUntrusted } from './untrusted.ts';\n";
  assert.ok((await ruleIds(code, 'src/components/index.ts')).includes('no-restricted-imports'));
});
