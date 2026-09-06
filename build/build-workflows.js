// Generates the n8n workflow JSON in workflows/ from the pure functions in
// src/lib/. See docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md
// section 9 for the field-stripping contract and section 5 for the memory
// constraint this file is built around.
//
// Node type versions below could not be verified against the live n8n Cloud
// instance (its public API is unavailable on the free trial — see section 9).
// They are conservative, widely-supported guesses. Search NODE_TYPE_VERSIONS
// for the full list; the controller should confirm each one on import.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { rollup } from '../src/lib/rollup.js';
import { renderReport, reportPath } from '../src/lib/report.js';
import { parseStore, serialiseStore, upsert, watermarkOf } from '../src/lib/store.js';
import { fetchAll } from '../src/lib/github.js';
import { overlapWindow } from '../src/sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Field stripping (spec section 9)
// ---------------------------------------------------------------------------

const WORKFLOW_FIELDS = ['id', 'versionId', 'versionCounter', 'activeVersionId',
  'sourceWorkflowId', 'staticData', 'shared', 'createdAt', 'updatedAt', 'activeVersion'];
const NODE_FIELDS = ['id', 'webhookId', 'createdAt', 'updatedAt'];

const omit = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

// Removes instance-specific fields that collide on import to a different n8n
// instance. Idempotent: stripping an already-stripped workflow is a no-op.
export function stripInstanceFields(workflow) {
  const out = omit(workflow, WORKFLOW_FIELDS);
  if (out.meta) out.meta = omit(out.meta, ['instanceId']);
  if (out.nodes) out.nodes = out.nodes.map(n => omit(n, NODE_FIELDS));
  if (out.tags) out.tags = out.tags.map(t => omit(t, ['id']));
  return out;
}

// ---------------------------------------------------------------------------
// Inlining src/lib/*.js into standalone Code-node text
// ---------------------------------------------------------------------------

// n8n's Code node runs a standalone script, not an ES module graph. To keep
// the deployed logic identical to the tested logic, we read the real source
// files and mechanically strip `import` lines and `export ` keywords rather
// than re-typing the logic. Every module here has only relative `./` imports
// and only `export function` / `export async function` / `export const`
// declarations, so this transform is exhaustive for the current codebase —
// if a new export form is added to src/lib/, this will silently leave it
// unexported in the generated script, so a build-time assertion (below)
// checks output has no residual `export`/`import` keywords.
function inlineModule(source) {
  return source
    .split('\n')
    .filter(line => !/^\s*import .* from ['"]\.[^'"]*['"];?\s*$/.test(line))
    .join('\n')
    .replace(/^export (async function|function|const)\b/gm, '$1');
}

