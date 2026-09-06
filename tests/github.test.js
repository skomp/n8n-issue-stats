import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUES_QUERY, fetchPage, fetchAll } from '../src/lib/github.js';
import { ALL_FILTER_LABELS } from '../src/lib/labels.js';

const page = (nodes, hasNextPage, endCursor) => ({
  ok: true,
  json: async () => ({
    data: {
      rateLimit: { cost: 6, remaining: 4000 },
      repository: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } },
    },
  }),
});

test('query pins the ascending order the spec requires', () => {
  assert.match(ISSUES_QUERY, /direction:\s*ASC/);
  assert.match(ISSUES_QUERY, /field:\s*UPDATED_AT/);
  assert.doesNotMatch(ISSUES_QUERY, /DESC/);
});

test('query requests the fields the classifier and metrics need', () => {
  for (const field of ['createdAt', 'closedAt', 'updatedAt', 'mergedAt',
                       'closedByPullRequestsReferences', 'files', 'labels']) {
    assert.ok(ISSUES_QUERY.includes(field), `missing ${field}`);
  }
});

// I8: this test previously captured only `variables.cursor`. Dropping `since`
// from the variables passed the whole suite, while silently degrading the daily
// incremental sync into a full 55-page backfill. Sending `labels: []` also
// passed, which removes the population filter and returns all 10,241 issues
// instead of the 5,464 every published figure is computed from. Capture the
// WHOLE variables object.
const captureAll = pages => {
  const seen = [];
  globalThis.fetch = async (_url, opts) => {
    seen.push(JSON.parse(opts.body).variables);
    return pages.shift();
  };
  return seen;
};

test('fetchAll follows cursors until exhausted', async () => {
  const seen = captureAll([
    page([{ number: 1 }, { number: 2 }], true, 'c1'),
    page([{ number: 3 }], false, null),
  ]);
  const res = await fetchAll({ token: 't' });
  assert.equal(res.issues.length, 3);
  assert.equal(res.pages, 2);
  assert.equal(res.points, 12);
  assert.deepEqual(seen.map(v => v.cursor), [null, 'c1']);
});

test('every request carries the since watermark it was given', async () => {
  const seen = captureAll([page([{ number: 1 }], true, 'c1'), page([{ number: 2 }], false, null)]);
  await fetchAll({ token: 't', since: '2026-09-06T11:55:00Z' });
  assert.equal(seen.length, 2);
  for (const v of seen) assert.equal(v.since, '2026-09-06T11:55:00Z');
});

test('an absent watermark sends since as null, not undefined', async () => {
  const seen = captureAll([page([], false, null)]);
  await fetchAll({ token: 't' });
  assert.equal(seen[0].since, null);
  assert.ok('since' in seen[0], 'since must be present in the variables');
});

test('every request carries all 33 filter labels', async () => {
  const seen = captureAll([page([], false, null)]);
  await fetchAll({ token: 't' });
  assert.equal(seen[0].labels.length, 33);
  assert.deepEqual(seen[0].labels, ALL_FILTER_LABELS);
  assert.ok(seen[0].labels.includes('closed:incomplete-template'));
  assert.ok(seen[0].labels.includes('team:nodes'));
  assert.ok(seen[0].labels.includes('triage:pending'));
});

test('onPage is invoked once per page with running progress', async () => {
  captureAll([
    page([{ number: 1 }, { number: 2 }], true, 'c1'),
    page([{ number: 3 }], false, null),
  ]);
  const calls = [];
  await fetchAll({ token: 't', onPage: p => calls.push(p) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.pages), [1, 2]);
  assert.deepEqual(calls.map(c => c.received), [2, 3]);
  assert.deepEqual(calls.map(c => c.points), [6, 12]);
  assert.equal(calls[1].remaining, 4000);
});

// Minor 3: without the endCursor guard this test never returns. A silent
// `break` would also pass here, since it returns just as normally as a
// complete result — so the guard must throw, not return short.
test('fetchAll stops when the cursor stops advancing', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests > 20) throw new Error('fetchAll did not terminate on a stalled cursor');
    return page([{ number: requests }], true, 'stuck');
  };
  await assert.rejects(
    () => fetchAll({ token: 't' }),
    /stalled cursor "stuck".*2 page\(s\).*2 issue\(s\)/
  );
});

test('a GraphQL errors array is thrown, not silently ignored', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) });
  await assert.rejects(() => fetchPage({ token: 't' }), /boom/);
});

test('an HTTP failure is thrown with its status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad credentials' });
  await assert.rejects(() => fetchPage({ token: 't' }), /401/);
});
