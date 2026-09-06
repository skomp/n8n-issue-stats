import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore } from '../src/lib/store.js';
import { syncSince, overlapWindow } from '../src/sync.js';

const text = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

test('the query window is pulled back to absorb clock skew', () => {
  assert.equal(overlapWindow('2026-09-06T12:00:00Z'), '2026-09-06T11:55:00Z');
});

test('an empty store asks for everything', () => {
  assert.equal(overlapWindow(null), null);
});

// The overlap re-fetches records already held. That must not duplicate them.
test('re-syncing the same records leaves the store size unchanged', async () => {
  const store = parseStore(text);
  const before = store.size;
  const existing = [...store.values()].slice(0, 3);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: existing } },
    }}),
  });
  const res = await syncSince(store, { token: 't' });
  assert.equal(res.store.size, before);
  assert.equal(res.fetched, 3);
});

test('the returned watermark is the newest updatedAt in the store', async () => {
  const store = parseStore(text);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    }}),
  });
  const res = await syncSince(store, { token: 't' });
  const expected = [...store.values()].map(i => i.updatedAt).sort().at(-1);
  assert.equal(res.watermark, expected);
});
