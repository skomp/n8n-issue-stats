// Generates the n8n workflow JSON in workflows/ from the pure functions in
// src/lib/. See docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md
// section 9 for the field-stripping contract and section 5 for the memory
// constraint this file is built around.
//
// Node type versions in NODE_TYPE_VERSIONS were VERIFIED against the live n8n
// Cloud instance (2026-09-06). They are no longer guesses.
//
// Two hard platform facts shape the node graph, both measured:
//
//   1. n8n's Code node has NO network access. fetch(), axios, XMLHttpRequest
//      and require of http modules are unavailable and fail at runtime. All
//      HTTP therefore happens in HTTP Request nodes; the Code nodes only
//      transform what those nodes return. assertNoNetworkCalls() below makes
//      this structural rather than a matter of care.
//
//   2. GitHub's Contents API SILENTLY TRUNCATES files over 1 MB: a GET of the
//      2.86 MB issues.ndjson returns HTTP 200 with "encoding": "none" and an
//      EMPTY content field, no error. Reading it needs the
//      Accept: application/vnd.github.raw media type, and every write is
//      guarded by assertStoreIsIntact() so a short read can never overwrite
//      the store with a smaller one.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { rollup } from '../src/lib/rollup.js';
import { renderReport, renderHtml, reportPath, reportHtmlPath, INDEX_PATH } from '../src/lib/report.js';
import { parseStore, serialiseStore, upsert, watermarkOf } from '../src/lib/store.js';
import { ISSUES_QUERY } from '../src/lib/github.js';
import { ALL_FILTER_LABELS } from '../src/lib/labels.js';
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

