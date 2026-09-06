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
  planWrite,
  buildIngestWorkflow,
  buildReportWorkflow,
  buildOrchestratorWorkflow,
  renderWorkflowFile,
  GENERATED_WORKFLOWS,
  GITHUB_CREDENTIAL,
  NODE_TYPE_VERSIONS,
  SUB_WORKFLOWS,
} from '../build/build-workflows.js';
import { ISSUES_QUERY } from '../src/lib/github.js';
import { ALL_FILTER_LABELS } from '../src/lib/labels.js';

const fixtureText = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');
const FIXTURE_RECORDS = 14;

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
//
// A `nodes` entry may be a single json object (a node that emitted one item)
// or an ARRAY of them (a node that emitted several — "Fetch issues" emits one
// item per GraphQL page). Both `.first()` and `.all()` are provided, because
// since the ingest workflow was parallelised "Upsert store" reaches its pages
// through $('Fetch issues').all() rather than through its own $input.
function runCodeNode(jsCode, { items = [], nodes = {} } = {}) {
  const $input = {
    all: () => items,
    first: () => items[0],
  };
  const $ = name => {
    if (!(name in nodes)) throw new Error(`test stub: no node named "${name}"`);
    const list = Array.isArray(nodes[name]) ? nodes[name] : [nodes[name]];
    return {
      first: () => ({ json: list[0] }),
      all: () => list.map(json => ({ json })),
    };
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
    stateText: realStateText, // records: 5464, but only 14 arrived
    pages: [page([])],
  }), /read back 14 record\(s\) but state\.json records 5464/);
});

// --- Report payload: the memory-safety contract, checked by value -----------

test('buildReportPayload folds the whole store into a single object, not an array', () => {
  const payload = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.equal(Array.isArray(payload), false);
  assert.equal(typeof payload.content, 'string');
  assert.equal(payload.path, 'reports/2026-09-06-triage.md');
  // Value check, not shape check: the fixture's known population (14 records).
  assert.match(payload.content, /Population: \*\*14\*\*/);
});

test('buildReportPayload anchors the intake window to the report timestamp, not the clock', () => {
  // The window is 180 days before generatedAt. Pinning two timestamps and
  // checking the WINDOWED POPULATION -- not just the printed date -- is what
  // catches rollup() being called without `now`.
  const early = buildReportPayload(fixtureText, '2026-05-01T00:00:00.000Z');
  assert.match(early.content, /180 days since 2025-11-02/);
  // 6 of the 14 fixture issues were created on or after 2025-11-02.
  assert.match(early.content, /\*\*6\*\* of the 14 triaged issues/);

  const late = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.match(late.content, /180 days since 2026-03-10/);
  // None of the 14 were created on or after 2026-03-10.
  assert.match(late.content, /\*\*0\*\* of the 14 triaged issues/);
});

test('buildReportPayload refuses a truncated store rather than publishing "Population: 0"', () => {
  assert.throws(() => buildReportPayload('', '2026-09-06T00:00:00.000Z'), /read back EMPTY/);
});

// --- Generated workflow structure --------------------------------------------

