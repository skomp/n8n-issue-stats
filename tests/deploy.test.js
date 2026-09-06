// What scripts/deploy.sh would send to n8n's public REST API.
//
// The API is unavailable on this account's plan, so none of this can be
// verified by a call. It is verified against n8n's published OpenAPI schema for
// POST /workflows and PUT /workflows/{id}: `name`, `nodes`, `connections` and
// `settings` required; `active`, `createdAt`, `updatedAt`, `isArchived`,
// `versionId` and `triggerCount` readOnly and rejected; additionalProperties
// false, so an extra property is a 400 and not something the server drops.
//
// A green run here means "the body matches the documented schema". It does not
// mean the script works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  workflowPayload,
  substituteSubWorkflowIds,
  readWorkflow,
  REQUIRED_PROPERTIES,
  READ_ONLY_PROPERTIES,
  OPTIONAL_PROPERTIES,
  SUB_WORKFLOW_NODES,
  DEPLOY_ORDER,
} from '../scripts/deploy-payload.js';
import { SUB_WORKFLOWS } from '../build/build-workflows.js';

const WORKFLOW_FILES = ['workflows/ingest.json', 'workflows/report.json', 'workflows/orchestrator.json'];

// Ids that look like n8n ids but are not the ones compiled into the file, so a
// substitution that silently did nothing cannot pass.
const FRESH = { ingest: 'Zq4rTb8xKm2wLn0P', report: 'Hd7vNc3yRa9sJf5B' };

// ---------------------------------------------------------------------------
// The defect this exists to prevent
// ---------------------------------------------------------------------------

test('every generated workflow file carries a property the API rejects', () => {
  // If this ever stops being true the shaping is no longer load-bearing, and
  // the tests below would pass whether or not it worked.
  for (const file of WORKFLOW_FILES) {
    const workflow = readWorkflow(file);
    const rejected = READ_ONLY_PROPERTIES.filter(k => k in workflow);
    assert.deepEqual(rejected, ['active'], `${file}: unexpected read-only fields on disk`);
  }
});

// ---------------------------------------------------------------------------
// The body, for each real workflow
// ---------------------------------------------------------------------------

for (const file of WORKFLOW_FILES) {
  test(`${file}: the body contains none of the read-only properties`, () => {
    const body = workflowPayload(readWorkflow(file));
    for (const key of READ_ONLY_PROPERTIES) {
      assert.equal(key in body, false, `${key} is readOnly and would be rejected`);
    }
  });

  test(`${file}: the body contains all four required properties`, () => {
    const body = workflowPayload(readWorkflow(file));
    for (const key of REQUIRED_PROPERTIES) {
      assert.notEqual(body[key], undefined, `${key} is required`);
    }
  });

  test(`${file}: the body contains nothing the schema does not accept`, () => {
    // additionalProperties: false — an unlisted key is a validation error.
    const accepted = new Set([...REQUIRED_PROPERTIES, ...OPTIONAL_PROPERTIES]);
    for (const key of Object.keys(workflowPayload(readWorkflow(file)))) {
      assert.equal(accepted.has(key), true, `${key} is not an accepted property`);
    }
  });

  test(`${file}: the kept properties are passed through unchanged`, () => {
    const workflow = readWorkflow(file);
    const body = workflowPayload(workflow);
    for (const key of Object.keys(body)) {
      assert.deepEqual(body[key], workflow[key], `${key} was altered on the way through`);
    }
    // The whole graph travels, not a trimmed one.
    assert.equal(body.nodes.length, workflow.nodes.length);
    assert.ok(body.nodes.length > 0);
  });
}

// ---------------------------------------------------------------------------
// The shaping rule itself
// ---------------------------------------------------------------------------

test('an optional property the schema accepts is kept', () => {
  const body = workflowPayload({
    name: 'w', nodes: [], connections: {}, settings: {}, pinData: { A: [{ json: { x: 1 } }] },
  });
  assert.deepEqual(body.pinData, { A: [{ json: { x: 1 } }] });
});

test('a property the schema does not list is dropped rather than sent', () => {
  const body = workflowPayload({
    name: 'w', nodes: [], connections: {}, settings: {}, meta: { instanceId: 'abc' }, tags: [],
  });
  assert.deepEqual(Object.keys(body), ['name', 'nodes', 'connections', 'settings']);
});

test('a workflow missing a required property is refused, and the message names it', () => {
  assert.throws(
    () => workflowPayload({ name: 'w', nodes: [], connections: {} }),
    err => err.message.includes('settings') && !err.message.includes('connections'),
  );
});

// ---------------------------------------------------------------------------
// Id substitution
// ---------------------------------------------------------------------------

test('substitution points both Execute Workflow nodes at the ids just created', () => {
  const orchestrator = readWorkflow('workflows/orchestrator.json');
  const out = substituteSubWorkflowIds(orchestrator, FRESH);
  const valueOf = (wf, name) => wf.nodes.find(n => n.name === name).parameters.workflowId.value;

  assert.equal(valueOf(out, 'Run ingest'), FRESH.ingest);
  assert.equal(valueOf(out, 'Run report'), FRESH.report);
  // Guards against a substitution that writes the same id into both nodes.
  assert.notEqual(valueOf(out, 'Run ingest'), valueOf(out, 'Run report'));
});

