import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  stripInstanceFields,
  isStalledCursorError,
  isSecondaryRateLimitError,
  fetchAllWithRetry,
  assertStoreIsIntact,
  planFetch,
  issuesFromPages,
  applyPages,
  buildReportPayload,
  buildIngestWorkflow,
  buildReportWorkflow,
  renderWorkflowFile,
  GENERATED_WORKFLOWS,
  GITHUB_CREDENTIAL,
  NODE_TYPE_VERSIONS,
} from '../build/build-workflows.js';
import { ISSUES_QUERY } from '../src/lib/github.js';
import { ALL_FILTER_LABELS } from '../src/lib/labels.js';

const fixtureText = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');
const FIXTURE_RECORDS = 13;

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// The real state.json, verbatim from skomp/n8n-data on 2026-09-06.
const realStateText = JSON.stringify({
  watermark: '2026-09-06T07:12:12Z',
  records: 5464,
  source: 'n8n-io/n8n',
  backfilledAt: '2026-09-06T10:43:18.909705Z',
}, null, 2) + '\n';

const fixtureState = records => JSON.stringify({
  watermark: '2026-09-06T07:12:12Z', records, source: 'n8n-io/n8n', backfilledAt: '2026-09-06T10:43:18.909705Z',
}, null, 2) + '\n';

