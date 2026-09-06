import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUES_QUERY, fetchPage, fetchAll } from '../src/lib/github.js';

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

test('fetchAll follows cursors until exhausted', async () => {
  const pages = [
    page([{ number: 1 }, { number: 2 }], true, 'c1'),
    page([{ number: 3 }], false, null),
  ];
  let seen = [];
  globalThis.fetch = async (_url, opts) => {
    seen.push(JSON.parse(opts.body).variables.cursor);
    return pages.shift();
  };
  const res = await fetchAll({ token: 't' });
  assert.equal(res.issues.length, 3);
  assert.equal(res.pages, 2);
  assert.equal(res.points, 12);
  assert.deepEqual(seen, [null, 'c1']);
});

test('a GraphQL errors array is thrown, not silently ignored', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) });
  await assert.rejects(() => fetchPage({ token: 't' }), /boom/);
});

test('an HTTP failure is thrown with its status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad credentials' });
  await assert.rejects(() => fetchPage({ token: 't' }), /401/);
});
