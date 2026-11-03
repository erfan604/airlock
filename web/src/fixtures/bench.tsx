// AIR-192: `/fixtures/bench` renders the Bench page over web/fixtures/bench.json (the AIR-223 worked fixture, written by
// bench/src/scripts/web-bench-json.ts --fixture), so the clip audit and the screenshots run without real results. The page and the
// JSON load on demand, so neither enters the shell's bundle.
import { lazy, Suspense } from 'react';
import { registerFixture } from './registry.ts';

const FixtureBench = lazy(async () => {
  const [{ BenchView }, { parseBench }, json] = await Promise.all([import('../bench/BenchPage.tsx'), import('../bench/types.ts'), import('../../fixtures/bench.json', { with: { type: 'json' } })]);
  return { default: () => <BenchView data={parseBench(json.default)} /> };
});

registerFixture('bench', () => (
  <Suspense fallback={null}>
    <FixtureBench />
  </Suspense>
));