function readLib(relativePath) {
  return inlineModule(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function assertFullyInlined(source, label) {
  if (/^\s*(import|export)\b/m.test(source)) {
    throw new Error(`${label}: generated Code node source still contains an import/export keyword`);
  }
}

// ---------------------------------------------------------------------------
// Ingest: retry logic for GitHub's secondary (abuse-detection) rate limit
// ---------------------------------------------------------------------------
//
// The real backfill hit GitHub's secondary rate limit around page 20 of 55 on
// two of three runs; a 5-minute cooldown cleared it every time (see
// .superpowers/sdd/2026-09-06-n8n-triage-analytics/batch-c-report.md and
// README.md). fetchAll (src/lib/github.js) also THROWS on a stalled
// pagination cursor — that is a different, non-retryable failure: retrying it
// would not make the cursor advance. These two functions distinguish them,
// and are exported here so the exact logic embedded in the generated Code
// node (via .toString() below) is the logic covered by tests/build.test.js.

export function isStalledCursorError(err) {
  return typeof err?.message === 'string' && err.message.startsWith('fetchAll: stalled cursor');
}

export function isSecondaryRateLimitError(err) {
  const msg = String(err?.message ?? '');
  return /^GitHub HTTP 403:/.test(msg) && /secondary rate limit|abuse detection/i.test(msg);
}

export async function fetchAllWithRetry(fetchAllFn, opts, {
  maxAttempts = 3,
  waitMs = 5 * 60 * 1000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchAllFn(opts);
    } catch (err) {
      // Hard failure: never retry. A stalled cursor will not un-stall itself.
      if (isStalledCursorError(err)) throw err;
      // Anything that is not the transient secondary rate limit is also a
      // hard failure for this wrapper — only that one condition is retryable.
      if (!isSecondaryRateLimitError(err) || attempt === maxAttempts) throw err;
      lastErr = err;
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// The sync driver, reused between the standalone module (tested directly
// below) and the generated ingest Code node (embedded via .toString()).
// `fetchAllFn` is injectable so tests never make a real network call.
export async function runIngest({ stateText, storeText, token, fetchAllFn = fetchAll }) {
  const store = parseStore(storeText ?? '');
  const state = stateText ? JSON.parse(stateText) : {};
  const since = overlapWindow(state.watermark ?? watermarkOf(store));
  const { issues, pages, points } = await fetchAllWithRetry(fetchAllFn, { token, since });
  upsert(store, issues);
  const watermark = watermarkOf(store);
  return {
    storeText: serialiseStore(store),
    stateText: JSON.stringify({ watermark }, null, 2) + '\n',
    fetched: issues.length,
    pages,
    points,
    watermark,
  };
}

// ---------------------------------------------------------------------------
// Report: single-item-in, single-item-out rollup (spec section 5)
// ---------------------------------------------------------------------------
//
// CRITICAL MEMORY CONSTRAINT: this function returns ONE object, never an
// array with one entry per issue. n8n holds every node's output array in
// memory for the whole execution; a 5,464-item array is the exact
// out-of-memory failure this project exists to avoid. The generated report
// Code node calls this once, on the whole store as one item of text, and
// returns exactly one item holding its result. Do not "helpfully" change
// either side of that contract to emit one item per issue.

export function buildReportPayload(storeText, generatedAtISO) {
  const issues = [...parseStore(storeText).values()];
  const r = rollup(issues);
  const content = renderReport(r, { generatedAt: generatedAtISO });
  const path = reportPath(new Date(generatedAtISO));
  return { path, content };
}

// ---------------------------------------------------------------------------
// Node type versions — see header comment. Centralised so a single place
// documents every guess; the report cites this constant.
// ---------------------------------------------------------------------------

export const NODE_TYPE_VERSIONS = {
  'n8n-nodes-base.scheduleTrigger': 1.2,
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.code': 2,
};

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const DATA_REPO = 'skomp/n8n-data';
const REPORTS_REPO = 'skomp/n8n-reports';

// Credentials travel as name + type only (spec section 9); no id, no secret.
// n8n matches an existing credential of the same type/name on import, or
// creates an empty placeholder — the controller must link the real PAT.
const githubCredential = { githubApi: { name: 'GitHub PAT (triage analytics)' } };

function httpRequestNode({ name, position, method, url, jsonBody }) {
  const parameters = {
    method,
    url,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'githubApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'application/vnd.github+json' }] },
  };
  if (jsonBody) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = jsonBody;
  }
  return {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.httpRequest'],
    position,
    parameters,
    credentials: githubCredential,
  };
}

function codeNode({ name, position, jsCode }) {
  assertFullyInlined(jsCode, name);
  return {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.code'],
    position,
    parameters: { mode: 'runOnceForAllItems', jsCode },
  };
}

function buildIngestCode() {
  const lib = [
    readLib('src/lib/labels.js'),
    readLib('src/lib/github.js'),
    readLib('src/lib/store.js'),
    readLib('src/sync.js'),
  ].join('\n\n');

  const helpers = [
    isStalledCursorError.toString(),
    isSecondaryRateLimitError.toString(),
    fetchAllWithRetry.toString(),
    runIngest.toString(),
  ].join('\n\n');

  const driver = `
// --- n8n driver ---------------------------------------------------------
// This node receives one item per upstream HTTP Request (the GitHub Contents
// API responses for state.json and issues.ndjson, connected into the same
// input). It reads both, runs the sync, and returns a SINGLE item: the two
// downstream "Write" HTTP Request nodes both read their own field off this
// one item, so the item count does not multiply with store size.
const inputs = $input.all();
const stateItem = inputs.find(i => typeof i.json.path === 'string' && i.json.path.endsWith('state.json'));
const storeItem = inputs.find(i => typeof i.json.path === 'string' && i.json.path.endsWith('issues.ndjson'));

const stateText = stateItem ? Buffer.from(stateItem.json.content, 'base64').toString('utf8') : null;
const storeText = storeItem ? Buffer.from(storeItem.json.content, 'base64').toString('utf8') : '';
// ASSUMPTION (unverifiable on the free trial): the instance permits Code-node
// access to environment variables. Verify against N8N_BLOCK_ENV_ACCESS_IN_NODE.
const token = $env.GITHUB_TOKEN;

const result = await runIngest({ stateText, storeText, token });

return [{
  json: {
    stateContent: Buffer.from(result.stateText, 'utf8').toString('base64'),
    stateSha: stateItem ? stateItem.json.sha : undefined,
    storeContent: Buffer.from(result.storeText, 'utf8').toString('base64'),
    storeSha: storeItem ? storeItem.json.sha : undefined,
    fetched: result.fetched,
    watermark: result.watermark,
  },
}];
`.trim();

  return [lib, helpers, driver].join('\n\n');
}

function buildReportCode() {
  const lib = [
    readLib('src/lib/labels.js'),
    readLib('src/lib/classify.js'),
    readLib('src/lib/metrics.js'),
    readLib('src/lib/rollup.js'),
    readLib('src/lib/report.js'),
    readLib('src/lib/store.js'),
  ].join('\n\n');

  const helpers = buildReportPayload.toString();

  const driver = `
// --- n8n driver ---------------------------------------------------------
// CRITICAL MEMORY CONSTRAINT (spec section 5): this node must receive the
// store as ONE item containing text and must return ONE item containing the
// rollup. Do NOT change this to emit one item per issue. n8n holds every
// node's output array in memory for the whole execution; the store holds
// 5,464+ issues, and one item per issue is the exact out-of-memory failure
// this project exists to avoid. buildReportPayload() folds the whole store
// into a single object -- keep it that way.
const item = $input.first();
const storeText = Buffer.from(item.json.content, 'base64').toString('utf8');
const generatedAt = new Date().toISOString();

const payload = buildReportPayload(storeText, generatedAt);

return [{
  json: {
    path: payload.path,
    content: Buffer.from(payload.content, 'utf8').toString('base64'),
  },
}];
`.trim();

  return [lib, helpers, driver].join('\n\n');
}

export function buildIngestWorkflow() {
  const nodes = [
    {
      name: 'Daily',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.scheduleTrigger'],
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1 }] } },
    },
    httpRequestNode({
      name: 'Read state.json',
      position: [240, -80],
      method: 'GET',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/state.json`,
    }),
    httpRequestNode({
      name: 'Read issues.ndjson',
      position: [240, 80],
      method: 'GET',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/issues.ndjson`,
    }),
    codeNode({ name: 'Sync', position: [480, 0], jsCode: buildIngestCode() }),
    httpRequestNode({
      name: 'Write state.json',
      position: [720, -80],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/state.json`,
      jsonBody: '={{ { "message": "sync: update watermark", "content": $json.stateContent, "sha": $json.stateSha } }}',
    }),
    httpRequestNode({
      name: 'Write issues.ndjson',
      position: [720, 80],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/issues.ndjson`,
      jsonBody: '={{ { "message": "sync: " + $json.fetched + " issue(s) fetched", "content": $json.storeContent, "sha": $json.storeSha } }}',
    }),
  ];

  const connections = {
    Daily: { main: [[{ node: 'Read state.json', type: 'main', index: 0 }, { node: 'Read issues.ndjson', type: 'main', index: 0 }]] },
    'Read state.json': { main: [[{ node: 'Sync', type: 'main', index: 0 }]] },
    'Read issues.ndjson': { main: [[{ node: 'Sync', type: 'main', index: 0 }]] },
    Sync: { main: [[{ node: 'Write state.json', type: 'main', index: 0 }, { node: 'Write issues.ndjson', type: 'main', index: 0 }]] },
  };

  return {
    name: 'Triage analytics — ingest',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
  };
}

