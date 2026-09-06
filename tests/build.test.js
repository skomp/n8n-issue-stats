import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stripInstanceFields,
  isStalledCursorError,
  isSecondaryRateLimitError,
  fetchAllWithRetry,
  runIngest,
  buildReportPayload,
  buildIngestWorkflow,
  buildReportWorkflow,
  NODE_TYPE_VERSIONS,
} from '../build/build-workflows.js';

const fixtureText = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

// --- Step 1 tests from the task brief ---------------------------------------

test('instance-specific fields are removed before commit', () => {
  const cleaned = stripInstanceFields({
    id: 'abc', versionId: 'v1', versionCounter: 3, activeVersionId: 'a',
    sourceWorkflowId: 's', name: 'keep me', staticData: { x: 1 },
    shared: [{ role: 'owner' }], createdAt: 't', updatedAt: 't',
    meta: { instanceId: 'i', templateId: 'keep' },
    tags: [{ id: 'tid', name: 'keep' }],
    nodes: [{ id: 'nid', webhookId: 'wid', name: 'Node', type: 'n8n-nodes-base.code' }],
    connections: {},
  });

  for (const gone of ['id', 'versionId', 'versionCounter', 'activeVersionId',
                      'sourceWorkflowId', 'staticData', 'shared', 'createdAt', 'updatedAt']) {
    assert.ok(!(gone in cleaned), `${gone} should have been stripped`);
  }
  assert.equal(cleaned.name, 'keep me');
  assert.ok(!('instanceId' in cleaned.meta));
  assert.equal(cleaned.meta.templateId, 'keep');
  assert.ok(!('id' in cleaned.nodes[0]));
  assert.ok(!('webhookId' in cleaned.nodes[0]));
  assert.equal(cleaned.nodes[0].name, 'Node');
  assert.ok(!('id' in cleaned.tags[0]));
  assert.equal(cleaned.tags[0].name, 'keep');
});

test('stripping is idempotent', () => {
  const once = stripInstanceFields({ id: 'a', name: 'w', nodes: [], connections: {} });
  assert.deepEqual(stripInstanceFields(once), once);
});

test('activeVersion is stripped from the workflow root', () => {
  const cleaned = stripInstanceFields({ activeVersion: 3, name: 'w' });
  assert.ok(!('activeVersion' in cleaned));
});

// --- Retry logic: distinguishing the secondary rate limit from a hard failure

test('a stalled-cursor error is recognised and never treated as retryable', () => {
  const err = new Error('fetchAll: stalled cursor "abc" did not advance after 20 page(s) and 2000 issue(s) collected');
  assert.ok(isStalledCursorError(err));
  assert.ok(!isSecondaryRateLimitError(err));
});

test('a secondary rate limit 403 is recognised as retryable, a plain 403 is not', () => {
  const secondary = new Error('GitHub HTTP 403: {"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}');
  assert.ok(isSecondaryRateLimitError(secondary));
  assert.ok(!isStalledCursorError(secondary));

  const plainForbidden = new Error('GitHub HTTP 403: {"message":"Resource not accessible by integration"}');
  assert.ok(!isSecondaryRateLimitError(plainForbidden));
});

test('fetchAllWithRetry retries a secondary rate limit and eventually succeeds', async () => {
  let calls = 0;
  const waits = [];
  const fetchAllFn = async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('GitHub HTTP 403: {"message":"You have exceeded a secondary rate limit."}');
    }
    return { issues: [{ number: 1 }], pages: 1, points: 2 };
  };

  const result = await fetchAllWithRetry(fetchAllFn, {}, {
    maxAttempts: 3,
    waitMs: 300000,
    sleep: async ms => { waits.push(ms); },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [300000, 300000]);
  assert.equal(result.issues.length, 1);
});

test('fetchAllWithRetry never retries a stalled-cursor error, even once', async () => {
  let calls = 0;
  const fetchAllFn = async () => {
    calls += 1;
    throw new Error('fetchAll: stalled cursor "x" did not advance after 20 page(s) and 2000 issue(s) collected');
  };

  await assert.rejects(
    () => fetchAllWithRetry(fetchAllFn, {}, { sleep: async () => { throw new Error('must not sleep/retry'); } }),
    /stalled cursor/,
  );
  assert.equal(calls, 1);
});

