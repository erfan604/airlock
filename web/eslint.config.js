// ESLint flat config (AIR-183). Two jobs beyond the typescript-eslint recommended set, both only for code under src/:
// 1. the HTML-sink ban: nothing in the console writes markup, outsider text reaches the DOM only as a React text node;
// 2. the Untrusted boundary: `wrapUntrusted` (text enters the type) and `revealUntrusted` (text leaves it) may be imported only
//    by the files named below, so every place outsider text enters or leaves the type is on this list.
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const sinkMessage = 'No HTML sinks in the console: outsider text is rendered as a React text node only (DESIGN.md 3.5 and 6.2).';
const htmlSinks = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: sinkMessage },
  { selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]', message: sinkMessage },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: sinkMessage },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name='write']", message: sinkMessage },
];

const wrapOnly = {
  group: ['**/untrusted', '**/untrusted.ts'],
  importNames: ['wrapUntrusted'],
  message: 'wrapUntrusted is allowed only in src/approvals/evidence.ts, src/task/traceStore.ts and src/fixtures/.',
};
const revealOnly = {
  group: ['**/untrusted', '**/untrusted.ts'],
  importNames: ['revealUntrusted'],
  message: 'revealUntrusted is allowed only in src/components/Specimen.tsx.',
};

export default defineConfig([
  { ignores: ['dist/**', 'audit/**', 'node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...htmlSinks],
      'no-restricted-imports': ['error', { patterns: [wrapOnly, revealOnly] }],
    },
  },
  {
    // the parser of untrusted evidence, the trace store (its `raw` fields) and the fixture routes build Untrusted values
    files: ['src/approvals/evidence.ts', 'src/task/traceStore.ts', 'src/fixtures/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [revealOnly] }] },
  },
  {
    // the one place text leaves the type
    files: ['src/components/Specimen.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [wrapOnly] }] },
  },
]);