test('generated workflows carry no instance-specific fields', () => {
  for (const build of [buildIngestWorkflow, buildReportWorkflow, buildOrchestratorWorkflow]) {
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
    'n8n-nodes-base.merge': 3.2,
    'n8n-nodes-base.executeWorkflow': 1.3,
    'n8n-nodes-base.executeWorkflowTrigger': 1.2,
  });
  for (const build of [buildIngestWorkflow, buildReportWorkflow, buildOrchestratorWorkflow]) {
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

  // $input is the Merge barrier's single EMPTY item, exactly as n8n delivers
  // it: chooseBranch/waitForAll with output "empty" pushes one `{ json: {} }`.
  // Every real input is reached by node name.
  const out = runCodeNode(jsCode, {
    items: [{ json: {} }],
    nodes: {
      'Fetch issues': pages,
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
    items: [{ json: {} }],
    nodes: {
      'Fetch issues': [page([{ number: 1, updatedAt: '2026-09-06T08:00:00Z' }])],
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
  assert.match(md, /Population: \*\*14\*\*/);
});

test('the generated "Rollup and render" node fails on a truncated store read', () => {
  const jsCode = nodeNamed(buildReportWorkflow(), 'Rollup and render').parameters.jsCode;
  assert.throws(() => runCodeNode(jsCode, { items: [{ json: { data: '' } }] }), /read back EMPTY/);
});

// --- The parallelised ingest graph ------------------------------------------
//
// The GraphQL fetch and the 2.86 MB store download are independent: the query
// needs only the watermark out of state.json. Running them concurrently is the
// whole point of the Merge barrier, so these assert the SHAPE of the fan-out
// and the fan-in, by target and by input index.

test('the trigger fans out into two concurrent branches', () => {
  const { connections } = buildIngestWorkflow();
  assert.deepEqual(
    connections.Daily.main[0].map(c => c.node),
    ['Read state.json', 'Read issues.ndjson sha'],
    'Daily must start BOTH branches, not one chain',
  );
  // The fetch branch must not wait on the store, and vice versa. Naming the
  // exact successor is what catches a re-serialised graph: a chain would put
  // "Read issues.ndjson sha" downstream of "Read state.json".
  assert.deepEqual(connections['Read state.json'].main[0].map(c => c.node), ['Plan fetch']);
  assert.deepEqual(connections['Plan fetch'].main[0].map(c => c.node), ['Fetch issues']);
  assert.deepEqual(connections['Read issues.ndjson sha'].main[0].map(c => c.node), ['Read issues.ndjson']);
});

test('both branches fan back in to the Merge, on different input indexes', () => {
  const { connections } = buildIngestWorkflow();
  // Connection indexes are 0-BASED on the wire. Input 1 in the UI is index 0.
  assert.deepEqual(connections['Fetch issues'].main[0], [{ node: 'Merge', type: 'main', index: 0 }]);
  assert.deepEqual(connections['Read issues.ndjson'].main[0], [{ node: 'Merge', type: 'main', index: 1 }]);
  // Two branches into two DIFFERENT inputs. Both on index 0 would make the
  // Merge see one input with everything on it and never wait for the other.
  const indexes = [
    connections['Fetch issues'].main[0][0].index,
    connections['Read issues.ndjson'].main[0][0].index,
  ];
  assert.deepEqual([...new Set(indexes)].sort(), [0, 1]);
  assert.deepEqual(connections.Merge.main[0].map(c => c.node), ['Upsert store']);
});

test('the Merge is a synchronisation barrier, never a data join', () => {
  const merge = nodeNamed(buildIngestWorkflow(), 'Merge');
  assert.equal(merge.type, 'n8n-nodes-base.merge');
  assert.equal(merge.typeVersion, 3.2, 'verified against the live instance');
  // Literals on purpose: comparing against the build's own constant would make
  // this agree with whatever the build says.
  assert.deepEqual(merge.parameters, {
    mode: 'chooseBranch',
    numberInputs: 2,
    chooseBranchMode: 'waitForAll',
    output: 'empty',
  });
  // "Fetch issues" emits one item per GraphQL page and the store branch emits
  // one, so any combine mode produces an N x 1 cartesian output and silently
  // multiplies the 2.86 MB store by the page count.
  assert.notEqual(merge.parameters.mode, 'combine');
  assert.ok(!('combineBy' in merge.parameters));
});

test('"Upsert store" reads its pages from "Fetch issues" by name, not from the barrier', () => {
  // The discriminator: $input carries THREE decoy pages, "Fetch issues" carries
  // TWO. A driver that still read $input.all() would report fetched: 3.
  const jsCode = nodeNamed(buildIngestWorkflow(), 'Upsert store').parameters.jsCode;
  const out = runCodeNode(jsCode, {
    items: [
      { json: page([{ number: 111, updatedAt: '2026-09-06T08:00:00Z' }]) },
      { json: page([{ number: 222, updatedAt: '2026-09-06T08:00:00Z' }]) },
      { json: page([{ number: 333, updatedAt: '2026-09-06T08:00:00Z' }]) },
    ],
    nodes: {
      'Fetch issues': [
        page([{ number: 999001, updatedAt: '2026-09-06T08:00:00Z' }]),
        page([{ number: 999002, updatedAt: '2026-09-06T09:00:00Z' }]),
      ],
      'Read issues.ndjson': { data: fixtureText },
      'Read issues.ndjson sha': { sha: 'storesha' },
      'Read state.json': { content: b64(fixtureState(FIXTURE_RECORDS)), sha: 'statesha' },
    },
  });

  assert.equal(out[0].json.fetched, 2, 'the pages must come from $(\'Fetch issues\'), not from $input');
  assert.equal(out[0].json.records, FIXTURE_RECORDS + 2);
  // The decoys must be nowhere in the written store.
  const written = Buffer.from(out[0].json.storeContent, 'base64').toString('utf8');
  assert.ok(written.includes('999001'), 'the fetched issue is missing from the store');
  assert.ok(!written.includes('"number":111'), 'a $input decoy leaked into the store');
});

test('"Upsert store" still reaches state.json across the branch split', () => {
  // state.json moved onto the OTHER branch, so the truncation guard's record
  // count is only reachable by node name. If that reference broke, the guard
  // would silently degrade to the empty-store check alone and a SHORT read
  // would be written back.
  const jsCode = nodeNamed(buildIngestWorkflow(), 'Upsert store').parameters.jsCode;
  assert.throws(() => runCodeNode(jsCode, {
    items: [{ json: {} }],
    nodes: {
      'Fetch issues': [page([])],
      'Read issues.ndjson': { data: fixtureText },   // 14 records
      'Read issues.ndjson sha': { sha: 'storesha' },
      'Read state.json': { content: b64(realStateText), sha: 'statesha' }, // records: 5464
    },
  }), /read back 14 record\(s\) but state\.json records 5464/);
});

// --- Every write is an upsert: send the sha only when the read returned one --

test('planWrite omits the sha on a first-ever write, when the read 404s', () => {
  const body = planWrite(
    { statusCode: 404, body: { message: 'Not Found' } },
    { message: 'publish', content: 'YmFzZTY0', source: 'Read index.html sha' },
  );
  assert.deepEqual(body, { message: 'publish', content: 'YmFzZTY0' });
  assert.ok(!('sha' in body), 'a create must not send a sha');
});

test('planWrite includes the sha the read returned, verbatim', () => {
  const body = planWrite(
    { statusCode: 200, body: { sha: 'd0f4e1c2b3a49586', path: 'index.html' } },
    { message: 'publish', content: 'YmFzZTY0', source: 'Read index.html sha' },
  );
  assert.equal(body.sha, 'd0f4e1c2b3a49586');
  assert.deepEqual(Object.keys(body).sort(), ['content', 'message', 'sha']);
});

test('planWrite refuses a status it cannot interpret rather than guessing', () => {
  // A 500 or a 403 says NOTHING about whether the file exists. Treating it
  // as "no sha" turns a transient upstream failure into a 422 on the write,
  // where the real cause is invisible.
  assert.throws(
    () => planWrite({ statusCode: 500, body: { sha: 'stale111' } }, { message: 'm', content: 'c', source: 'Read report sha' }),
    /HTTP 500[\s\S]*Only 404 means/,
  );
  assert.throws(
    () => planWrite({ statusCode: 403, body: {} }, { message: 'm', content: 'c', source: 'Read report sha' }),
    /HTTP 403/,
  );
});

test('planWrite names the read it was given, so three identical reads stay distinguishable', () => {
  // An unattributed "HTTP 500" from a chain of three identical-looking reads
  // is not actionable.
  assert.throws(
    () => planWrite({ statusCode: 500, body: { sha: 'stale111' } }, { message: 'm', content: 'c', source: 'Read report HTML sha' }),
    /^Error: Read report HTML sha: HTTP 500/,
  );
  assert.throws(
    () => planWrite(undefined, { message: 'm', content: 'c', source: 'Read report sha' }),
    /^Error: Read report sha: the response carried no statusCode/,
  );
});

test('planWrite refuses a 200 that carried no blob sha', () => {
  assert.throws(
    () => planWrite({ statusCode: 200, body: { path: 'index.html' } }, { message: 'm', content: 'c', source: 'Read index.html sha' }),
    /no blob sha/,
  );
  // An empty string is not a sha either — GitHub rejects it with the same 422
  // a missing sha earns, and `typeof '' === 'string'` would wave it through.
  assert.throws(
    () => planWrite({ statusCode: 200, body: { sha: '' } }, { message: 'm', content: 'c', source: 'Read index.html sha' }),
    /no blob sha/,
  );
});

test('planWrite refuses a response with no status code at all', () => {
  // That is what a node without fullResponse returns, and it would make a
  // missing file indistinguishable from an existing one.
  assert.throws(
    () => planWrite({ sha: 'abc' }, { message: 'm', content: 'c', source: 'Read index.html sha' }),
    /no statusCode[\s\S]*fullResponse/,
  );
  assert.throws(
    () => planWrite(undefined, { message: 'm', content: 'c', source: 'Read index.html sha' }),
    /no statusCode/,
  );
});

test('ALL THREE sha reads tolerate a 404 and keep the status code', () => {
  // skomp/n8n-test#2: index.html was the only path that read its sha first.
  // The two dated files did not, so a same-day re-run 422'd on both and left
  // them at their first-run content while index.html advanced.
  const wf = buildReportWorkflow();
  for (const name of ['Read report sha', 'Read report HTML sha', 'Read index.html sha']) {
    const node = nodeNamed(wf, name);
    assert.equal(node.parameters.method, 'GET', `${name} must be a GET`);
    const response = node.parameters.options?.response?.response;
    assert.equal(response?.neverError, true, `${name}: a 404 on a first-ever write must not fail the run`);
    assert.equal(response?.fullResponse, true, `${name}: without the status code a 404 looks like a 200`);
  }
});

test('each sha read points at the path its own write will PUT', () => {
  // A read aimed at the wrong path returns the WRONG FILE's blob sha, and
  // GitHub answers the PUT with 409/422 — or, worse, the read 404s and the
  // write then tries to create a file that already exists.
  const wf = buildReportWorkflow();
  const base = 'https://api.github.com/repos/skomp/n8n-reports/contents/';

  const pairs = [
    ['Read report sha', 'Write report', `={{ "${base}" + $('Rollup and render').first().json.path }}`],
    ['Read report HTML sha', 'Write report HTML', `={{ "${base}" + $('Rollup and render').first().json.htmlPath }}`],
    ['Read index.html sha', 'Write index.html', `${base}index.html`],
  ];
  for (const [readNode, writeNode, url] of pairs) {
    assert.equal(nodeNamed(wf, readNode).parameters.url, url, `${readNode} reads the wrong path`);
    assert.equal(nodeNamed(wf, writeNode).parameters.url, url, `${writeNode} writes a path its read never checked`);
  }
});

// --- The report workflow publishes three files ------------------------------

test('buildReportPayload renders markdown and HTML from one rollup, plus the index path', () => {
  const payload = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.equal(payload.path, 'reports/2026-09-06-triage.md');
  assert.equal(payload.htmlPath, 'reports/2026-09-06-triage.html');
  assert.equal(payload.indexPath, 'index.html');
  // Value checks: the same population must appear in BOTH renderings.
  assert.match(payload.content, /Population: \*\*14\*\*/);
  assert.match(payload.htmlContent, /class="figure"><strong>14<\/strong>/);
});

test('both renderings are anchored to the SAME report timestamp', () => {
  // One rollup, two renderings: if the HTML is rendered against a different
  // `now` it silently publishes a different window from the markdown beside
  // it. Checking the WINDOWED POPULATION, not just the printed date, is what
  // catches the HTML being anchored somewhere else.
  const early = buildReportPayload(fixtureText, '2026-05-01T00:00:00.000Z');
  assert.match(early.content, /180 days since 2025-11-02/);
  assert.match(early.htmlContent, /180 days since 2025-11-02/);
  // 6 of the 14 fixture issues were created on or after 2025-11-02.
  assert.match(early.content, /\*\*6\*\* of the 14 triaged issues/);
  assert.match(early.htmlContent, /<strong>6<\/strong> of the 14 triaged issues/);
  assert.match(early.htmlContent, /<title>n8n triage report — 2026-05-01<\/title>/);

  const late = buildReportPayload(fixtureText, '2026-09-06T00:00:00.000Z');
  assert.match(late.content, /\*\*0\*\* of the 14 triaged issues/);
  assert.match(late.htmlContent, /<strong>0<\/strong> of the 14 triaged issues/);
  assert.match(late.htmlContent, /<title>n8n triage report — 2026-09-06<\/title>/);
});

test('every sha read happens before every write', () => {
  // A read that runs after its own write learns nothing. All three reads have
  // to be upstream of the first PUT.
  const { connections } = buildReportWorkflow();
  const order = ['Weekly'];
  while (connections[order.at(-1)]) order.push(connections[order.at(-1)].main[0][0].node);

  const at = name => {
    const i = order.indexOf(name);
    assert.notEqual(i, -1, `${name} is not on the report workflow's chain`);
    return i;
  };
  const firstWrite = Math.min(at('Write report'), at('Write report HTML'), at('Write index.html'));
  for (const read of ['Read report sha', 'Read report HTML sha', 'Read index.html sha']) {
    assert.ok(at(read) < firstWrite, `${read} must run before any write, not after`);
  }
  assert.ok(at('Plan writes') < firstWrite, 'the write bodies must be planned before the first PUT');
});

test('the report workflow writes the two dated files before index.html', () => {
  // index.html is the pointer at the archive. If a dated write fails, the
  // pointer must NOT already be advanced to a report that is not there.
  const { connections } = buildReportWorkflow();
  assert.deepEqual(connections['Plan writes'].main[0].map(c => c.node), ['Write report']);
  assert.deepEqual(connections['Write report'].main[0].map(c => c.node), ['Write report HTML']);
  assert.deepEqual(connections['Write report HTML'].main[0].map(c => c.node), ['Write index.html']);
  assert.equal(connections['Write index.html'], undefined, 'index.html must be the last write');
});

test('all three writes take their body from "Plan writes", each its own', () => {
  // A write that builds its own body inline is a write that decides about the
  // sha without having read one — the original defect.
  const wf = buildReportWorkflow();
  const bodies = {
    'Write report': 'reportBody',
    'Write report HTML': 'reportHtmlBody',
    'Write index.html': 'indexBody',
  };
  for (const [name, field] of Object.entries(bodies)) {
    assert.equal(
      nodeNamed(wf, name).parameters.jsonBody,
      `={{ $('Plan writes').first().json.${field} }}`,
      `${name} must PUT the body "Plan writes" built for it`,
    );
    assert.equal(nodeNamed(wf, name).parameters.method, 'PUT');
  }
});

// The "Plan writes" node under test, driven with per-file sha reads. Returns
// the three decoded PUT bodies plus the diagnostic `created` map.
function runPlanWrites({ report, reportHtml, index }, rendered) {
  const jsCode = nodeNamed(buildReportWorkflow(), 'Plan writes').parameters.jsCode;
  const out = runCodeNode(jsCode, {
    nodes: {
      'Rollup and render': rendered,
      'Read report sha': report,
      'Read report HTML sha': reportHtml,
      'Read index.html sha': index,
    },
  });
  assert.equal(out.length, 1, '"Plan writes" must emit exactly one item');
  return {
    report: JSON.parse(out[0].json.reportBody),
    reportHtml: JSON.parse(out[0].json.reportHtmlBody),
    index: JSON.parse(out[0].json.indexBody),
    created: out[0].json.created,
  };
}

const RENDERED = {
  path: 'reports/2026-09-06-triage.md',
  content: b64('# md'),
  htmlPath: 'reports/2026-09-06-triage.html',
  htmlContent: b64('<!doctype html>'),
  indexPath: 'index.html',
};

const found = sha => ({ statusCode: 200, body: { sha } });
const missing = { statusCode: 404, body: { message: 'Not Found' } };

test('a first-ever run creates all three files, none of them with a sha', () => {
  const plan = runPlanWrites({ report: missing, reportHtml: missing, index: missing }, RENDERED);

  for (const name of ['report', 'reportHtml', 'index']) {
    assert.ok(!('sha' in plan[name]), `${name}: a create must not send a sha`);
  }
  assert.deepEqual(plan.created, { report: true, reportHtml: true, index: true });
});

test('a SAME-DAY RE-RUN overwrites all three files, each with its OWN sha', () => {
  // This is skomp/n8n-test#2. Before the fix the two dated writes sent no sha
  // whatever the read said, so GitHub answered 422 and both files kept their
  // first-run content while index.html was replaced.
  //
  // Three DIFFERENT shas, deliberately: a blob sha is per file. Reusing one
  // across the three writes is a 409/422 at run time, and a test that fed the
  // same sha to all three could not see it.
  const plan = runPlanWrites(
    { report: found('aaa111'), reportHtml: found('bbb222'), index: found('ccc333') },
    RENDERED,
  );

  assert.equal(plan.report.sha, 'aaa111', 'the markdown write must carry the markdown blob sha');
  assert.equal(plan.reportHtml.sha, 'bbb222', 'the dated HTML write must carry its own blob sha');
  assert.equal(plan.index.sha, 'ccc333', 'index.html must carry the index blob sha');
  assert.deepEqual(plan.created, { report: false, reportHtml: false, index: false });

  // Value check, not shape: each write must carry the CONTENT for its path.
  assert.equal(plan.report.content, RENDERED.content);
  assert.equal(plan.report.message, 'report: reports/2026-09-06-triage.md');
  assert.equal(plan.reportHtml.content, RENDERED.htmlContent);
  assert.equal(plan.reportHtml.message, 'report: reports/2026-09-06-triage.html');
  // index.html is a COPY of the dated HTML, never a second rendering.
  assert.equal(plan.index.content, RENDERED.htmlContent);
});

test('a re-run after a partial failure creates what is missing and overwrites what is there', () => {
  // The state the controller actually hit: the markdown landed, then the run
  // failed. The re-run must overwrite the markdown and create the other two.
  const plan = runPlanWrites(
    { report: found('aaa111'), reportHtml: missing, index: missing },
    RENDERED,
  );
  assert.equal(plan.report.sha, 'aaa111');
  assert.ok(!('sha' in plan.reportHtml), 'a file that does not exist must be created, not updated');
  assert.ok(!('sha' in plan.index));
  assert.deepEqual(plan.created, { report: false, reportHtml: true, index: true });
});

test('"Plan writes" fails the run on a sha read it cannot interpret, naming that read', () => {
  // A 500 on any one of the three reads says nothing about whether that file
  // exists. Guessing turns it into an opaque 422 on the PUT.
  const cases = [
    ['report', 'Read report sha'],
    ['reportHtml', 'Read report HTML sha'],
    ['index', 'Read index.html sha'],
  ];
  for (const [key, nodeName] of cases) {
    const reads = { report: missing, reportHtml: missing, index: missing, [key]: { statusCode: 500, body: { sha: 'stale111' } } };
    assert.throws(
      () => runPlanWrites(reads, RENDERED),
      new RegExp(`${nodeName}: HTTP 500`),
      `a 500 from ${nodeName} must fail the run, not be treated as "file absent"`,
    );
  }
});

test('"Plan writes" fails the run when a sha read lost its status code', () => {
  // What a read without fullResponse returns. Treating it as absent would 422
  // every same-day re-run again.
  assert.throws(
    () => runPlanWrites({ report: { sha: 'aaa111' }, reportHtml: missing, index: missing }, RENDERED),
    /Read report sha: the response carried no statusCode/,
  );
});

test('the generated "Rollup and render" node emits all three files as ONE item', () => {
  const jsCode = nodeNamed(buildReportWorkflow(), 'Rollup and render').parameters.jsCode;
  const out = runCodeNode(jsCode, { items: [{ json: { data: fixtureText } }] });

  assert.equal(out.length, 1, 'the report must never be emitted as one item per issue');
  const j = out[0].json;
  assert.match(j.path, /^reports\/\d{4}-\d{2}-\d{2}-triage\.md$/);
  assert.match(j.htmlPath, /^reports\/\d{4}-\d{2}-\d{2}-triage\.html$/);
  assert.equal(j.indexPath, 'index.html');
  // Decoded VALUES, not the presence of a field.
  const html = Buffer.from(j.htmlContent, 'base64').toString('utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /class="figure"><strong>14<\/strong>/);
  const md = Buffer.from(j.content, 'base64').toString('utf8');
  assert.match(md, /Population: \*\*14\*\*/);
});

// --- Sub-workflow triggers and the orchestrator ------------------------------
//
// The orchestrator exists for ONE reason: the report must be rendered from a
// store the ingest has already refreshed. Everything below defends that
// ordering, because the failure mode is silent — a report over last week's
// store publishes cleanly and the run is green.
//
// Literals on purpose throughout. Comparing against the build's own constants
// would make these tests agree with whatever the build says.

const ORCHESTRATOR_STEPS = [
  ['Run ingest', 'AE9bsoYqgcFuz1T3', 'Triage analytics — ingest'],
  ['Run report', 'yuzPI1WHGOcpzljg', 'Triage analytics — report'],
];

// Walks the connection graph from the trigger and returns the node names in
// execution order. Reading node ORDER out of workflow.nodes would pass on a
// workflow whose wires say the opposite of its array.
const executionOrder = (workflow, from) => {
  const order = [from];
  const { connections } = workflow;
  while (connections[order.at(-1)]) order.push(connections[order.at(-1)].main[0][0].node);
  return order;
};

test('SUB_WORKFLOWS carries the ids the two workflows already have on the instance', () => {
  assert.deepEqual(SUB_WORKFLOWS, {
    ingest: { id: 'AE9bsoYqgcFuz1T3', name: 'Triage analytics — ingest' },
    report: { id: 'yuzPI1WHGOcpzljg', name: 'Triage analytics — report' },
  });
  // The names must be the workflows' OWN names, or the resource locator shows
  // one workflow's name beside another's id.
  assert.equal(buildIngestWorkflow().name, 'Triage analytics — ingest');
  assert.equal(buildReportWorkflow().name, 'Triage analytics — report');
});

test('each sub-workflow carries an Execute Workflow Trigger that takes no input', () => {
  for (const build of [buildIngestWorkflow, buildReportWorkflow]) {
    const trigger = nodeNamed(build(), 'When executed by another workflow');
    assert.ok(trigger, `${build().name} has no Execute Workflow Trigger and cannot be called`);
    assert.equal(trigger.type, 'n8n-nodes-base.executeWorkflowTrigger');
    assert.equal(trigger.typeVersion, 1.2, 'verified against the live instance');
    // passthrough: neither sub-workflow reads caller input, so there is no
    // input schema — and defining one would force the caller to send
    // workflowInputs.
    assert.deepEqual(trigger.parameters, { inputSource: 'passthrough' });
  }
});

test('the ingest sub-workflow trigger starts BOTH branches, exactly as the schedule does', () => {
  // The discriminator. The ingest schedule fans out to two concurrent
  // branches. A sub-workflow trigger wired to only one of them runs half the
  // workflow — it fetches without downloading the store, or downloads without
  // fetching — and the orchestrated run still reports success.
  const { connections } = buildIngestWorkflow();
  const targets = name => connections[name].main[0].map(c => c.node);

  assert.deepEqual(
    targets('When executed by another workflow'),
    ['Read state.json', 'Read issues.ndjson sha'],
    'the sub-workflow trigger must start BOTH branch heads',
  );
  assert.equal(targets('When executed by another workflow').length, 2);
  assert.deepEqual(
    [...targets('When executed by another workflow')].sort(),
    [...targets('Daily')].sort(),
    'an orchestrated run must execute the same graph as the daily run',
  );
});

test('the report sub-workflow trigger starts the same node the weekly schedule starts', () => {
  const { connections } = buildReportWorkflow();
  assert.deepEqual(
    connections['When executed by another workflow'].main[0].map(c => c.node),
    ['Read issues.ndjson'],
  );
  assert.deepEqual(
    connections['When executed by another workflow'],
    connections.Weekly,
    'an orchestrated run must execute the same graph as the weekly run',
  );
});

test('adding the sub-workflow trigger did not rewire either existing graph', () => {
  // The whole existing graph, written out. A new trigger must ADD one key and
  // change nothing else — including the Merge input indexes, which decide
  // whether the barrier waits for both branches or neither.
  const edge = node => ({ node, type: 'main', index: 0 });

  assert.deepEqual(buildIngestWorkflow().connections, {
    Daily: { main: [[edge('Read state.json'), edge('Read issues.ndjson sha')]] },
    'When executed by another workflow': { main: [[edge('Read state.json'), edge('Read issues.ndjson sha')]] },
    'Read state.json': { main: [[edge('Plan fetch')]] },
    'Plan fetch': { main: [[edge('Fetch issues')]] },
    'Read issues.ndjson sha': { main: [[edge('Read issues.ndjson')]] },
    'Fetch issues': { main: [[{ node: 'Merge', type: 'main', index: 0 }]] },
    'Read issues.ndjson': { main: [[{ node: 'Merge', type: 'main', index: 1 }]] },
    Merge: { main: [[edge('Upsert store')]] },
    'Upsert store': { main: [[edge('Write issues.ndjson')]] },
    'Write issues.ndjson': { main: [[edge('Write state.json')]] },
  });

  assert.deepEqual(buildReportWorkflow().connections, {
    Weekly: { main: [[edge('Read issues.ndjson')]] },
    'When executed by another workflow': { main: [[edge('Read issues.ndjson')]] },
    'Read issues.ndjson': { main: [[edge('Rollup and render')]] },
    'Rollup and render': { main: [[edge('Read report sha')]] },
    'Read report sha': { main: [[edge('Read report HTML sha')]] },
    'Read report HTML sha': { main: [[edge('Read index.html sha')]] },
    'Read index.html sha': { main: [[edge('Plan writes')]] },
    'Plan writes': { main: [[edge('Write report')]] },
    'Write report': { main: [[edge('Write report HTML')]] },
    'Write report HTML': { main: [[edge('Write index.html')]] },
  });
});

test('both existing workflows keep their schedule trigger and its cadence', () => {
  // Adding an entry point must not replace one. If the Schedule Trigger were
  // dropped, the daily and weekly cadences would stop the moment this shipped.
  const daily = nodeNamed(buildIngestWorkflow(), 'Daily');
  assert.equal(daily.type, 'n8n-nodes-base.scheduleTrigger');
  assert.deepEqual(daily.parameters.rule.interval, [{ field: 'days', daysInterval: 1 }]);

  const weekly = nodeNamed(buildReportWorkflow(), 'Weekly');
  assert.equal(weekly.type, 'n8n-nodes-base.scheduleTrigger');
  assert.deepEqual(weekly.parameters.rule.interval,
    [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 8 }]);
});

test('the orchestrator runs the ingest FIRST and the report SECOND', () => {
  // The one assertion this workflow exists for. It reads the order off the
  // WIRES and then resolves each step to the workflow id it actually calls, so
  // it fails both when the nodes are swapped and when the two ids are.
  const orchestrator = buildOrchestratorWorkflow();
  const order = executionOrder(orchestrator, 'Weekly');
  assert.deepEqual(order, ['Weekly', 'Run ingest', 'Run report']);

  const calledIds = order
    .map(name => nodeNamed(orchestrator, name))
    .filter(node => node.type === 'n8n-nodes-base.executeWorkflow')
    .map(node => node.parameters.workflowId.value);

  assert.deepEqual(calledIds, ['AE9bsoYqgcFuz1T3', 'yuzPI1WHGOcpzljg'],
    'the ingest must run before the report, or the report renders last week\'s store');
});

test('each Execute Workflow node points at the workflow its name claims', () => {
  const orchestrator = buildOrchestratorWorkflow();
  for (const [nodeName, id, cachedResultName] of ORCHESTRATOR_STEPS) {
    const node = nodeNamed(orchestrator, nodeName);
    assert.ok(node, `the orchestrator has no "${nodeName}" node`);
    assert.equal(node.type, 'n8n-nodes-base.executeWorkflow');
    assert.equal(node.typeVersion, 1.3, 'verified against the live instance');
    // A resource locator, not a bare string. n8n reads `value` for the id.
    assert.deepEqual(node.parameters.workflowId,
      { __rl: true, mode: 'id', value: id, cachedResultName });
  }

  // The two ids must differ. Both pointing at one workflow would run it twice
  // and never produce a report.
  const ids = ORCHESTRATOR_STEPS.map(([name]) =>
    nodeNamed(orchestrator, name).parameters.workflowId.value);
  assert.equal(new Set(ids).size, 2);

  // The cached names are the sub-workflows' real names, so the editor cannot
  // show one workflow's name beside another's id.
  assert.equal(nodeNamed(orchestrator, 'Run ingest').parameters.workflowId.cachedResultName,
    buildIngestWorkflow().name);
  assert.equal(nodeNamed(orchestrator, 'Run report').parameters.workflowId.cachedResultName,
    buildReportWorkflow().name);
});

test('every Execute Workflow node waits for its sub-workflow to finish', () => {
  // Set explicitly although true is the current default. Without the wait,
  // "Run report" starts while the ingest is still fetching and publishes a
  // report over the PREVIOUS store — silently, with a green run.
  for (const [nodeName] of ORCHESTRATOR_STEPS) {
    const node = nodeNamed(buildOrchestratorWorkflow(), nodeName);
    assert.ok('options' in node.parameters,
      `${nodeName} leaves waitForSubWorkflow to the n8n default`);
    assert.equal(node.parameters.options.waitForSubWorkflow, true,
      `${nodeName} must block until its sub-workflow ends`);
  }
});

test('every Execute Workflow node runs once, from the database, with NO workflowInputs', () => {
  for (const [nodeName] of ORCHESTRATOR_STEPS) {
    const { parameters } = nodeNamed(buildOrchestratorWorkflow(), nodeName);
    assert.equal(parameters.mode, 'once', 'one sub-execution, not one per item');
    assert.equal(parameters.source, 'database', 'the sub-workflow is the one stored on this instance');
    // Both triggers are "passthrough", so there is no input schema to fill.
    // The UI initialises this field to { mappingMode: 'defineBelow', value: null }
    // before a schema loads, and that half-built state must never be committed.
    assert.ok(!('workflowInputs' in parameters),
      `${nodeName} emits workflowInputs, which must be absent for a passthrough trigger`);
  }
});

test('the orchestrator matches the report cadence it replaces', () => {
  const orchestrator = buildOrchestratorWorkflow();
  assert.equal(orchestrator.name, 'Triage analytics — sync and report');
  assert.equal(orchestrator.active, false);

  const trigger = nodeNamed(orchestrator, 'Weekly');
  assert.equal(trigger.type, 'n8n-nodes-base.scheduleTrigger');
  assert.equal(trigger.typeVersion, 1.4);
  // Monday 08:00, weekly — the same slot the report already runs in, so
  // swapping to the orchestrator does not move the publish time.
  assert.deepEqual(trigger.parameters.rule.interval,
    [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 8 }]);
  assert.deepEqual(trigger.parameters.rule.interval,
    nodeNamed(buildReportWorkflow(), 'Weekly').parameters.rule.interval);

  // Three nodes, no more. An orchestrator that grew logic of its own would be
  // duplicating what the sub-workflows already do.
  assert.deepEqual(orchestrator.nodes.map(n => n.name), ['Weekly', 'Run ingest', 'Run report']);
});

test('the second Execute Workflow node explains why it must not start early', () => {
  // The ordering constraint is invisible in the editor: both orders draw the
  // same two boxes. The note is where a reader learns that swapping them
  // publishes stale data without failing.
  const note = nodeNamed(buildOrchestratorWorkflow(), 'Run report').notes;
  assert.ok(note, '"Run report" carries no note');
  assert.match(note, /must not start before/i);
  assert.match(note, /stale/i);
  assert.match(note, /waitForSubWorkflow/);
});

test('the build emits exactly three workflow files', () => {
  assert.deepEqual(GENERATED_WORKFLOWS.map(([file]) => file),
    ['ingest.json', 'report.json', 'orchestrator.json']);
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