test('substitution keeps the resource locator intact around the id', () => {
  const out = substituteSubWorkflowIds(readWorkflow('workflows/orchestrator.json'), FRESH);
  const locator = out.nodes.find(n => n.name === 'Run ingest').parameters.workflowId;
  assert.equal(locator.__rl, true);
  assert.equal(locator.mode, 'id');
  assert.equal(locator.cachedResultName, SUB_WORKFLOWS.ingest.name);
});

test('substitution changes nothing else in the orchestrator', () => {
  const original = readWorkflow('workflows/orchestrator.json');
  const restored = substituteSubWorkflowIds(
    substituteSubWorkflowIds(original, FRESH),
    { ingest: SUB_WORKFLOWS.ingest.id, report: SUB_WORKFLOWS.report.id },
  );
  // Round-tripping back to the compiled-in ids must reproduce the file exactly:
  // node order, connections, sticky note text, notes, settings, everything.
  assert.deepEqual(restored, original);
});

test('substitution does not mutate the workflow it was given', () => {
  const original = readWorkflow('workflows/orchestrator.json');
  const before = JSON.stringify(original);
  substituteSubWorkflowIds(original, FRESH);
  assert.equal(JSON.stringify(original), before);
});

test('substitution refuses a workflow that has no Execute Workflow node to patch', () => {
  assert.throws(
    () => substituteSubWorkflowIds(readWorkflow('workflows/ingest.json'), FRESH),
    err => err.message.includes('Run ingest') && err.message.includes('Run report'),
  );
});

test('substitution refuses an empty id rather than deploying a broken orchestrator', () => {
  // An id captured from a failed create is the empty string, and an orchestrator
  // carrying one fails at run time, not at deploy time.
  assert.throws(
    () => substituteSubWorkflowIds(readWorkflow('workflows/orchestrator.json'), { ingest: '', report: FRESH.report }),
    /ingest/,
  );
});

test('every node named in SUB_WORKFLOW_NODES exists in the orchestrator', () => {
  const names = readWorkflow('workflows/orchestrator.json').nodes.map(n => n.name);
  for (const nodeName of Object.keys(SUB_WORKFLOW_NODES)) {
    assert.equal(names.includes(nodeName), true, `no node named "${nodeName}"`);
  }
});

// ---------------------------------------------------------------------------
// The CLI scripts/deploy.sh actually calls
// ---------------------------------------------------------------------------

const cli = (...args) => execFileSync(process.execPath, ['scripts/deploy-payload.js', ...args], { encoding: 'utf8' });

test('the CLI emits a body with no read-only properties', () => {
  const body = JSON.parse(cli('payload', 'workflows/report.json'));
  for (const key of READ_ONLY_PROPERTIES) assert.equal(key in body, false, key);
  for (const key of REQUIRED_PROPERTIES) assert.notEqual(body[key], undefined, key);
});

test('the CLI substitutes the ids it is passed and then shapes the body', () => {
  const body = JSON.parse(cli('orchestrator-payload', 'workflows/orchestrator.json', FRESH.ingest, FRESH.report));
  assert.equal(body.nodes.find(n => n.name === 'Run ingest').parameters.workflowId.value, FRESH.ingest);
  assert.equal(body.nodes.find(n => n.name === 'Run report').parameters.workflowId.value, FRESH.report);
  assert.equal('active' in body, false);
});

test('the CLI fails loudly on an unknown command', () => {
  assert.throws(() => cli('deploy', 'workflows/ingest.json'), err => err.status === 1);
});

// ---------------------------------------------------------------------------
// Deploy order
// ---------------------------------------------------------------------------

// The script with its comment block removed: the comments name the same files
// and would otherwise satisfy every assertion below on their own.
const deployScriptCode = () => readFileSync('scripts/deploy.sh', 'utf8')
  .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');

test('deploy.sh deploys the sub-workflows before the orchestrator', () => {
  // The orchestrator's body is built from the ids the first two deployments
  // returned, so the order is a correctness requirement, not a preference.
  const script = deployScriptCode();
  const positions = DEPLOY_ORDER.map(file => {
    const at = script.indexOf(`workflows/${file}`);
    assert.notEqual(at, -1, `deploy.sh never mentions workflows/${file}`);
    return at;
  });
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `deploy.sh deploys out of order: ${DEPLOY_ORDER}`);
});

test('deploy.sh sends a shaped body, never the workflow file itself', () => {
  const script = deployScriptCode();
  const dataArgs = [...script.matchAll(/--data @"([^"]+)"/g)].map(m => m[1]);
  assert.ok(dataArgs.length > 0, 'deploy.sh sends no body at all');
  // Every body sent is the shaped file, which is the one thing the tests above
  // check. The original defect was `--data @"$wf"` over a glob of the
  // repository's own workflow files.
  assert.deepEqual([...new Set(dataArgs)], ['$body']);
  assert.equal(/workflows\/\*\.json/.test(script), false, 'deploy.sh still iterates the workflow glob');
});

