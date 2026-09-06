// Shapes a generated workflow file into the request body n8n's public REST API
// accepts, and rewrites the orchestrator's sub-workflow ids to the ids the
// instance actually allocated.
//
// Why this is JavaScript and not jq inside scripts/deploy.sh: neither piece can
// be exercised against the API (the public API is unavailable on the free
// trial, see README "Deployment"), so the only verification available is a
// unit test. `node --test tests/*.test.js` can test a function; it cannot test
// an expression embedded in a shell pipeline without reimplementing it. The
// script calls this file, so the tested code is the deployed code.
//
// The contract below is n8n's published OpenAPI spec for POST /workflows and
// PUT /workflows/{id} (https://docs.n8n.io/api/api-reference/), NOT a
// measurement. Nothing here has ever been sent to the API.

import { readFileSync } from 'node:fs';

// Exactly the properties both schemas mark required.
export const REQUIRED_PROPERTIES = ['name', 'nodes', 'connections', 'settings'];

// Optional and accepted in a request body. `projectId` is POST-only; sending
// it on a PUT is a validation error, so it is not shaped in here — the deploy
// script never sets it.
export const OPTIONAL_PROPERTIES = ['description', 'nodeGroups', 'staticData', 'pinData', 'parentFolderId'];

// `readOnly: true` in the schema. The API rejects these in a request body; it
// does not ignore them. `active` is the one the generator actually emits.
export const READ_ONLY_PROPERTIES = ['active', 'createdAt', 'updatedAt', 'isArchived', 'versionId', 'triggerCount'];

// Both schemas set additionalProperties: false, so an unlisted property is a
// 400 rather than something the server drops. The body is therefore built by
// picking from an allow-list, never by deleting from a deny-list: a property a
// future generator adds is left out by default instead of being sent.
const ACCEPTED_PROPERTIES = [...REQUIRED_PROPERTIES, ...OPTIONAL_PROPERTIES];

// The orchestrator's Execute Workflow nodes, by node name, and which
// SUB_WORKFLOWS key supplies the id each one must carry after deployment.
export const SUB_WORKFLOW_NODES = { 'Run ingest': 'ingest', 'Run report': 'report' };

// Deployment order. The orchestrator is deployed last because its body is
// built from the ids the first two deployments returned.
export const DEPLOY_ORDER = ['ingest.json', 'report.json', 'orchestrator.json'];

// Builds the request body from a workflow object: only accepted properties,
// and only the ones actually present.
export function workflowPayload(workflow) {
  const missing = REQUIRED_PROPERTIES.filter(k => workflow[k] === undefined);
  if (missing.length) {
    throw new Error(`workflow "${workflow.name ?? '(unnamed)'}" is missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`);
  }
  const body = {};
  for (const key of ACCEPTED_PROPERTIES) {
    if (workflow[key] !== undefined) body[key] = workflow[key];
  }
  return body;
}

// Returns a copy of the orchestrator whose Execute Workflow nodes address the
// ids given, leaving every other byte of the workflow alone. Does not mutate
// its argument.
//
// Matching by name is what makes a fresh instance allocate NEW ids, so the ids
// compiled into the file by SUB_WORKFLOWS are only correct on the instance they
// were read from. This is the substitution that makes a deploy to any other
// instance produce a working orchestrator.
export function substituteSubWorkflowIds(workflow, ids) {
  const wanted = Object.entries(SUB_WORKFLOW_NODES);
  for (const [nodeName, key] of wanted) {
    if (typeof ids[key] !== 'string' || ids[key] === '') {
      throw new Error(`no id supplied for "${key}" (needed by the "${nodeName}" node)`);
    }
  }
  const seen = new Set();
  const nodes = workflow.nodes.map(node => {
    const key = SUB_WORKFLOW_NODES[node.name];
    if (key === undefined) return node;
    if (node.parameters?.workflowId?.value === undefined) {
      throw new Error(`node "${node.name}" has no parameters.workflowId.value to substitute`);
    }
    seen.add(node.name);
    return {
      ...node,
      parameters: {
        ...node.parameters,
        workflowId: { ...node.parameters.workflowId, value: ids[key] },
      },
    };
  });
  const unmatched = wanted.map(([name]) => name).filter(name => !seen.has(name));
  if (unmatched.length) {
    throw new Error(`workflow "${workflow.name ?? '(unnamed)'}" has no node named ${unmatched.map(n => `"${n}"`).join(' or ')}`);
  }
  return { ...workflow, nodes };
}

export function readWorkflow(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// CLI — the interface scripts/deploy.sh uses. Writes the body to stdout.
//
//   node scripts/deploy-payload.js payload <file>
//   node scripts/deploy-payload.js orchestrator-payload <file> <ingestId> <reportId>
// ---------------------------------------------------------------------------

export function runCli(argv) {
  const [command, file, ...rest] = argv;
  if (command === 'payload') {
    if (!file || rest.length) throw new Error('usage: payload <file>');
    return JSON.stringify(workflowPayload(readWorkflow(file)));
  }
  if (command === 'orchestrator-payload') {
    const [ingest, report] = rest;
    if (!file || rest.length !== 2) throw new Error('usage: orchestrator-payload <file> <ingestId> <reportId>');
    return JSON.stringify(workflowPayload(substituteSubWorkflowIds(readWorkflow(file), { ingest, report })));
  }
  throw new Error(`unknown command "${command ?? ''}": expected payload or orchestrator-payload`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    process.stdout.write(runCli(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
