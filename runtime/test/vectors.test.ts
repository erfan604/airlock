// AIR-122: the TypeScript consumer of the shared vector file family (fixtures/verdict-vectors.json), which the Rust crate and the
// Lean runner read too. The vectors are the source of truth: when this code and a vector disagree, this code is wrong. Each
// vector is its own test(); the summary line is printed after every vector was asserted.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionRequest,
  KeyError,
  LabelError,
  bitsToLabels,
  decodeOwnerTask,
  labelFromName,
  labelsToBits,
  ownerTaskBorsh,
  parseActionRequest,
  taskHash,
  validatePayeeKey,
} from '../src/dsl/index.ts';
import { bytesToHex, hexToBytes, vectorTask, vectors, withActionIndex } from './vectors.helpers.ts';

const seen = { labels: 0, invalid: 0, payee_keys: 0, submit_rejections: 0, verdicts: 0, owner_task: 0 };

// ---- labels ----
vectors.labels.valid.forEach((v) => {
  test(`label ${v.name} maps to ${v.mask} and back`, () => {
    assert.equal(labelFromName(v.name), v.mask);
    assert.deepEqual(bitsToLabels(v.mask), [v.name]);
    seen.labels += 1;
  });
});

vectors.labels.invalid.forEach((name, i) => {
  test(`invalid label name ${i} throws LabelError`, () => {
    assert.throws(() => labelFromName(name), LabelError);
    seen.invalid += 1;
  });
});

// ---- payee keys ----
vectors.payee_keys.accept.forEach((v) => {
  test(`payee key accepted: ${v.key}`, () => {
    validatePayeeKey(v.key);
    seen.payee_keys += 1;
  });
});

vectors.payee_keys.reject.forEach((v, i) => {
  test(`payee key rejected ${i} as ${v.error}`, () => {
    assert.throws(
      () => validatePayeeKey(v.key),
      (e: unknown) => e instanceof KeyError && e.code === v.error,
    );
    seen.payee_keys += 1;
  });
});

// ---- the requests the contract refuses ----
vectors.submit_rejections.forEach((v) => {
  test(`submit rejection ${v.name} is refused by parseActionRequest`, () => {
    assert.throws(() => parseActionRequest(withActionIndex(v.raw)));
    seen.submit_rejections += 1;
  });
});

// ---- the 200 verdict requests ----
vectors.verdicts.forEach((v, n) => {
  test(`verdict ${n} ${v.name}: the request parses and the label names convert to its masks`, () => {
    const raw = withActionIndex(JSON.stringify(v.request));
    const parsed = parseActionRequest(raw);
    assert.deepEqual(ActionRequest.parse(JSON.parse(raw)), parsed);
    assert.equal(parsed.labels.recipient, labelsToBits(v.label_names.recipient));
    assert.equal(parsed.labels.amount, labelsToBits(v.label_names.amount));
    assert.equal(parsed.labels.pc, labelsToBits(v.label_names.pc));
    assert.equal(parsed.labels.recipient, v.request.labels.recipient);
    seen.verdicts += 1;
  });
});

// ---- the owner task ----
test('owner task: the borsh bytes, the hash and the decoded task equal the vector', () => {
  const task = vectorTask();
  assert.equal(bytesToHex(ownerTaskBorsh(task)), vectors.owner_task.borsh_hex);
  assert.equal(taskHash(task), vectors.owner_task.sha256_hex);
  assert.deepEqual(decodeOwnerTask(hexToBytes(vectors.owner_task.borsh_hex)), task);
  seen.owner_task += 1;
});

after(() => {
  assert.equal(seen.labels, 15);
  assert.equal(seen.invalid, 12);
  assert.equal(seen.payee_keys, vectors.payee_keys.accept.length + vectors.payee_keys.reject.length);
  assert.equal(seen.submit_rejections, vectors.submit_rejections.length);
  assert.equal(seen.verdicts, vectors.verdicts.length);
  assert.equal(seen.owner_task, 1);
  console.log(
    `VECTORS labels=${seen.labels} invalid=${seen.invalid} payee_keys=${seen.payee_keys} submit_rejections=${seen.submit_rejections} verdicts=${seen.verdicts} owner_task=${seen.owner_task}`,
  );
});