// ---------------------------------------------------------------------------
// The script, end to end, against a local stub of the API
//
// This is NOT evidence that deploy.sh works against n8n. The stub answers the
// way the documented schema says n8n answers, and nothing here has ever been
// checked against the real service. What it does prove is the part no unit test
// reaches: the deploy ORDER, and that the orchestrator is sent the ids the two
// sub-workflow deployments actually returned rather than the ids compiled into
// the file. That was the second defect in #8, and it fails at run time rather
// than at deploy time, so it is worth a harness.
//
// 127.0.0.1 only. It never contacts an n8n instance.
// ---------------------------------------------------------------------------

const haveShellTools = spawnSync('sh', ['-c', 'command -v curl && command -v jq'], { stdio: 'ignore' }).status === 0;

// Runs scripts/deploy.sh against a stub and returns every write it attempted.
function runDeployAgainstStub({ existing }) {
  return new Promise((resolve, reject) => {
    const writes = [];
    let created = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') {
          return res.end(JSON.stringify({ data: existing }));
        }
        const body = JSON.parse(raw);
        writes.push({ method: req.method, url: req.url, body, apiKey: req.headers['x-n8n-api-key'] });
        if (req.method === 'POST') {
          created += 1;
          return res.end(JSON.stringify({ id: `NEWID${created}`, name: body.name }));
        }
        return res.end(JSON.stringify({ id: req.url.split('/').pop() }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      execFile('bash', ['scripts/deploy.sh'], {
        env: { ...process.env, N8N_API_KEY: 'stub-key', N8N_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      }, (err, stdout, stderr) => {
        server.close();
        if (err) return reject(new Error(`deploy.sh exited ${err.code}: ${stderr}`));
        resolve({ writes, stdout });
      });
    });
  });
}

const runIngestId = body => body.nodes.find(n => n.name === 'Run ingest').parameters.workflowId.value;
const runReportId = body => body.nodes.find(n => n.name === 'Run report').parameters.workflowId.value;

test('on an instance where nothing exists, the orchestrator gets the ids just created', { skip: haveShellTools ? false : 'curl or jq is not installed' }, async () => {
  const { writes, stdout } = await runDeployAgainstStub({ existing: [] });

  assert.equal(stdout.trim(), 'done');
  assert.deepEqual(writes.map(w => w.method), ['POST', 'POST', 'POST']);
  assert.deepEqual(writes.map(w => w.body.name), [
    SUB_WORKFLOWS.ingest.name,
    SUB_WORKFLOWS.report.name,
    'Triage analytics — sync and report',
  ]);

  // The orchestrator is sent third, carrying the ids the stub allocated to the
  // first two — not AE9bsoYqgcFuz1T3 / yuzPI1WHGOcpzljg, which do not exist on
  // this instance.
  const orchestrator = writes[2].body;
  assert.equal(runIngestId(orchestrator), 'NEWID1');
  assert.equal(runReportId(orchestrator), 'NEWID2');
  assert.notEqual(runIngestId(orchestrator), SUB_WORKFLOWS.ingest.id);
});

test('on an instance where the workflows exist, each one is updated in place', { skip: haveShellTools ? false : 'curl or jq is not installed' }, async () => {
  const existing = [
    { id: SUB_WORKFLOWS.ingest.id, name: SUB_WORKFLOWS.ingest.name },
    { id: SUB_WORKFLOWS.report.id, name: SUB_WORKFLOWS.report.name },
    { id: 'n3cSgsUgaLDg23Wg', name: 'Triage analytics — sync and report' },
  ];
  const { writes } = await runDeployAgainstStub({ existing });

  assert.deepEqual(writes.map(w => w.method), ['PUT', 'PUT', 'PUT']);
  assert.deepEqual(writes.map(w => w.url), [
    `/api/v1/workflows/${SUB_WORKFLOWS.ingest.id}`,
    `/api/v1/workflows/${SUB_WORKFLOWS.report.id}`,
    '/api/v1/workflows/n3cSgsUgaLDg23Wg',
  ]);
  assert.equal(runIngestId(writes[2].body), SUB_WORKFLOWS.ingest.id);
  assert.equal(runReportId(writes[2].body), SUB_WORKFLOWS.report.id);
});

test('no request the script makes carries a property the API rejects', { skip: haveShellTools ? false : 'curl or jq is not installed' }, async () => {
  const { writes } = await runDeployAgainstStub({ existing: [] });
  assert.equal(writes.length, 3);
  for (const write of writes) {
    assert.equal(write.apiKey, 'stub-key');
    for (const key of READ_ONLY_PROPERTIES) {
      assert.equal(key in write.body, false, `${write.body.name}: sent ${key}`);
    }
    for (const key of REQUIRED_PROPERTIES) {
      assert.notEqual(write.body[key], undefined, `${write.body.name}: omitted ${key}`);
    }
  }
});