const page = nodes => ({ data: { rateLimit: { cost: 1, remaining: 4999 }, repository: { issues: { pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29y' }, nodes } } } });

const nodeNamed = (workflow, name) => workflow.nodes.find(n => n.name === name);
const acceptOf = node => node.parameters.headerParameters.parameters.find(h => h.name === 'Accept')?.value;

// Runs a generated Code node's jsCode the way n8n does: a bare function body
// with the n8n globals injected. This is what proves the INLINED source is
// valid standalone JavaScript, not just that the build produced a string.
function runCodeNode(jsCode, { items = [], nodes = {} } = {}) {
  const $input = {
    all: () => items,
    first: () => items[0],
  };
  const $ = name => {
    if (!(name in nodes)) throw new Error(`test stub: no node named "${name}"`);
    return { first: () => ({ json: nodes[name] }) };
  };
  return new Function('$input', '$', jsCode)($input, $);
}

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
// These serve the LOCAL backfill path; the workflow pages in an HTTP Request
// node and cannot reach them. See build/build-workflows.js.

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

// --- The truncation guard ---------------------------------------------------
//
// MEASURED 2026-09-06: GET contents/issues.ndjson (2.86 MB) with the default
// JSON media type returns HTTP 200, "encoding": "none", content: "". Without
// this guard the store would be rewritten from 5,464 records to ~20 and the
// run would report success.

test('a store that read back empty is refused, and the message names the cause', () => {
  assert.throws(
    () => assertStoreIsIntact(new Map(), JSON.parse(realStateText)),
    /read back EMPTY[\s\S]*vnd\.github\.raw/,
  );
});

test('a short read below 90% of the recorded record count is refused', () => {
  // 4917 of 5464 is 89.99%. Deliberately not a round fraction: a threshold
  // test built from an exact one passes whether or not the comparison is right.
  const short = new Map(Array.from({ length: 4917 }, (_, i) => [i, { number: i }]));
  assert.throws(() => assertStoreIsIntact(short, { records: 5464 }), /below 90% of the expected count/);
});

test('a read at or above 90% of the recorded record count is accepted', () => {
  const ok = new Map(Array.from({ length: 4918 }, (_, i) => [i, { number: i }])); // 90.01%
  assert.doesNotThrow(() => assertStoreIsIntact(ok, { records: 5464 }));
  const grown = new Map(Array.from({ length: 5500 }, (_, i) => [i, { number: i }]));
  assert.doesNotThrow(() => assertStoreIsIntact(grown, { records: 5464 }));
});

test('a state.json with no record count still refuses an empty store', () => {
  assert.throws(() => assertStoreIsIntact(new Map(), {}), /read back EMPTY/);
  assert.doesNotThrow(() => assertStoreIsIntact(new Map([[1, { number: 1 }]]), {}));
});

// --- planFetch: the request the HTTP Request node sends ----------------------

test('planFetch pulls the since window back by the 5-minute overlap', () => {
  const plan = planFetch(realStateText);
  assert.equal(plan.since, '2026-09-06T07:07:12Z');
  assert.equal(plan.body.variables.since, '2026-09-06T07:07:12Z');
  assert.equal(plan.body.variables.cursor, null);
});

test('planFetch with no prior state asks for everything', () => {
  assert.equal(planFetch('').since, null);
  assert.equal(planFetch('{}').since, null);
});

test('planFetch sends byte-identical query and label filter to the local backfill', () => {
  const plan = planFetch(realStateText);
  // The workflow and src/backfill.js write to the same NDJSON store. A schema
  // mismatch between them would corrupt it, so this is an identity check, not
  // a shape check.
  assert.equal(plan.body.query, ISSUES_QUERY);
  assert.deepEqual(plan.body.variables.labels, ALL_FILTER_LABELS);
  assert.equal(plan.body.variables.labels.length, 33);
});

// --- issuesFromPages: GraphQL errors arrive as HTTP 200 ----------------------

test('issuesFromPages flattens every page in order', () => {
  const issues = issuesFromPages([page([{ number: 1 }, { number: 2 }]), page([{ number: 3 }])]);
  assert.deepEqual(issues.map(i => i.number), [1, 2, 3]);
});

test('a GraphQL error page is rejected rather than read as zero issues', () => {
  // GitHub answers a GraphQL error with HTTP 200, so the HTTP Request node
  // cannot see it. Treated as "no issues" it would write back a silently
  // stale store.
  assert.throws(
    () => issuesFromPages([page([{ number: 1 }]), { errors: [{ message: 'Something went wrong' }] }]),
    /GitHub GraphQL \(page 2\): Something went wrong/,
  );
});

test('a page with an unrecognised shape is rejected', () => {
  assert.throws(() => issuesFromPages([{ data: { repository: null } }]), /page 1[\s\S]*unrecognised response/);
  assert.throws(() => issuesFromPages([{}]), /unrecognised response/);
});

// --- applyPages: the ingest driver ------------------------------------------

test('applyPages upserts fetched issues and advances the watermark and record count', () => {
  const result = applyPages({
    storeText: fixtureText,
    stateText: fixtureState(FIXTURE_RECORDS),
    pages: [page([{ number: 999999, updatedAt: '2026-09-06T09:00:00Z', createdAt: '2026-09-06T08:00:00Z' }])],
  });

  assert.equal(result.fetched, 1);
  assert.equal(result.records, FIXTURE_RECORDS + 1);
  assert.equal(result.watermark, '2026-09-06T09:00:00Z');
  assert.equal(result.storeText.trim().split('\n').length, FIXTURE_RECORDS + 1);
  assert.equal(JSON.parse(result.stateText).records, FIXTURE_RECORDS + 1);
  assert.equal(JSON.parse(result.stateText).watermark, '2026-09-06T09:00:00Z');
});

test('applyPages preserves the state fields it did not compute', () => {
  // `source` and `backfilledAt` are written by the local backfill and cannot
  // be reconstructed here; replacing state.json wholesale would lose them.
  const state = JSON.parse(applyPages({
    storeText: fixtureText,
    stateText: fixtureState(FIXTURE_RECORDS),
    pages: [page([])],
  }).stateText);
  assert.equal(state.source, 'n8n-io/n8n');
  assert.equal(state.backfilledAt, '2026-09-06T10:43:18.909705Z');
});

test('applyPages refuses a truncated store read before producing any write payload', () => {
  // The exact failure the Contents API's 1 MB truncation causes: the store
  // comes back as "", ~20 fetched issues are upserted, and 5,464 records are
  // replaced by 20.
  assert.throws(() => applyPages({
    storeText: '',
    stateText: realStateText,
    pages: [page([{ number: 1, updatedAt: '2026-09-06T09:00:00Z' }])],
  }), /read back EMPTY/);
});

test('applyPages refuses a store that shrank against the recorded count', () => {
  assert.throws(() => applyPages({
    storeText: fixtureText,
    stateText: realStateText, // records: 5464, but only 13 arrived
    pages: [page([])],
  }), /read back 13 record\(s\) but state\.json records 5464/);
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

test('buildReportPayload anchors the intake window to the report timestamp, not the clock', () => {
  // The window is 180 days before generatedAt. Pinning two timestamps and
  // checking the WINDOWED POPULATION -- not just the printed date -- is what
  // catches rollup() being called without `now`.
  const early = buildReportPayload(fixtureText, '2026-05-01T00:00:00.000Z');
  assert.match(early.content, /180 days since 2025-11-02/);
  // 6 of the 13 fixture issues were created on or after 2025-11-02.
  assert.match(early.content, /\*\*6\*\* of the 13 triaged issues/);

  const late = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.match(late.content, /180 days since 2026-03-10/);
  // None of the 13 were created on or after 2026-03-10.
  assert.match(late.content, /\*\*0\*\* of the 13 triaged issues/);
});

test('buildReportPayload refuses a truncated store rather than publishing "Population: 0"', () => {
  assert.throws(() => buildReportPayload('', '2026-09-06T00:00:00.000Z'), /read back EMPTY/);
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

test('no generated Code node contains a network call', () => {
  // n8n's Code node sandbox has NO network access: fetch(), axios,
  // XMLHttpRequest and require of http modules fail at runtime. A Code node
  // that calls them deploys clean, validates clean and dies on its first
  // scheduled run.
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    for (const node of build().nodes.filter(n => n.type === 'n8n-nodes-base.code')) {
      const code = node.parameters.jsCode;
      assert.doesNotMatch(code, /\bfetch\s*\(/, `${node.name} calls fetch()`);
      assert.doesNotMatch(code, /\baxios\b/, `${node.name} references axios`);
      assert.doesNotMatch(code, /\bXMLHttpRequest\b/, `${node.name} references XMLHttpRequest`);
      assert.doesNotMatch(code, /^\s*(import|export)\b/m, `${node.name} is not fully inlined`);
    }
  }
});

test('every GitHub HTTP node authenticates with the credential that exists on the instance', () => {
  // Literals on purpose. Comparing against the exported constant would make
  // this test agree with whatever the build says, which is not a test.
  assert.deepEqual(GITHUB_CREDENTIAL, { id: '45FxaagCNEF224PE', name: 'GitHub account' });
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    const httpNodes = build().nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest');
    assert.ok(httpNodes.length > 0);
    for (const node of httpNodes) {
      assert.equal(node.parameters.nodeCredentialType, 'githubApi');
      assert.equal(node.credentials.githubApi.id, '45FxaagCNEF224PE');
      assert.equal(node.credentials.githubApi.name, 'GitHub account');
    }
  }
});

test('issues.ndjson is always read with the raw media type', () => {
  // The default JSON media type returns HTTP 200 with an EMPTY content field
  // for files over 1 MB, and issues.ndjson is 2.86 MB. Every read of the
  // BYTES must ask for raw; the metadata-only read must not, because it needs
  // the JSON envelope for the blob sha.
  const ingest = buildIngestWorkflow();
  assert.equal(acceptOf(nodeNamed(ingest, 'Read issues.ndjson')), 'application/vnd.github.raw');
  assert.equal(acceptOf(nodeNamed(ingest, 'Read issues.ndjson sha')), 'application/vnd.github+json');
  assert.equal(acceptOf(nodeNamed(buildReportWorkflow(), 'Read issues.ndjson')), 'application/vnd.github.raw');

  for (const wf of [ingest, buildReportWorkflow()]) {
    const raw = nodeNamed(wf, 'Read issues.ndjson');
    assert.equal(raw.parameters.options.response.response.responseFormat, 'text');
    assert.equal(raw.parameters.options.response.response.outputPropertyName, 'data');
  }
});

test('the ingest workflow pages the GraphQL query in the HTTP Request node', () => {
  const fetchNode = nodeNamed(buildIngestWorkflow(), 'Fetch issues');
  assert.equal(fetchNode.type, 'n8n-nodes-base.httpRequest');
  assert.equal(fetchNode.parameters.method, 'POST');
  assert.equal(fetchNode.parameters.url, 'https://api.github.com/graphql');

  const p = fetchNode.parameters.options.pagination.pagination;
  assert.equal(p.paginationMode, 'updateAParameterInEachRequest');
  assert.equal(p.paginationCompleteWhen, 'other');
  assert.match(p.completeExpression, /hasNextPage/);
  assert.equal(p.parameters.parameters.length, 1);

  const [cursorParam] = p.parameters.parameters;
  assert.equal(cursorParam.type, 'body');
  // The WHOLE variables object, not a dotted "variables.cursor" path: a flat
  // dotted key would leave the cursor at null and silently re-fetch page 1.
  assert.equal(cursorParam.name, 'variables');
  assert.match(cursorParam.value, /pageInfo\?\.endCursor/);
  assert.match(cursorParam.value, /\$json\.since/);
  assert.match(cursorParam.value, /\$json\.labels/);

  // Safety bounds against an unbounded paging loop and the secondary rate limit.
  assert.equal(p.limitPagesFetched, true);
  assert.ok(p.maxRequests >= 60, 'the bound must clear a 55-page full backfill');
  assert.ok(p.requestInterval >= 300, 'pages must be spaced to avoid the secondary rate limit');
});

test('the ingest workflow writes the store before the watermark', () => {
  // If the store write fails, the watermark must NOT have advanced, or the
  // next run skips the window and leaves a permanent gap.
  const { connections } = buildIngestWorkflow();
  assert.deepEqual(connections['Upsert store'].main[0].map(c => c.node), ['Write issues.ndjson']);
  assert.deepEqual(connections['Write issues.ndjson'].main[0].map(c => c.node), ['Write state.json']);
  assert.equal(connections['Write state.json'], undefined);
});

test('the report Code node source carries the memory-constraint warning and a single-item return', () => {
  const codeNode = nodeNamed(buildReportWorkflow(), 'Rollup and render');
  assert.ok(codeNode, 'expected a "Rollup and render" Code node');
  assert.match(codeNode.parameters.jsCode, /CRITICAL MEMORY CONSTRAINT/);
  assert.match(codeNode.parameters.jsCode, /must return ONE item/);
  assert.match(codeNode.parameters.jsCode, /return \[\{/);
  // The array literal must not come from mapping over the issues -- a crude
  // but effective guard against re-introducing one-item-per-issue.
  assert.doesNotMatch(codeNode.parameters.jsCode, /issues\.map\(/);
});

test('the ingest Code nodes carry the memory-constraint warning', () => {
  const code = nodeNamed(buildIngestWorkflow(), 'Upsert store').parameters.jsCode;
  assert.match(code, /CRITICAL MEMORY CONSTRAINT/);
  assert.match(code, /return \[\{/);
  assert.doesNotMatch(code, /issues\.map\(/);
});

test('every generated node type version matches NODE_TYPE_VERSIONS', () => {
  // Verified against the live n8n Cloud instance on 2026-09-06.
  assert.deepEqual(NODE_TYPE_VERSIONS, {
    'n8n-nodes-base.scheduleTrigger': 1.4,
    'n8n-nodes-base.httpRequest': 4.5,
    'n8n-nodes-base.code': 2,
  });
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    for (const node of build().nodes) {
      assert.ok(node.type in NODE_TYPE_VERSIONS, `${node.type} is not documented in NODE_TYPE_VERSIONS`);
      assert.equal(node.typeVersion, NODE_TYPE_VERSIONS[node.type]);
    }
  }
});

// --- The generated Code node text, executed --------------------------------
//
// These run the INLINED source the way n8n does. A build that emits text
// which is not valid standalone JavaScript, or a driver that reads the wrong
// field off an upstream node, fails here rather than at 3am on the instance.

test('the generated "Plan fetch" node builds the GraphQL request from state.json', () => {
  const out = runCodeNode(nodeNamed(buildIngestWorkflow(), 'Plan fetch').parameters.jsCode, {
    nodes: { 'Read state.json': { content: b64(realStateText), sha: 'statesha' } },
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].json.since, '2026-09-06T07:07:12Z');
  assert.equal(out[0].json.body.query, ISSUES_QUERY);
  assert.deepEqual(out[0].json.labels, ALL_FILTER_LABELS);
});

test('the generated "Upsert store" node returns exactly ONE item however many pages arrive', () => {
  const jsCode = nodeNamed(buildIngestWorkflow(), 'Upsert store').parameters.jsCode;
  const pages = [
    page([{ number: 999001, updatedAt: '2026-09-06T08:00:00Z' }]),
    page([{ number: 999002, updatedAt: '2026-09-06T09:00:00Z' }]),
  ];

  const out = runCodeNode(jsCode, {
    items: pages.map(json => ({ json })),
    nodes: {
      'Read issues.ndjson': { data: fixtureText },
      'Read issues.ndjson sha': { sha: 'storesha' },
      'Read state.json': { content: b64(fixtureState(FIXTURE_RECORDS)), sha: 'statesha' },
    },
  });

  assert.equal(out.length, 1, 'the store must never be emitted as one item per issue');
  assert.equal(out[0].json.fetched, 2);
  assert.equal(out[0].json.records, FIXTURE_RECORDS + 2);
  assert.equal(out[0].json.storeSha, 'storesha');
  assert.equal(out[0].json.stateSha, 'statesha');
  const written = Buffer.from(out[0].json.storeContent, 'base64').toString('utf8');
  assert.equal(written.trim().split('\n').length, FIXTURE_RECORDS + 2);
});

test('the generated "Upsert store" node fails the run on a truncated store read', () => {
  // The end-to-end shape of the 1 MB truncation: the Contents API answered
  // 200 with an empty body, so $json.data is "".
  const jsCode = nodeNamed(buildIngestWorkflow(), 'Upsert store').parameters.jsCode;
  assert.throws(() => runCodeNode(jsCode, {
    items: [{ json: page([{ number: 1, updatedAt: '2026-09-06T08:00:00Z' }]) }],
    nodes: {
      'Read issues.ndjson': { data: '' },
      'Read issues.ndjson sha': { sha: 'storesha' },
      'Read state.json': { content: b64(realStateText), sha: 'statesha' },
    },
  }), /read back EMPTY/);
});

test('the generated "Rollup and render" node reads raw text and returns ONE item', () => {
  const jsCode = nodeNamed(buildReportWorkflow(), 'Rollup and render').parameters.jsCode;
  const out = runCodeNode(jsCode, { items: [{ json: { data: fixtureText } }] });

  assert.equal(out.length, 1, 'the report must never be emitted as one item per issue');
  assert.match(out[0].json.path, /^reports\/\d{4}-\d{2}-\d{2}-triage\.md$/);
  const md = Buffer.from(out[0].json.content, 'base64').toString('utf8');
  assert.match(md, /Population: \*\*13\*\*/);
});

test('the generated "Rollup and render" node fails on a truncated store read', () => {
  const jsCode = nodeNamed(buildReportWorkflow(), 'Rollup and render').parameters.jsCode;
  assert.throws(() => runCodeNode(jsCode, { items: [{ json: { data: '' } }] }), /read back EMPTY/);
});

// --- The committed files ----------------------------------------------------

test('workflows/*.json are the current output of the build', () => {
  // The committed workflows went stale once already: they inlined
  // pre-windowing src/lib source. Regenerate with `node build/build-workflows.js`.
  for (const [file, build] of GENERATED_WORKFLOWS) {
    assert.equal(
      readFileSync(`workflows/${file}`, 'utf8'),
      renderWorkflowFile(build),
      `workflows/${file} is stale — run: node build/build-workflows.js`,
    );
  }
});