test('fetchAllWithRetry gives up after maxAttempts and surfaces the last error', async () => {
  let calls = 0;
  const fetchAllFn = async () => {
    calls += 1;
    throw new Error('GitHub HTTP 403: {"message":"You have exceeded a secondary rate limit."}');
  };

  await assert.rejects(
    () => fetchAllWithRetry(fetchAllFn, {}, { maxAttempts: 2, sleep: async () => {} }),
    /secondary rate limit/,
  );
  assert.equal(calls, 2);
});

test('an unrelated error is never retried', async () => {
  let calls = 0;
  const fetchAllFn = async () => { calls += 1; throw new Error('GitHub HTTP 500: {"message":"oops"}'); };
  await assert.rejects(() => fetchAllWithRetry(fetchAllFn, {}, {
    sleep: async () => { throw new Error('must not sleep/retry'); },
  }));
  assert.equal(calls, 1);
});

// --- runIngest: sync driver reused by the generated Code node ---------------

test('runIngest upserts fetched issues into the existing store and advances the watermark', async () => {
  const fetchAllFn = async ({ since }) => {
    assert.equal(since, null); // no prior state -> fetch everything
    return { issues: [{ number: 1, updatedAt: '2026-09-01T00:00:00Z' }], pages: 1, points: 2 };
  };
  const result = await runIngest({ stateText: null, storeText: '', token: 't', fetchAllFn });
  assert.equal(result.fetched, 1);
  assert.equal(result.watermark, '2026-09-01T00:00:00Z');
  assert.equal(JSON.parse(result.stateText).watermark, '2026-09-01T00:00:00Z');
  assert.equal(result.storeText.trim(), JSON.stringify({ number: 1, updatedAt: '2026-09-01T00:00:00Z' }));
});

// --- Report payload: the memory-safety contract, checked by value -----------

test('buildReportPayload folds the whole store into a single object, not an array', () => {
  const payload = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.equal(Array.isArray(payload), false);
  assert.equal(typeof payload.content, 'string');
  assert.equal(payload.path, 'reports/2026-09-06-triage.md');
  // Value check, not shape check: the fixture's known population (13 records).
  assert.match(payload.content, /Population: \*\*13\*\*/);
});

// --- Generated workflow structure --------------------------------------------

test('generated workflows carry no instance-specific fields', () => {
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    const cleaned = stripInstanceFields(build());
    assert.deepEqual(cleaned, stripInstanceFields(cleaned)); // idempotent on real output
    for (const node of cleaned.nodes) {
      assert.ok(!('id' in node));
      assert.ok(!('webhookId' in node));
    }
  }
});

test('the report Code node source contains the memory-constraint warning and a single-item return', () => {
  const report = buildReportWorkflow();
  const codeNode = report.nodes.find(n => n.name === 'Rollup and render');
  assert.ok(codeNode, 'expected a "Rollup and render" Code node');
  assert.match(codeNode.parameters.jsCode, /CRITICAL MEMORY CONSTRAINT/);
  assert.match(codeNode.parameters.jsCode, /must return ONE item/);
  assert.match(codeNode.parameters.jsCode, /return \[\{/);
  // The array literal must not come from mapping over the issues -- a crude
  // but effective guard against re-introducing one-item-per-issue.
  assert.doesNotMatch(codeNode.parameters.jsCode, /issues\.map\(/);
});

test('the report workflow reads issues.ndjson once and writes once', () => {
  const report = buildReportWorkflow();
  const httpNodes = report.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest');
  assert.equal(httpNodes.length, 2);
});

test('the ingest Code node source distinguishes stalled-cursor from secondary-rate-limit', () => {
  const ingest = buildIngestWorkflow();
  const codeNode = ingest.nodes.find(n => n.name === 'Sync');
  assert.ok(codeNode, 'expected a "Sync" Code node');
  assert.match(codeNode.parameters.jsCode, /isStalledCursorError/);
  assert.match(codeNode.parameters.jsCode, /isSecondaryRateLimitError/);
  assert.doesNotMatch(codeNode.parameters.jsCode, /^\s*import /m);
  assert.doesNotMatch(codeNode.parameters.jsCode, /^\s*export /m);
});

test('every generated node type version is documented in NODE_TYPE_VERSIONS', () => {
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    for (const node of build().nodes) {
      assert.ok(node.type in NODE_TYPE_VERSIONS, `${node.type} is not documented as a guessed version`);
      assert.equal(node.typeVersion, NODE_TYPE_VERSIONS[node.type]);
    }
  }
});
