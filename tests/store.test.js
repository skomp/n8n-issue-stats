import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, serialiseStore, upsert, watermarkOf } from '../src/lib/store.js';

const text = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

test('parses every fixture record', () => {
  assert.equal(parseStore(text).size, 10);
});

test('round-trips without loss', () => {
  const once = parseStore(text);
  assert.deepEqual([...parseStore(serialiseStore(once)).keys()].sort(), [...once.keys()].sort());
});

test('serialises ascending by issue number and ends with a newline', () => {
  const out = serialiseStore(parseStore(text));
  const nums = out.trim().split('\n').map(l => JSON.parse(l).number);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  assert.ok(out.endsWith('\n'));
});

test('tolerates blank lines and trailing whitespace', () => {
  assert.equal(parseStore('\n' + text + '\n\n').size, 10);
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