export function buildReportWorkflow() {
  const nodes = [
    {
      name: 'Weekly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.scheduleTrigger'],
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 8 }] } },
    },
    httpRequestNode({
      name: 'Read issues.ndjson',
      position: [240, 0],
      method: 'GET',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/issues.ndjson`,
    }),
    codeNode({ name: 'Rollup and render', position: [480, 0], jsCode: buildReportCode() }),
    httpRequestNode({
      name: 'Write report',
      position: [720, 0],
      method: 'PUT',
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $json.path }}`,
      jsonBody: '={{ { "message": "report: " + $json.path, "content": $json.content } }}',
    }),
  ];

  const connections = {
    Weekly: { main: [[{ node: 'Read issues.ndjson', type: 'main', index: 0 }]] },
    'Read issues.ndjson': { main: [[{ node: 'Rollup and render', type: 'main', index: 0 }]] },
    'Rollup and render': { main: [[{ node: 'Write report', type: 'main', index: 0 }]] },
  };

  return {
    name: 'Triage analytics — report',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when this file is executed directly, never on
// import (tests import stripInstanceFields etc. without generating files).
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const outDir = join(ROOT, 'workflows');
  mkdirSync(outDir, { recursive: true });

  for (const [file, build] of [
    ['ingest.json', buildIngestWorkflow],
    ['report.json', buildReportWorkflow],
  ]) {
    const workflow = stripInstanceFields(build());
    writeFileSync(join(outDir, file), JSON.stringify(workflow, null, 2) + '\n');
    console.log(`wrote workflows/${file} (${workflow.nodes.length} nodes)`);
  }
}
