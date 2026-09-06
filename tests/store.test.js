import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, serialiseStore, upsert, watermarkOf } from '../src/lib/store.js';

const text = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

test('parses every fixture record', () => {
  assert.equal(parseStore(text).size, 12);
});

// I7: the old assertion compared only KEYS, so rewriting serialiseStore to emit
// {number} alone — discarding labels, timestamps and every PR reference —
// passed a test named "round-trips without loss". This file is the durable
// artefact in skomp/n8n-data; silent field loss there is unrecoverable without
// a full re-backfill.
test('round-trips without loss', () => {
  const once = parseStore(text);
  const twice = parseStore(serialiseStore(once));
  assert.deepEqual([...twice.keys()].sort(), [...once.keys()].sort());
  for (const number of once.keys()) {
    assert.deepEqual(twice.get(number), once.get(number), `#${number} lost fields`);
  }
  // Named explicitly so the nested PR and label structures are covered even if
  // the loop above is ever weakened.
  assert.deepEqual(twice.get(16038), once.get(16038));
  assert.deepEqual(twice.get(900002), once.get(900002));
  assert.equal(twice.get(16038).labels.nodes.length, 2);
  assert.equal(twice.get(900002).closedByPullRequestsReferences.nodes.length, 2);
});

test('serialises ascending by issue number and ends with a newline', () => {
  const out = serialiseStore(parseStore(text));
  const nums = out.trim().split('\n').map(l => JSON.parse(l).number);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  assert.ok(out.endsWith('\n'));
});

test('tolerates blank lines and trailing whitespace', () => {
  assert.equal(parseStore('\n' + text + '\n\n').size, 12);
});

// The incremental sync deliberately re-fetches an overlapping window.
test('upsert replaces by number rather than appending duplicates', () => {
  const store = parseStore(text);
  const before = store.size;
  const changed = { ...store.get(16038), title: 'CHANGED' };
  upsert(store, [changed]);
  assert.equal(store.size, before);
  assert.equal(store.get(16038).title, 'CHANGED');
});

test('watermark is the maximum updatedAt', () => {
  const store = parseStore(text);
  const expected = [...store.values()].map(i => i.updatedAt).sort().at(-1);
  assert.equal(watermarkOf(store), expected);
  assert.equal(watermarkOf(new Map()), null);
});
