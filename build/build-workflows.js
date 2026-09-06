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
// Every write is an idempotent upsert: read the sha first, send it only if it
// came back
// ---------------------------------------------------------------------------
//
// GitHub's Contents API refuses a PUT over an EXISTING file without that file's
// current blob sha, and answers 422. It equally refuses a sha for a file that
// does not exist yet. So the sha has to be read first, and the read is a 404
// whenever the file is new.
//
// All THREE files this workflow writes need that treatment, not just
// index.html:
//
//   index.html                       — overwritten every run by design.
//   reports/YYYY-MM-DD-triage.md     — the date makes the path unique per DAY,
//   reports/YYYY-MM-DD-triage.html     not per RUN. A second run on the same
//                                      day hits an existing file and 422s.
//
// That asymmetry was the defect (skomp/n8n-test#2): a same-day re-run updated
// index.html — which supplied a sha and so succeeded — while both dated files
// 422'd and kept their first-run content. The published page and the archived
// report for that date then disagreed.
//
// Each "Read <file> sha" node therefore runs with neverError so a 404 does not
// fail the run, and fullResponse so the status code survives to here. This
// function is the whole decision, and it is deliberately strict about which
// statuses it will interpret:
//
//   404          -> the file does not exist. Create it, send NO sha.
//   2xx + sha    -> the file exists. Overwrite it, send the sha.
//   anything else-> throw. A 500 or a 403 says nothing about whether the file
//                   exists, and guessing "no sha" there turns a transient
//                   upstream failure into a confusing 422 on the write. Fail on
//                   the read instead, where the cause is legible.
//
// `source` names the read node the response came from, so a failure says WHICH
// of the three reads went wrong. With three identical-looking reads in one
// chain, an unattributed "HTTP 500" is not actionable.
export function planWrite(response, { message, content, source }) {
  const status = response?.statusCode;
  if (typeof status !== 'number') {
    throw new Error(
      `${source}: the response carried no statusCode. The node must set both ` +
      'fullResponse and neverError, or a missing file cannot be told apart from an existing one.'
    );
  }
  if (status === 404) return { message, content };

  if (status < 200 || status >= 300) {
    throw new Error(
      `${source}: HTTP ${status}. Only 404 means "the file does not exist yet"; ` +
      'refusing to guess, because a PUT with no sha over an existing file fails with 422.'
    );
  }

  const sha = response?.body?.sha;
  if (typeof sha !== 'string' || sha === '') {
    throw new Error(
      `${source}: HTTP ${status} but the response body carried no blob sha. ` +
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
  'n8n-nodes-base.executeWorkflow': 1.3,
  'n8n-nodes-base.executeWorkflowTrigger': 1.2,
  'n8n-nodes-base.stickyNote': 1,
};

// The two sub-workflows, by the id they already carry on the instance. The
// orchestrator's Execute Workflow nodes address them by id, so these ids are
// deployment facts, not names this build is free to choose: a wrong id points
// the orchestrator at a different workflow and the run still succeeds.
//
// The `name` is the workflow's own name AND the cachedResultName the editor
// shows in the resource locator, so it is defined here once and read back by
// buildIngestWorkflow / buildReportWorkflow. The two cannot drift apart.
export const SUB_WORKFLOWS = {
  ingest: { id: 'AE9bsoYqgcFuz1T3', name: 'Triage analytics \u2014 ingest' },
  report: { id: 'yuzPI1WHGOcpzljg', name: 'Triage analytics \u2014 report' },
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

// A GET whose only purpose is to learn whether a file exists and, if it does,
// what its current blob sha is. Every write in the report workflow is preceded
// by one of these — see planWrite() for why.
//
// The two response options are not optional decoration and are set HERE, in one
// place, so all three reads cannot drift apart:
//
//   neverError:   a 404 means "this file does not exist yet", which is a normal
//                 state and must not stop the run. Without it, the very first
//                 write of any of the three files fails the workflow.
//   fullResponse: without the status code there is no way to tell "does not
//                 exist yet" from "exists but the body was not what we
//                 expected", and the two need opposite handling. planWrite()
//                 throws rather than guess when it is missing.
function shaReadNode({ name, position, url, notes }) {
  return httpRequestNode({
    name,
    position,
    method: 'GET',
    url,
    options: { response: { response: { neverError: true, fullResponse: true } } },
    notes,
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

// A SECOND TRIGGER, added so a workflow can be invoked as a sub-workflow.
//
// A workflow is only callable by an Execute Workflow node if it carries an
// Execute Workflow Trigger. n8n supports several triggers on one workflow and
// each fires its OWN isolated execution, so adding this leaves the existing
// Schedule Trigger and its cadence completely unchanged.
//
// inputSource "passthrough" declares that the sub-workflow takes NO input of
// its own and simply receives whatever the caller sends. Neither sub-workflow
// reads caller input — both start from state.json / issues.ndjson — so there
// is no input schema to define, and defining one would force the caller to
// send `workflowInputs`.
//
// The trigger must fan out to EVERY node the Schedule Trigger starts. The
// ingest's schedule starts two concurrent branches; a sub-workflow trigger
// wired to only one of them would run half the workflow, and the run would
// still report success.
function executeWorkflowTriggerNode({ name, position, notes }) {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.executeWorkflowTrigger'],
    position,
    parameters: { inputSource: 'passthrough' },
    notes,
    notesInFlow: false,
  };
}

// Calls one of the two sub-workflows and WAITS for it.
//
// Three parameters carry the whole contract, and two of them are defaults that
// are set anyway:
//
//   mode "once"                  — one sub-execution for the whole input, not
//                                  one per item. The caller sends a single
//                                  empty item today, but "each" would make the
//                                  node's behaviour depend on upstream item
//                                  count, which is not what this expresses.
//   source "database"            — the sub-workflow is the one stored on this
//                                  instance under `workflowId`, not a URL, a
//                                  parameter or inline JSON.
//   options.waitForSubWorkflow   — set EXPLICITLY although true is the current
//                                  default. Sequential execution is the entire
//                                  reason this workflow exists: without the
//                                  wait, "Run report" starts while the ingest
//                                  is still fetching and publishes a report
//                                  over the PREVIOUS week's store, silently and
//                                  with a green run. Leaving it implicit bets
//                                  the report's correctness on an n8n default
//                                  never changing.
//
// workflowId is a RESOURCE LOCATOR, not a string. mode "id" with the raw id in
// `value`; `cachedResultName` is what the editor renders, and is set so the
// node reads as "Triage analytics — ingest" rather than a bare id.
//
// workflowInputs is DELIBERATELY ABSENT. Both triggers are "passthrough", so
// there is no input schema to fill. The UI initialises the field to
// { mappingMode: 'defineBelow', value: null } before a schema is loaded, and
// emitting that initialisation state into committed JSON is a documented
// footgun — it is a half-built UI state, not a configuration.
function executeWorkflowNode({ name, position, target, notes }) {
  return {
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.executeWorkflow'],
    position,
    parameters: {
      mode: 'once',
      source: 'database',
      workflowId: {
        __rl: true,
        mode: 'id',
        value: target.id,
        cachedResultName: target.name,
      },
      options: { waitForSubWorkflow: true },
    },
    notes,
    notesInFlow: false,
  };
}

// ---------------------------------------------------------------------------
// Sticky notes — canvas documentation
// ---------------------------------------------------------------------------
//
// A sticky note is a NODE with no connections: n8n renders it as a coloured
// rectangle behind the graph, positioned by the same coordinate system the
// functional nodes use. typeVersion 1, verified against the live instance.
//
// They are grouped BY PHASE, never one per node. A note per node would restate
// the node name, which the canvas already shows; the thing a reader cannot get
// from the canvas is why the graph has this shape — why two branches, why a
// barrier, why an extra media type, why the writes are ordered.
//
// Position is the note's TOP-LEFT corner and width/height are its extent, so a
// note occupies [x, x + width] x [y, y + height]. Every note here is placed in
// empty canvas beside or above the group it describes; tests/build.test.js
// asserts that none of them covers a functional node or another note, because
// a note dropped on top of a node hides the node.
function stickyNoteNode({ name, position, width, height, color, content }) {
  return {
    name,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.stickyNote'],
    position,
    parameters: { content, height, width, color },
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

// Three files per run, from ONE render. index.html is the same HTML bytes
// republished at the site root. All three are written as idempotent upserts —
// see planWrite() and "Plan writes" — so a second run on the same day replaces
// the whole set instead of leaving the dated files behind.
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

function buildPlanWritesCode() {
  const helpers = planWrite.toString();

  const driver = `
// --- n8n driver ---------------------------------------------------------
// ONE item in, ONE item out. Pure logic: for each of the three files it
// decides whether the PUT carries a blob sha, from the status code of that
// file's own sha read.
//
// None of the three exists on a first-ever write, so those reads are 404s and
// must not fail the workflow -- each "Read ... sha" node sets neverError for
// exactly that, and fullResponse so the status code reaches this node at all.
//
// The dated paths contain the DATE, not the run, so a second run on the same
// day finds them present and must overwrite them with their current sha. That
// is the whole of skomp/n8n-test#2: index.html used to be the only path that
// did this, so a same-day re-run advanced the published page while both dated
// files stayed at their first-run content.
const payload = $('Rollup and render').first().json;

const report = planWrite($('Read report sha').first().json, {
  message: 'report: ' + payload.path,
  content: payload.content,
  source: 'Read report sha',
});

const reportHtml = planWrite($('Read report HTML sha').first().json, {
  message: 'report: ' + payload.htmlPath,
  content: payload.htmlContent,
  source: 'Read report HTML sha',
});

const index = planWrite($('Read index.html sha').first().json, {
  message: 'report: publish ' + payload.htmlPath + ' as ' + payload.indexPath,
  // The SAME base64 the dated .html write uses. index.html is a copy of the
  // latest report, never a second rendering of it.
  content: payload.htmlContent,
  source: 'Read index.html sha',
});

return [{
  json: {
    reportBody: JSON.stringify(report),
    reportHtmlBody: JSON.stringify(reportHtml),
    indexBody: JSON.stringify(index),
    // Diagnostic only, so the execution log says which of the three were
    // created and which were overwritten.
    created: {
      report: report.sha === undefined,
      reportHtml: reportHtml.sha === undefined,
      index: index.sha === undefined,
    },
  },
}];
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
    executeWorkflowTriggerNode({
      name: 'When executed by another workflow',
      position: [0, 340],
      notes:
        'The second entry point, used by "Triage analytics \u2014 sync and report". It fans out to BOTH ' +
        'branch heads, exactly as "Daily" does — wired to only one of them, an orchestrated run would ' +
        'fetch without downloading the store (or the reverse) and still report success. The daily ' +
        'schedule is untouched: n8n fires each trigger as its own isolated execution.',
    }),
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

    // --- Canvas documentation, one note per PHASE -------------------------
    //
    // Laid out in the empty canvas around the graph: the trigger note to the
    // left of both triggers, the fetch note above its branch, the store note
    // below its branch, and the two tail notes above and below the tail.
    stickyNoteNode({
      name: 'Note: two ways in',
      position: [-320, 0],
      width: 280,
      height: 440,
      color: 7,
      content: [
        '**Two ways in**',
        '',
        'The daily schedule and the orchestrator both start this workflow. n8n fires each trigger ' +
        'as its own isolated execution, and each one fans out to BOTH branches: the fetch and the ' +
        'store download. A trigger wired to only one branch runs half the workflow and still ' +
        'reports success.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: incremental fetch',
      position: [200, -420],
      width: 600,
      height: 240,
      color: 5,
      content: [
        '**Fetch only what changed**',
        '',
        'The watermark in state.json sets the window, minus a 5-minute overlap. Duplicates are ' +
        'cheap because the upsert is keyed on issue number; a gap is silent and permanent. ' +
        'GraphQL with cursor pagination, ascending by updatedAt: descending has a documented race ' +
        'where records shift between pages mid-crawl.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: reading the store intact',
      position: [200, 300],
      width: 400,
      height: 240,
      color: 3,
      content: [
        '**Read the store intact**',
        '',
        '`Accept: application/vnd.github.raw` is mandatory. The Contents API returns HTTP 200 with ' +
        'an EMPTY content field for files over 1 MB, and the store is 2.86 MB. Without it the ' +
        'store reads as empty, and the write at the end of this chain would destroy it.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: the barrier',
      position: [840, -320],
      width: 400,
      height: 240,
      color: 6,
      content: [
        '**A barrier, not a data join**',
        '',
        'chooseBranch / waitForAll / output: empty. It waits for both branches and deliberately ' +
        'passes no data, so the 2.86 MB store is never copied into the memory of a second node. ' +
        '"Upsert store" reads both branches by node name.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: writing back',
      position: [1080, 200],
      width: 620,
      height: 220,
      color: 4,
      content: [
        '**Upsert, then write back**',
        '',
        'Fetched issues merge into the store by issue number. The store is written with the blob ' +
        'sha read earlier, and the watermark last, so a failed store write leaves the window to be ' +
        're-fetched. A guard refuses to write a store smaller than 90% of the count recorded in ' +
        'state.json.',
      ].join('\n'),
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
  //
  // "When executed by another workflow" is a SECOND head on the same two
  // branches. Every trigger of this workflow must reach both branch heads, so
  // the fan-out is generated from one list rather than written twice.
  const TRIGGERS = ['Daily', 'When executed by another workflow'];
  const BRANCH_HEADS = ['Read state.json', 'Read issues.ndjson sha'];
  const fetchBranch = ['Read state.json', 'Plan fetch', 'Fetch issues'];
  const storeBranch = ['Read issues.ndjson sha', 'Read issues.ndjson'];
  const tail = ['Merge', 'Upsert store', 'Write issues.ndjson', 'Write state.json'];

  const connections = {};
  const connect = (from, to, index = 0) => {
    connections[from] ??= { main: [[]] };
    connections[from].main[0].push({ node: to, type: 'main', index });
  };
  const chainUp = names => {
    for (let i = 0; i < names.length - 1; i += 1) connect(names[i], names[i + 1]);
  };

  // Order matters only for readability: each trigger ends up with both branch
  // heads in one output array, which is how n8n fans out.
  for (const trigger of TRIGGERS) {
    for (const head of BRANCH_HEADS) connect(trigger, head);
  }
  chainUp(fetchBranch);
  chainUp(storeBranch);
  // Merge input INDEXES are 0-based on the wire; the UI labels them Input 1 and
  // Input 2. Input 1 (index 0) is the fetch branch, input 2 (index 1) is the
  // store branch.
  connect('Fetch issues', 'Merge', 0);
  connect('Read issues.ndjson', 'Merge', 1);
  chainUp(tail);

  return {
    name: SUB_WORKFLOWS.ingest.name,
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
    executeWorkflowTriggerNode({
      name: 'When executed by another workflow',
      position: [0, 200],
      notes:
        'The second entry point, used by "Triage analytics \u2014 sync and report". It starts the same ' +
        'node the weekly schedule starts, so an orchestrated run and a scheduled run execute an ' +
        'identical graph. The weekly schedule is untouched: n8n fires each trigger as its own ' +
        'isolated execution.',
    }),
    rawReadNode({ name: 'Read issues.ndjson', position: [220, 0], path: 'issues.ndjson' }),
    codeNode({ name: 'Rollup and render', position: [440, 0], jsCode: buildReportCode() }),
    shaReadNode({
      name: 'Read report sha',
      position: [660, 0],
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.path }}`,
      notes:
        'The dated markdown report. 404 the first time this date is written; 200 with the current ' +
        'blob sha on a SAME-DAY RE-RUN, because the path carries the date and not the run. ' +
        '"Plan writes" turns that into a create or an overwrite.',
    }),
    shaReadNode({
      name: 'Read report HTML sha',
      position: [880, 0],
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.htmlPath }}`,
      notes:
        'The dated HTML twin, at the same dated path as the markdown and with the same same-day ' +
        're-run behaviour. Its sha is its own — a blob sha is per FILE, never shared with the ' +
        'markdown beside it.',
    }),
    shaReadNode({
      name: 'Read index.html sha',
      position: [1100, 0],
      url: `${GITHUB_API}/repos/${REPORTS_REPO}/contents/${INDEX_PATH}`,
      notes:
        'Returns 404 on the first run, before index.html exists — neverError keeps that from failing ' +
        'the workflow, and fullResponse preserves the status code so "Plan writes" can tell a ' +
        'missing file from a present one. The blob sha changes on every write, so it is never cached.',
    }),
    codeNode({ name: 'Plan writes', position: [1320, 0], jsCode: buildPlanWritesCode() }),
    httpRequestNode({
      name: 'Write report',
      position: [1540, 0],
      method: 'PUT',
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.path }}`,
      jsonBody: '={{ $(\'Plan writes\').first().json.reportBody }}',
      notes:
        'An idempotent upsert. "Plan writes" includes the sha only when "Read report sha" returned ' +
        'one, so the first write of a date creates the file and a same-day re-run overwrites it. ' +
        'Before skomp/n8n-test#2 this sent no sha at all and a same-day re-run failed with 422.',
    }),
    httpRequestNode({
      name: 'Write report HTML',
      position: [1760, 0],
      method: 'PUT',
      url: `={{ "${GITHUB_API}/repos/${REPORTS_REPO}/contents/" + $('Rollup and render').first().json.htmlPath }}`,
      jsonBody: '={{ $(\'Plan writes\').first().json.reportHtmlBody }}',
      notes:
        'The styled HTML twin of the markdown report, at the same dated path, written the same way: ' +
        'an upsert carrying the sha from "Read report HTML sha" only when that read returned one.',
    }),
    httpRequestNode({
      name: 'Write index.html',
      position: [1980, 0],
      method: 'PUT',
      url: `${GITHUB_API}/repos/${REPORTS_REPO}/contents/${INDEX_PATH}`,
      jsonBody: '={{ $(\'Plan writes\').first().json.indexBody }}',
      notes:
        'Overwrites the same path every week, so from run two onward it always carries a sha. ' +
        'Runs LAST, deliberately: if a dated write fails, index.html is not left pointing at a ' +
        'report that is missing from the archive.',
    }),

    // --- Canvas documentation, one note per PHASE -------------------------
    //
    // The graph is one straight line at y = 0, so every note sits in the empty
    // band above it, tiled left to right over the group it describes. The
    // trigger note is to the left of both triggers.
    stickyNoteNode({
      name: 'Note: two ways in',
      position: [-320, 0],
      width: 280,
      height: 300,
      color: 7,
      content: [
        '**Two ways in**',
        '',
        'The weekly schedule and the orchestrator both start this workflow. n8n fires each trigger ' +
        'as its own isolated execution, and both start the same first node, so an orchestrated run ' +
        'and a scheduled run execute an identical graph.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: one item in, one item out',
      position: [200, -300],
      width: 440,
      height: 260,
      color: 3,
      content: [
        '**One item in, one item out**',
        '',
        'n8n holds every node output array in memory for the whole execution. The store holds ' +
        '5,464 issues, and one item per issue is the out-of-memory failure this project exists to ' +
        'avoid.',
        '',
        'Intake figures use a 180-day window; lead times use all history. Windowing a duration by ' +
        'creation date truncates the slow tail and halves the median.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: read the sha first',
      position: [660, -300],
      width: 780,
      height: 260,
      color: 5,
      content: [
        '**Read the sha before every write**',
        '',
        'Every write looks up its own blob sha first. A 404 means the file does not exist yet, ' +
        'which is not an error: the sha is simply omitted and the write creates the file. That is ' +
        'what makes a same-day re-run safe.',
      ].join('\n'),
    }),
    stickyNoteNode({
      name: 'Note: three files per run',
      position: [1460, -300],
      width: 620,
      height: 260,
      color: 4,
      content: [
        '**Three files, one render**',
        '',
        'Markdown for the archive, HTML for reading, and index.html as the copy the Pages site ' +
        'serves. index.html is written last, so it never points at a report the archive does not ' +
        'hold.',
        '',
        'https://skomp.github.io/n8n-reports/',
      ].join('\n'),
    }),
  ];

  // Every sha read happens BEFORE any write. The reads only need "Rollup and
  // render" for the dated paths, so they could run concurrently, but three
  // more parallel branches would need a second Merge barrier to earn a few
  // hundred milliseconds against a weekly schedule. Straight-line order is
  // what a reader can check.
  //
  // The writes stay dated-first, index.html LAST: index.html is the pointer at
  // the archive, and it must not be advanced to a report the archive does not
  // have.
  //
  // Both triggers start the SAME first node, so an orchestrated run and a
  // scheduled run execute an identical graph.
  const HEAD = 'Read issues.ndjson';
  const TRIGGERS = ['Weekly', 'When executed by another workflow'];
  const chain = [HEAD, 'Rollup and render',
    'Read report sha', 'Read report HTML sha', 'Read index.html sha',
    'Plan writes', 'Write report', 'Write report HTML', 'Write index.html'];
  const connections = {};
  for (const trigger of TRIGGERS) {
    connections[trigger] = { main: [[{ node: HEAD, type: 'main', index: 0 }]] };
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  }

  return {
    name: SUB_WORKFLOWS.report.name,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1' },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator workflow
//
// Slug: n8n-triage-orchestrator. Generated to workflows/orchestrator.json.
// ---------------------------------------------------------------------------

export function buildOrchestratorWorkflow() {
  const nodes = [
    {
      name: 'Weekly',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: NODE_TYPE_VERSIONS['n8n-nodes-base.scheduleTrigger'],
      position: [0, 0],
      parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 8 }] } },
    },
    executeWorkflowNode({
      name: 'Run ingest',
      position: [220, 0],
      target: SUB_WORKFLOWS.ingest,
      notes:
        'Runs the ingest sub-workflow to completion and only then returns. It reaches the ingest ' +
        'through that workflow\'s Execute Workflow Trigger, which fans out to both of its branches, ' +
        'so an orchestrated run does exactly what the daily schedule does.',
    }),
    executeWorkflowNode({
      name: 'Run report',
      position: [440, 0],
      target: SUB_WORKFLOWS.report,
      notes:
        'MUST NOT START BEFORE "Run ingest" HAS FINISHED. The report is rendered from ' +
        'issues.ndjson, which the ingest rewrites; started early it reads the store as it was ' +
        'BEFORE this week\'s sync and publishes a report over stale data. Nothing fails and the run ' +
        'is green — the only symptom is a report that is quietly a week behind. Two things enforce ' +
        'the order: this node is downstream of "Run ingest" on the wire, and "Run ingest" sets ' +
        'options.waitForSubWorkflow explicitly, so it blocks until the ingest sub-execution ends ' +
        'instead of firing it and continuing.',
    }),

    // --- Canvas documentation ---------------------------------------------
    //
    // One note. This workflow is two boxes in a row, and both orders draw the
    // same picture, so the note is the only place the canvas says which order
    // is correct and what the wrong one costs.
    stickyNoteNode({
      name: 'Note: why the order is enforced',
      position: [0, -300],
      width: 640,
      height: 240,
      color: 3,
      content: [
        '**The order is the whole point**',
        '',
        'The report renders from issues.ndjson, which the ingest rewrites. Started early it ' +
        'publishes a report over stale data: nothing fails, the run is green, and the only symptom ' +
        'is a report quietly a week behind. "Run ingest" sets waitForSubWorkflow explicitly for ' +
        'that reason.',
      ].join('\n'),
    }),
  ];

  // A strict two-step chain. There is nothing to parallelise here: the second
  // step consumes what the first one wrote.
  const chain = ['Weekly', 'Run ingest', 'Run report'];
  const connections = {};
  for (let i = 0; i < chain.length - 1; i += 1) {
    connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  }

  return {
    name: 'Triage analytics \u2014 sync and report',
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
  ['orchestrator.json', buildOrchestratorWorkflow],
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
