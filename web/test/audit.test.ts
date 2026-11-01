// The clip-audit helper and the fixture registry (AIR-183). Pure parts only: the browser runs are in e2e/audit.e2e.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { clipAudit, overflowMessages } from '../e2e/audit.ts';
import { listFixtures, registerFixture } from '../src/fixtures/registry.ts';

test('overflowMessages: 600 px of content at 375 reports overflowX 225', () => {
  assert.deepEqual(overflowMessages(375, { innerWidth: 375, clientWidth: 375, scrollWidth: 600 }), ['overflowX 225']);
});

test('overflowMessages: an innerWidth that followed the content throws viewport not honored', () => {
  assert.throws(() => overflowMessages(375, { innerWidth: 600, clientWidth: 375, scrollWidth: 600 }), /viewport not honored: innerWidth 600 for width 375/);
});

test('overflowMessages: a page that fits reports nothing', () => {
  assert.deepEqual(overflowMessages(375, { innerWidth: 375, clientWidth: 375, scrollWidth: 375 }), []);
});

/** A fake page: metrics come back for a function, the audit result is whatever the test says for the source string. */
function fakePage(auditResult: unknown, metrics = { innerWidth: 375, clientWidth: 375, scrollWidth: 375 }): { page: Page; sizes: number[]; sources: string[] } {
  const sizes: number[] = [];
  const sources: string[] = [];
  const page = {
    setViewportSize: async (s: { width: number; height: number }) => {
      sizes.push(s.width);
      metrics = { ...metrics, innerWidth: s.width, clientWidth: s.width, scrollWidth: s.width };
    },
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string') {
        sources.push(arg);
        return auditResult;
      }
      return metrics;
    },
  } as unknown as Page;
  return { page, sizes, sources };
}

test('clipAudit: an audit that returns undefined makes it throw', async () => {
  const { page } = fakePage(undefined);
  await assert.rejects(clipAudit(page), /audit returned no result/);
});

test('clipAudit: a result without a numeric overflowX makes it throw', async () => {
  const { page } = fakePage({ overflowX: 'no', clipped: [], corners: [], text: [], inputs: [] });
  await assert.rejects(clipAudit(page), /audit returned no result/);
});

test('clipAudit: evaluates the kit function as a call expression at every default width and lists each entry', async () => {
  const { page, sizes, sources } = fakePage({ overflowX: 0, clipped: ['a spills'], corners: ['c cut'], text: ['t runs'], inputs: ['i needs'] });
  const messages = await clipAudit(page);
  assert.deepEqual(sizes, [320, 375, 390]);
  assert.equal(sources.length, 3);
  assert.ok(sources[0]?.startsWith('(') && sources[0].trimEnd().endsWith(')()'));
  assert.equal(messages.length, 12);
  assert.ok(messages.includes('320px clipped: a spills'));
  assert.ok(messages.includes('390px inputs: i needs'));
});

test('clipAudit: a clean page returns nothing, and the width list can be narrowed', async () => {
  const { page, sizes } = fakePage({ overflowX: 0, clipped: [], corners: [], text: [], inputs: [] });
  assert.deepEqual(await clipAudit(page, [375]), []);
  assert.deepEqual(sizes, [375]);
});

test('clipAudit: the overflow verdict uses clientWidth and scrollWidth, not the kit overflowX field', async () => {
  const page = {
    setViewportSize: async () => {},
    evaluate: async (arg: unknown) =>
      typeof arg === 'string' ? { overflowX: 0, clipped: [], corners: [], text: [], inputs: [] } : { innerWidth: 375, clientWidth: 375, scrollWidth: 600 },
  } as unknown as Page;
  assert.deepEqual(await clipAudit(page, [375]), ['375px overflowX 225']);
});

test('registry: registerFixture lists names in order, rejects duplicates and carries expectAuditFail', () => {
  const before = listFixtures().length;
  registerFixture('unit-a', () => null as never);
  registerFixture('unit-b', () => null as never, { expectAuditFail: true });
  const added = listFixtures().slice(before);
  assert.deepEqual(added.map((f) => [f.name, f.expectAuditFail]), [
    ['unit-a', false],
    ['unit-b', true],
  ]);
  assert.throws(() => registerFixture('unit-a', () => null as never), /already registered/);
  assert.throws(() => registerFixture('bad name', () => null as never), /fixture name/);
});