// Removes named top-level function declarations from module source before it
// is inlined. Used to leave the network-calling functions (fetchPage,
// fetchAll, syncSince) OUT of the Code nodes entirely: they cannot run there
// (fact 1 in the header), and dead code that calls fetch() in a sandbox with
// no network is a trap for the next reader.
//
// Relies on the house style of src/: a top-level declaration ends with a
// closing brace in column 0. Throws if a name is not found, so a rename in
// src/ breaks the build instead of silently inlining the function again.
function dropDeclarations(source, names) {
  let out = source;
  for (const name of names) {
    const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\n\\}\\n`, 'm');
    if (!re.test(out)) {
      throw new Error(`dropDeclarations: no top-level function "${name}" found — was it renamed in src/?`);
    }
    out = out.replace(re, '');
  }
  return out;
}

function readSource(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function readLib(relativePath, { drop = [] } = {}) {
  const raw = readSource(relativePath);
  return inlineModule(drop.length ? dropDeclarations(raw, drop) : raw);
}

function assertFullyInlined(source, label) {
  if (/^\s*(import|export)\b/m.test(source)) {
    throw new Error(`${label}: generated Code node source still contains an import/export keyword`);
  }
}

// Concatenates inlined modules into one Code-node script, dropping identical
// duplicate top-level constants.
//
// Why this exists: src/lib/metrics.js and src/lib/rollup.js each declare
// `const DAY_MS = 86_400_000;`. Inside two ES modules that is correct — each
// is module-scoped. Concatenated into ONE standalone script it is
// "SyntaxError: Identifier 'DAY_MS' has already been declared", which n8n
// raises when the node RUNS, not when the workflow is imported: the workflow
// deploys clean, validates clean, and dies on its first scheduled run.
//
// Only byte-identical declarations are collapsed. Two different declarations
// of one name are a real conflict and throw, because silently keeping the
// first would change behaviour.
function concatModules(sources) {
  const seen = new Map();
  const out = [];
  for (const source of sources) {
    const kept = [];
    for (const line of source.split('\n')) {
      const match = /^(?:const|let) ([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (match && line.trimEnd().endsWith(';')) {
        const name = match[1];
        if (seen.has(name)) {
          if (seen.get(name) !== line) {
            throw new Error(
              `concatModules: two DIFFERENT top-level declarations of "${name}" were inlined:\n` +
              `  ${seen.get(name)}\n  ${line}\nResolve this in src/ before generating.`
            );
          }
          continue; // identical duplicate — safe to drop
        }
        seen.set(name, line);
      }
      kept.push(line);
    }
    out.push(kept.join('\n'));
  }
  return out.join('\n\n');
}

// Backstop for concatModules: catches every remaining top-level name clash,
// including function declarations and multi-line constants it cannot collapse.
function assertNoDuplicateDeclarations(source, label) {
  const seen = new Set();
  const re = /^(?:async function|function|const|let) ([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(re)) {
    if (seen.has(match[1])) {
      throw new Error(
        `${label}: "${match[1]}" is declared twice at the top level of the generated Code node ` +
        'script. n8n raises that as a SyntaxError when the node runs, not when it is imported.'
      );
    }
    seen.add(match[1]);
  }
}

// n8n's Code node sandbox has NO network access; a fetch()/axios call there
// deploys clean, validates clean and dies on the first scheduled run. This
// assertion is what stops that class of bug reaching workflows/*.json.
const NETWORK_CALL_PATTERNS = [
  /\bfetch\s*\(/,
  /\baxios\b/,
  /\bXMLHttpRequest\b/,
  /\brequire\s*\(\s*['"](?:node:)?https?['"]\s*\)/,
];

function assertNoNetworkCalls(source, label) {
  for (const pattern of NETWORK_CALL_PATTERNS) {
    if (pattern.test(source)) {
      throw new Error(
        `${label}: generated Code node source matches ${pattern} — the n8n Code node has no ` +
        'network access. Do the HTTP in an HTTP Request node and transform its output here.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub's secondary (abuse-detection) rate limit
// ---------------------------------------------------------------------------
//
// The local backfill hit GitHub's secondary rate limit around page 20 of 55 on
// two of three runs; a 5-minute cooldown cleared it every time (see
// .superpowers/sdd/2026-09-06-n8n-triage-analytics/batch-c-report.md and
// README.md). fetchAll (src/lib/github.js) also THROWS on a stalled pagination
// cursor — a different, non-retryable failure: retrying would not make the
// cursor advance.
//
// These three helpers serve the LOCAL path (src/backfill.js re-runs) only.
// They are deliberately NOT embedded in the generated workflow any more: the
// GraphQL paging now happens in an HTTP Request node, which cannot call them.
// The workflow mitigates the same limit differently — a 300 ms requestInterval
// between pages, and node-level retries — and an incremental daily run fetches
// one or two pages, not 55, so it is far less exposed than the backfill was.

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

// ---------------------------------------------------------------------------
// Ingest: the pure halves of the workflow, embedded via .toString()
// ---------------------------------------------------------------------------

// GUARD AGAINST SILENT TRUNCATION. Measured on 2026-09-06:
//   GET /repos/skomp/n8n-data/contents/issues.ndjson  (2.86 MB, 5,464 records)
//   -> HTTP 200, "encoding": "none", content: ""      <- no error of any kind
// Followed through the workflow that reads it as base64, the store parses to
// EMPTY, ~20 fetched issues are upserted into it, and the write-back replaces
// 5,464 records with 20 while the run reports success. Irrecoverable.
//
// So: never write a store that came back empty, and never write one that came
// back materially smaller than the record count state.json last recorded. A
// short read must FAIL THE RUN, loudly, before any PUT happens.
//
// There is no bootstrap escape hatch on purpose. The store is created by the
// local backfill (src/backfill.js), never by this workflow, so "the store is
// legitimately empty" is not a state this code can reach.
export const MIN_STORE_FRACTION = 0.9;

export function assertStoreIsIntact(store, state = {}) {
  if (store.size === 0) {
    throw new Error(
      'refusing to write: the store read back EMPTY. GitHub\'s Contents API returns HTTP 200 ' +
      'with an empty content field for files over 1 MB — read issues.ndjson with ' +
      'Accept: application/vnd.github.raw. Writing now would destroy the store.'
    );
  }
  const expected = typeof state.records === 'number' ? state.records : null;
  if (expected !== null && store.size < expected * MIN_STORE_FRACTION) {
    throw new Error(
      `refusing to write: the store read back ${store.size} record(s) but state.json records ` +
      `${expected}. That is below ${MIN_STORE_FRACTION * 100}% of the expected count, so the read ` +
      'was short. Writing now would shrink the store.'
    );
  }
}

// Builds the GraphQL request the HTTP Request node sends. The query and the
// 33-label filter come from src/lib/github.js and src/lib/labels.js verbatim:
// the workflow and the local backfill write to the same NDJSON store, and a
// schema mismatch between them would corrupt it.
export function planFetch(stateText) {
  const state = stateText ? JSON.parse(stateText) : {};
  const since = overlapWindow(state.watermark ?? null);
  return {
    since,
    labels: ALL_FILTER_LABELS,
    body: { query: ISSUES_QUERY, variables: { cursor: null, since, labels: ALL_FILTER_LABELS } },
  };
}

// Flattens the paginated GraphQL responses into one issue array.
//
// GitHub answers a GraphQL error with HTTP 200, so the HTTP Request node
// cannot see it — an errored page would arrive here looking like a page with
// no issues, and would be written back as "nothing changed". Check explicitly.
export function issuesFromPages(pages) {
  const issues = [];
  for (const [index, page] of pages.entries()) {
    if (page?.errors) {
      throw new Error(`GitHub GraphQL (page ${index + 1}): ${page.errors.map(e => e.message).join('; ')}`);
    }
    const nodes = page?.data?.repository?.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error(
        `GitHub GraphQL (page ${index + 1}): response carried no data.repository.issues.nodes — ` +
        'refusing to build a store from an unrecognised response'
      );
    }
    issues.push(...nodes);
  }
  return issues;
}

// The ingest driver, reused between this module (tested directly) and the
// generated "Upsert store" Code node (embedded via .toString()).
//
// CRITICAL MEMORY CONSTRAINT (spec section 5): this returns ONE object holding
// the whole store as text, never one entry per issue.
export function applyPages({ storeText, stateText, pages }) {
  const store = parseStore(storeText ?? '');
  const state = stateText ? JSON.parse(stateText) : {};
  // Before anything else, and before any HTTP write can be reached.
  assertStoreIsIntact(store, state);

  const issues = issuesFromPages(pages);
  upsert(store, issues);
  const watermark = watermarkOf(store);
  // Merge, do not replace: state.json also carries `source` and
  // `backfilledAt`, written by the backfill and not reproducible from here.
  const nextState = { ...state, watermark, records: store.size };

  return {
    storeText: serialiseStore(store),
    stateText: JSON.stringify(nextState, null, 2) + '\n',
    fetched: issues.length,
    records: store.size,
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

// Renders BOTH publications from ONE rollup. The markdown and the HTML are two
// views of the same numbers by construction, so they cannot disagree.
//
// `htmlContent` is published twice per run, unchanged: once at the dated
// archive path and once as index.html. There is deliberately no second
// rendering for the index — "the index is a copy of the latest report" is
// enforced here, by there being only one string.
export function buildReportPayload(storeText, generatedAtISO) {
  const store = parseStore(storeText);
  // The report does not write the store, but publishing "Population: 0" from
  // a truncated read is its own kind of silent wrong answer.
  assertStoreIsIntact(store);
  const issues = [...store.values()];
  // `now` must be the report's own timestamp, not wall-clock time: the 6-month
  // intake window is computed from it, and leaving it to Date.now() makes the
  // report non-deterministic and untestable.
  const r = rollup(issues, { now: new Date(generatedAtISO) });
  const generatedAt = new Date(generatedAtISO);
  return {
    path: reportPath(generatedAt),
    content: renderReport(r, { generatedAt: generatedAtISO }),
    htmlPath: reportHtmlPath(generatedAt),
    htmlContent: renderHtml(r, { generatedAt: generatedAtISO }),
    indexPath: INDEX_PATH,
  };
}

// ---------------------------------------------------------------------------
// index.html: the one write that needs a blob sha, and cannot always have one
// ---------------------------------------------------------------------------
//
// The two dated files are written to a path that is unique per run, so GitHub's
// Contents API creates them and no sha is involved. index.html is OVERWRITTEN
// every run, and the API refuses a PUT over an existing file without the
// current blob sha (422). So the sha has to be read first — except on the very
// first run, when index.html does not exist yet and the read is a 404.
//
// "Read index.html sha" therefore runs with neverError so the 404 does not fail
// the run, and fullResponse so the status code survives to here. This function
// is the whole decision, and it is deliberately strict about which statuses it
// will interpret:
//
//   404          -> the file does not exist. Create it, send NO sha.
//   2xx + sha    -> the file exists. Overwrite it, send the sha.
//   anything else-> throw. A 500 or a 403 says nothing about whether
//                   index.html exists, and guessing "no sha" there turns a
//                   transient upstream failure into a confusing 422 on the
//                   write. Fail on the read instead, where the cause is legible.
export function planIndexWrite(response, { message, content }) {
  const status = response?.statusCode;
  if (typeof status !== 'number') {
    throw new Error(
      'Read index.html sha: the response carried no statusCode. The node must set both ' +
      'fullResponse and neverError, or a missing file cannot be told apart from an existing one.'
    );
  }
  if (status === 404) return { message, content };

  if (status < 200 || status >= 300) {
    throw new Error(
      `Read index.html sha: HTTP ${status}. Only 404 means "index.html does not exist yet"; ` +
      'refusing to guess, because a PUT with no sha over an existing file fails with 422.'
    );
  }

  const sha = response?.body?.sha;
  if (typeof sha !== 'string' || sha === '') {
    throw new Error(
      `Read index.html sha: HTTP ${status} but the response body carried no blob sha. ` +
      'Writing without one would fail with 422.'
    );
  }
  return { message, content, sha };
}

// ---------------------------------------------------------------------------
// Node type versions — verified against the live n8n Cloud instance on
// 2026-09-06. Centralised so a single place documents every one.
// ---------------------------------------------------------------------------

export const NODE_TYPE_VERSIONS = {
  'n8n-nodes-base.scheduleTrigger': 1.4,
  'n8n-nodes-base.httpRequest': 4.5,
  'n8n-nodes-base.code': 2,
  'n8n-nodes-base.merge': 3.2,
};

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const DATA_REPO = 'skomp/n8n-data';
const REPORTS_REPO = 'skomp/n8n-reports';

// The credential already exists on the instance; reference it by id and name
// so the import binds to it instead of creating an empty placeholder. No
// secret material travels in the JSON.
export const GITHUB_CREDENTIAL = { id: '45FxaagCNEF224PE', name: 'GitHub account' };
const githubCredential = { githubApi: GITHUB_CREDENTIAL };

const ACCEPT_JSON = 'application/vnd.github+json';
// The ONLY media type that returns a file over 1 MB intact. See
// assertStoreIsIntact above for what happens without it.
const ACCEPT_RAW = 'application/vnd.github.raw';

function httpRequestNode({
  name, position, method, url, jsonBody, accept = ACCEPT_JSON,
  headers = [], options = {}, notes, retry,
}) {
  const parameters = {
    method,
    url,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'githubApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Accept', value: accept }, ...headers],
    },
  };
  if (jsonBody) {
    parameters.sendBody = true;
    parameters.specifyBody = 'json';
    parameters.jsonBody = jsonBody;
  }
  if (Object.keys(options).length) parameters.options = options;

  const node = {
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.httpRequest'],
    position,
    parameters,
    credentials: githubCredential,
  };
  if (notes) { node.notes = notes; node.notesInFlow = false; }
  if (retry) Object.assign(node, retry);
  return node;
}

// A GET that must return the file BYTES, not the Contents API's JSON envelope.
// responseFormat "text" is set explicitly rather than left to content-type
// autodetection, so the body always lands on $json.data.
function rawReadNode({ name, position, path }) {
  return httpRequestNode({
    name,
    position,
    method: 'GET',
    url: `${GITHUB_API}/repos/${DATA_REPO}/contents/${path}`,
    accept: ACCEPT_RAW,
    options: { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } },
    notes:
      'Accept: application/vnd.github.raw is mandatory. With the default JSON media type the ' +
      'Contents API returns HTTP 200 with an EMPTY content field for files over 1 MB, and ' +
      'issues.ndjson is 2.86 MB. Measured 2026-09-06.',
  });
}

function codeNode({ name, position, jsCode }) {
  assertFullyInlined(jsCode, name);
  assertNoNetworkCalls(jsCode, name);
  assertNoDuplicateDeclarations(jsCode, name);
  return {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.code'],
    position,
    parameters: { mode: 'runOnceForAllItems', jsCode },
  };
}

// A SYNCHRONISATION BARRIER, not a data join.
//
// mode "chooseBranch" with chooseBranchMode "waitForAll" is the only Merge mode
// that waits for every input without combining anything. The combine modes are
// all wrong here: "Fetch issues" emits ONE ITEM PER GRAPHQL PAGE while the
// store branch emits exactly one, so combineAll would produce a cartesian
// N x 1 output and combineByPosition would silently drop every page after the
// first.
//
// output: 'empty' emits exactly ONE item, `{ json: {} }` — verified in n8n's
// own source, packages/nodes-base/nodes/Merge/v3/actions/mode/chooseBranch.ts,
// which pushes a single object rather than returning an empty array. That
// matters: a node that emitted NO items would leave "Upsert store" with no
// input. One empty item is exactly enough to trigger the downstream node and
// nothing more, so the 2.86 MB store is not copied into a second node's output
// (n8n keeps every node's output for the whole execution and saves it with the
// execution record). "Upsert store" reads all four of its inputs by node name
// instead, which is uniform and does not depend on which branch this forwards.
//
// numberInputs is 1-BASED in the UI ("Input 1", "Input 2") and so is
// useDataOfInput, which n8n resolves as inputsData[useDataOfInput - 1]. The
// `index` on a connection is 0-BASED. output: 'empty' uses neither, which is
// one fewer off-by-one to get wrong.
function mergeBarrierNode({ name, position, notes }) {
  return {
    name,
    type: 'n8n-nodes-base.merge',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.merge'],
    position,
    parameters: {
      mode: 'chooseBranch',
      numberInputs: 2,
      chooseBranchMode: 'waitForAll',
      output: 'empty',
    },
    notes,
    notesInFlow: false,
  };
}

// ---------------------------------------------------------------------------
// Generated Code-node bodies
// ---------------------------------------------------------------------------

function buildPlanFetchCode() {
  const lib = concatModules([
    readLib('src/lib/labels.js'),
    // fetchPage/fetchAll make HTTP calls — impossible in a Code node. Only
    // ISSUES_QUERY is needed here; the HTTP Request node does the fetching.
    readLib('src/lib/github.js', { drop: ['fetchPage', 'fetchAll'] }),
    readLib('src/sync.js', { drop: ['syncSince'] }),
  ]);

  const helpers = planFetch.toString();

  const driver = `
// --- n8n driver ---------------------------------------------------------
// ONE item in, ONE item out. This node builds the GraphQL request body for
// the "Fetch issues" HTTP Request node, which does the actual paging: the
// Code node sandbox has NO network access, so nothing here may make an HTTP
// request of any kind.
//
// The query text and the 33-label filter are the inlined source of
// src/lib/github.js and src/lib/labels.js, so the workflow and the local
// backfill (src/backfill.js) always send the identical request. They write to
// the same NDJSON store; a schema mismatch between them would corrupt it.
const stateItem = $('Read state.json').first();
const stateText = Buffer.from(stateItem.json.content ?? '', 'base64').toString('utf8');

const plan = planFetch(stateText);

return [{ json: { since: plan.since, labels: plan.labels, body: plan.body } }];
`.trim();

  return [lib, helpers, driver].join('\n\n');
}

function buildUpsertCode() {
  const lib = readLib('src/lib/store.js');

  const helpers = [
    `const MIN_STORE_FRACTION = ${MIN_STORE_FRACTION};`,
    assertStoreIsIntact.toString(),
    issuesFromPages.toString(),
    applyPages.toString(),
  ].join('\n\n');

  const driver = `
// --- n8n driver ---------------------------------------------------------
// CRITICAL MEMORY CONSTRAINT (spec section 5): this node holds the store as a
// single TEXT string and returns ONE item. Do NOT change it to emit one item
// per issue. n8n holds every node's output array in memory for the whole
// execution; the store holds 5,464+ issues, and one item per issue is the
// exact out-of-memory failure this project exists to avoid.
//
// This node sits behind a Merge barrier that joins two CONCURRENT branches —
// the GraphQL fetch and the 2.86 MB store download — so its own $input is a
// single empty item and carries nothing. Every input is therefore read by node
// NAME, which also means the page count never multiplies the store or the
// state: "Fetch issues" emits one item per GraphQL page, and .all() collects
// them into one array held by this node alone.
//
// $('Read state.json') is on the OTHER branch now. Naming it explicitly is
// what keeps the truncation guard's "records" count reachable from here.
const pages = $('Fetch issues').all().map(item => item.json);
const storeText = $('Read issues.ndjson').first().json.data;
const stateText = Buffer.from($('Read state.json').first().json.content ?? '', 'base64').toString('utf8');

// applyPages() throws BEFORE producing any write payload if the store read
// back empty or short — see assertStoreIsIntact above. Do not catch it: a
// failed run is recoverable, an overwritten store is not.
const result = applyPages({ storeText, stateText, pages });

return [{
  json: {
    storeContent: Buffer.from(result.storeText, 'utf8').toString('base64'),
    // The blob sha changes on every write, so it is re-read each run and
    // never cached.
    storeSha: $('Read issues.ndjson sha').first().json.sha,
    stateContent: Buffer.from(result.stateText, 'utf8').toString('base64'),
    stateSha: $('Read state.json').first().json.sha,
    fetched: result.fetched,
    records: result.records,
    watermark: result.watermark,
  },
}];
`.trim();

  return [lib, helpers, driver].join('\n\n');
}

function buildReportCode() {
  const lib = concatModules([
    readLib('src/lib/labels.js'),
    readLib('src/lib/classify.js'),
    readLib('src/lib/metrics.js'),
    readLib('src/lib/rollup.js'),
    readLib('src/lib/report.js'),
    readLib('src/lib/store.js'),
  ]);

  const helpers = [
    `const MIN_STORE_FRACTION = ${MIN_STORE_FRACTION};`,
    assertStoreIsIntact.toString(),
    buildReportPayload.toString(),
  ].join('\n\n');

  const driver = `
// --- n8n driver ---------------------------------------------------------
// CRITICAL MEMORY CONSTRAINT (spec section 5): this node must receive the
// store as ONE item containing text and must return ONE item containing the
// rendered report. Do NOT change this to emit one item per issue. n8n holds
// every node's output array in memory for the whole execution; the store
// holds 5,464+ issues, and one item per issue is the exact out-of-memory
// failure this project exists to avoid. buildReportPayload() folds the whole
// store into a single object -- keep it that way.
//
// The upstream node reads with Accept: application/vnd.github.raw, so the
// store arrives as text on $json.data, NOT as base64 on $json.content. The
// Contents API's JSON envelope truncates files over 1 MB to an empty string.
const item = $input.first();
const storeText = item.json.data;
const generatedAt = new Date().toISOString();

// generatedAt is threaded all the way into rollup(), so the report's 6-month
// intake window is anchored to the report timestamp printed in its header
// rather than to wall-clock time read somewhere deeper.
const payload = buildReportPayload(storeText, generatedAt);

// Three files per run, from ONE render. The two dated paths are unique per
// run and are created outright; index.html is the same HTML bytes republished
// at the site root, and is the only one that needs a blob sha.
return [{
  json: {
    path: payload.path,
    content: Buffer.from(payload.content, 'utf8').toString('base64'),
    htmlPath: payload.htmlPath,
    htmlContent: Buffer.from(payload.htmlContent, 'utf8').toString('base64'),
    indexPath: payload.indexPath,
  },
}];
`.trim();

  return [lib, helpers, driver].join('\n\n');
}

function buildPlanIndexWriteCode() {
  const helpers = planIndexWrite.toString();

  const driver = `
// --- n8n driver ---------------------------------------------------------
// ONE item in, ONE item out. Pure logic: it decides whether the index.html
// PUT carries a blob sha, from the status code of the read before it.
//
// index.html does not exist on the first run, so that read is a 404 and must
// not fail the workflow -- "Read index.html sha" sets neverError for exactly
// that, and fullResponse so the status code reaches this node at all.
const payload = $('Rollup and render').first().json;
const response = $('Read index.html sha').first().json;

const body = planIndexWrite(response, {
  message: 'report: publish ' + payload.htmlPath + ' as ' + payload.indexPath,
  // The SAME base64 the dated .html write uses. index.html is a copy of the
  // latest report, never a second rendering of it.
  content: payload.htmlContent,
});

return [{ json: { body: JSON.stringify(body), created: body.sha === undefined } }];
`.trim();

  return [helpers, driver].join('\n\n');
}

// ---------------------------------------------------------------------------
// Ingest workflow
// ---------------------------------------------------------------------------

// The HTTP Request node's built-in cursor pagination, driving the GraphQL
// `cursor` variable from the previous response's endCursor.
//
// The parameter sets the WHOLE `variables` object, not a dotted
// "variables.cursor" path: n8n merges the pagination parameters into the
// request body by name, and a name containing a dot is not guaranteed to be
// treated as a path — a flat "variables.cursor" key would leave the real
// cursor at null and re-fetch page 1 until maxRequests, silently. Re-sending
// `since` and `labels` from the input item costs nothing and is correct
// whether n8n merges deeply or replaces the value outright.
//
// Optional chaining is deliberate: on the FIRST request there is no
// $response, and the cursor must resolve to null rather than raise.
const GRAPHQL_PAGINATION = {
  pagination: {
    pagination: {
      paginationMode: 'updateAParameterInEachRequest',
      parameters: {
        parameters: [
          {
            type: 'body',
            name: 'variables',
            value: '={{ { "cursor": $response?.body?.data?.repository?.issues?.pageInfo?.endCursor ?? null, "since": $json.since, "labels": $json.labels } }}',
          },
        ],
      },
      paginationCompleteWhen: 'other',
      // Stops when hasNextPage is false, and also when the shape is not what
      // we expect — an unrecognised page is then rejected loudly by
      // issuesFromPages() rather than paged over 200 times.
      completeExpression: '={{ !$response?.body?.data?.repository?.issues?.pageInfo?.hasNextPage }}',
      // 300 ms between pages: the local backfill tripped GitHub's secondary
      // rate limit around page 20 of 55 when it paged flat out.
      requestInterval: 300,
      // Safety bound. A full backfill is 55 pages; an incremental run is one
      // or two. 200 is far above either and far below an infinite loop.
      limitPagesFetched: true,
      maxRequests: 200,
    },
  },
};

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
      position: [220, -140],
      method: 'GET',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/state.json`,
      notes: 'state.json is 136 bytes, so the JSON envelope returns its content and blob sha intact.',
    }),
    httpRequestNode({
      name: 'Read issues.ndjson sha',
      position: [220, 140],
      method: 'GET',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/issues.ndjson`,
      notes:
        'Metadata only. The blob sha is required by the PUT and changes on every write, so it is ' +
        're-fetched every run and never cached. The content field of this response is EMPTY ' +
        '(the file is over 1 MB) and must not be used — "Read issues.ndjson" fetches the bytes.',
    }),
    rawReadNode({ name: 'Read issues.ndjson', position: [440, 140], path: 'issues.ndjson' }),
    codeNode({ name: 'Plan fetch', position: [440, -140], jsCode: buildPlanFetchCode() }),
    httpRequestNode({
      name: 'Fetch issues',
      position: [660, -140],
      method: 'POST',
      url: GITHUB_GRAPHQL,
      accept: 'application/json',
      headers: [{ name: 'User-Agent', value: 'skomp-n8n-triage-analytics' }],
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: GRAPHQL_PAGINATION,
      notes:
        'The Code node sandbox has no network access, so all GitHub HTTP happens here. Paging is ' +
        'the node\'s built-in cursor pagination over the GraphQL endCursor.',
      retry: { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 },
    }),
    mergeBarrierNode({
      name: 'Merge',
      position: [880, 0],
      notes:
        'Synchronisation barrier, not a data join. Input 1 is the GraphQL fetch (one item per page), ' +
        'input 2 is the store download (one item). chooseBranch / waitForAll holds until BOTH branches ' +
        'finish; output "empty" emits one empty item, so nothing is combined and the 2.86 MB store is ' +
        'not copied into this node\'s output. "Upsert store" reads every input by node name.',
    }),
    codeNode({ name: 'Upsert store', position: [1100, 0], jsCode: buildUpsertCode() }),
    httpRequestNode({
      name: 'Write issues.ndjson',
      position: [1320, 0],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/issues.ndjson`,
      jsonBody: '={{ JSON.stringify({ "message": "sync: " + $json.fetched + " issue(s) fetched, " + $json.records + " stored", "content": $json.storeContent, "sha": $json.storeSha }) }}',
    }),
    httpRequestNode({
      name: 'Write state.json',
      position: [1540, 0],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${DATA_REPO}/contents/state.json`,
      jsonBody: '={{ JSON.stringify({ "message": "sync: watermark " + $(\'Upsert store\').first().json.watermark, "content": $(\'Upsert store\').first().json.stateContent, "sha": $(\'Upsert store\').first().json.stateSha }) }}',
      notes:
        'Runs AFTER the store write, deliberately. If the store write fails the watermark is not ' +
        'advanced and the next run re-fetches the same window; the reverse order would leave a ' +
        'permanent gap.',
    }),
  ];

  // TWO CONCURRENT BRANCHES, joined by a barrier.
  //
  //   Daily ─┬─→ Read state.json → Plan fetch → Fetch issues ──┬─→ Merge
  //          └─→ Read issues.ndjson sha → Read issues.ndjson ──┘
  //   Merge → Upsert store → Write issues.ndjson → Write state.json
  //
  // The two branches are genuinely independent: the GraphQL query needs only
  // the watermark out of state.json, and the 2.86 MB store download needs
  // nothing from the fetch. Running them in series made the slower of the two
  // wait on the other for no reason.
  //
  // What is NOT independent, and is why the barrier exists: "Upsert store"
  // must not run until BOTH have finished, because it reads all four upstream
  // responses by node name.
  //
  // The tail stays strictly ordered. Write issues.ndjson runs before
  // Write state.json so a failed store write leaves the watermark un-advanced
  // and the next run re-fetches the same window; the reverse order would open
  // a permanent gap.
  const fetchBranch = ['Daily', 'Read state.json', 'Plan fetch', 'Fetch issues'];
  const storeBranch = ['Daily', 'Read issues.ndjson sha', 'Read issues.ndjson'];
  const tail = ['Merge', 'Upsert store', 'Write issues.ndjson', 'Write state.json'];

  const connections = {};
  const connect = (from, to, index = 0) => {
    connections[from] ??= { main: [[]] };
    connections[from].main[0].push({ node: to, type: 'main', index });
  };
  const chainUp = names => {
    for (let i = 0; i < names.length - 1; i += 1) connect(names[i], names[i + 1]);
  };

  // Order matters only for readability: "Daily" ends up with both branch heads
  // in one output array, which is how n8n fans out.
  chainUp(fetchBranch);
  chainUp(storeBranch);
  // Merge input INDEXES are 0-based on the wire; the UI labels them Input 1 and
  // Input 2. Input 1 (index 0) is the fetch branch, input 2 (index 1) is the
  // store branch.
  connect('Fetch issues', 'Merge', 0);
  connect('Read issues.ndjson', 'Merge', 1);
  chainUp(tail);

  return {
    name: 'Triage analytics — ingest',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
  };
}

// ---------------------------------------------------------------------------
// Report workflow
// ---------------------------------------------------------------------------

export function buildReportWorkflow() {
  const nodes = [
    {
      name: 'Weekly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.scheduleTrigger'],
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 8 }] } },
    },
    rawReadNode({ name: 'Read issues.ndjson', position: [220, 0], path: 'issues.ndjson' }),
    codeNode({ name: 'Rollup and render', position: [440, 0], jsCode: buildReportCode() }),
    httpRequestNode({
      name: 'Read index.html sha',
      position: [660, 0],
      method: 'GET',
      url: `${GITHUB_API}/repos/${REPORTS_REPO}/contents/${INDEX_PATH}`,
      options: {
        response: {
          response: {
            // neverError: on the FIRST run index.html does not exist and this
            // is a 404. That is a normal state, not a failure, so it must not
            // stop the run. fullResponse: without the status code there is no
            // way to tell "does not exist yet" from "exists but the body was
            // not what we expected", and the two need opposite handling.
            neverError: true,
            fullResponse: true,
          },
        },
      },
      notes:
        'Returns 404 on the first run, before index.html exists — neverError keeps that from failing ' +
        'the workflow, and fullResponse preserves the status code so "Plan index write" can tell a ' +
        'missing file from a present one. The blob sha changes on every write, so it is never cached.',
    }),
    codeNode({ name: 'Plan index write', position: [880, 0], jsCode: buildPlanIndexWriteCode() }),
    httpRequestNode({
      name: 'Write report',
      position: [1100, 0],
      method: 'PUT',
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.path }}`,
      jsonBody: '={{ JSON.stringify({ "message": "report: " + $(\'Rollup and render\').first().json.path, "content": $(\'Rollup and render\').first().json.content }) }}',
      notes:
        'No sha is sent: the path carries the report date, so each weekly run creates a new file. ' +
        'A second run on the same day fails with 422 rather than overwriting — intended.',
    }),
    httpRequestNode({
      name: 'Write report HTML',
      position: [1320, 0],
      method: 'PUT',
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.htmlPath }}`,
      jsonBody: '={{ JSON.stringify({ "message": "report: " + $(\'Rollup and render\').first().json.htmlPath, "content": $(\'Rollup and render\').first().json.htmlContent }) }}',
      notes:
        'The styled HTML twin of the markdown report, at the same dated path. Like the markdown it ' +
        'needs no sha, because the date makes the path unique.',
    }),
    httpRequestNode({
      name: 'Write index.html',
      position: [1540, 0],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${REPORTS_REPO}/contents/${INDEX_PATH}`,
      jsonBody: '={{ $(\'Plan index write\').first().json.body }}',
      notes:
        'The ONLY write that needs a blob sha, because it overwrites the same path every week. ' +
        '"Plan index write" includes the sha only when the read returned one, so the first run ' +
        'creates the file and later runs update it. Runs LAST, deliberately: if a dated write fails, ' +
        'index.html is not left pointing at a report that is missing from the archive.',
    }),
  ];

  const chain = ['Weekly', 'Read issues.ndjson', 'Rollup and render', 'Read index.html sha',
    'Plan index write', 'Write report', 'Write report HTML', 'Write index.html'];
  const connections = {};
  for (let i = 0; i < chain.length - 1; i += 1) {
    connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  }

  return {
    name: 'Triage analytics — report',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
  };
}

// ---------------------------------------------------------------------------
// Serialisation — shared with tests/build.test.js so a stale workflows/*.json
// is a test failure rather than something a reader has to notice.
// ---------------------------------------------------------------------------

export const GENERATED_WORKFLOWS = [
  ['ingest.json', buildIngestWorkflow],
  ['report.json', buildReportWorkflow],
];

export function renderWorkflowFile(build) {
  return JSON.stringify(stripInstanceFields(build()), null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// CLI entry point — only runs when this file is executed directly, never on
// import (tests import stripInstanceFields etc. without generating files).
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const outDir = join(ROOT, 'workflows');
  mkdirSync(outDir, { recursive: true });

  for (const [file, build] of GENERATED_WORKFLOWS) {
    writeFileSync(join(outDir, file), renderWorkflowFile(build));
    console.log(`wrote workflows/${file} (${build().nodes.length} nodes)`);
  }
}
