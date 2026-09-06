import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, watermarkOf } from '../src/lib/store.js';
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

// I8: the incremental sync degrades silently into a full backfill if `since`
// never reaches the query. Assert the overlap window is what gets sent.
test('the sync sends the overlap window as the since variable', async () => {
  const store = parseStore(text);
  let sent = null;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body).variables;
    return { ok: true, json: async () => ({ data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    }}) };
  };
  await syncSince(store, { token: 't' });
  assert.equal(sent.since, overlapWindow(watermarkOf(store)));
  assert.match(sent.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(sent.labels.length, 33);
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
