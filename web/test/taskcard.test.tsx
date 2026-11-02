// AIR-185: the task card is rendered from the exact bytes that are signed, and the component takes no task object.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { registryFromRows } from '@airlock/runtime/analyze';
import { ownerTaskBorsh } from '@airlock/runtime/dsl';
import type { OwnerTask } from '@airlock/runtime/dsl';
import fixture from '../fixtures/preview-u01.json' with { type: 'json' };
import { CardError, renderTaskCard } from '../src/preview/card.ts';
import { TaskCard } from '../src/preview/TaskCard.tsx';

const registry = registryFromRows(fixture.snapshot.assets as unknown as Parameters<typeof registryFromRows>[0]);

const task: OwnerTask = {
  tag: 'airlock-task-v1',
  task_id: '01a3185c-5000-7011-a233-445566778899',
  contract_id: 'policy.testnet',
  agent_id: 'agent.testnet',
  plan_sha256: 'ab'.repeat(32),
  instruction_sha256_salted: 'cd'.repeat(32),
  issued_ms: 1_800_000_000_000,
  expires_ms: 1_800_000_900_000,
  max_actions: 2,
  bounds: [
    { payee_key: 'near:accountant.testnet', max_total: '5000000000000000000000000' },
    { payee_key: 'evm:84532:0xabababababababababababababababababababab', max_total: '20000000000000000' },
  ],
};

test('the card lines come in the fixed order of the ticket', () => {
  const lines = renderTaskCard(ownerTaskBorsh(task), registry);
  assert.deepEqual(lines, [
    { label: 'Agent', value: 'agent.testnet' },
    { label: 'Contract', value: 'policy.testnet' },
    { label: 'Plan', value: 'abababababab' },
    { label: 'Valid until', value: '2027-01-15 08:15:00 UTC' },
    { label: 'Max payments', value: '2' },
    { label: 'Pay up to', value: '5 NEAR to near:accountant.testnet' },
    { label: 'Asset id', value: 'near' },
    { label: 'Pay up to', value: '0.02 ETH.base to evm:84532:0xabababababababababababababababababababab' },
    { label: 'Asset id', value: 'evm:84532:native' },
  ]);
});

test('flipping one byte of a bound changes the matching line and only that one', () => {
  const bytes = ownerTaskBorsh(task);
  const before = renderTaskCard(bytes, registry);
  // the first max_total is 16 bytes little-endian right after its payee key string: find it from the end of the second bound
  const flipped = Uint8Array.from(bytes);
  const firstAmountAt = bytes.length - 16 - (4 + task.bounds[1]!.payee_key.length) - 16;
  flipped[firstAmountAt + 10] = (flipped[firstAmountAt + 10] ?? 0) ^ 0x01;
  const after = renderTaskCard(flipped, registry);
  const diff = after.map((l, i) => (l.value === before[i]?.value ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(diff, [5]);
});

test('an asset missing from the registry throws CardError', () => {
  assert.throws(() => renderTaskCard(ownerTaskBorsh(task), new Map()), CardError);
});

test('TaskCard renders one card-line per line of renderTaskCard and nothing else', () => {
  const html = renderToStaticMarkup(<TaskCard bytes={ownerTaskBorsh(task)} registry={registry} />);
  assert.equal(html.split('data-testid="card-line"').length - 1, 9);
  assert.ok(html.includes('data-testid="task-card"'));
  assert.ok(html.includes('5 NEAR to near:accountant.testnet'));
});

test('TaskCard takes bytes and a registry only: a task object does not compile', () => {
  // @ts-expect-error the props have no task
  const element = <TaskCard task={task} />;
  assert.ok(element);
});
