# Project conventions

## Issue tracking

**GitHub issues**, in `skomp/n8n-issue-stats`. Not a `TODO.md`.

Label every issue Claude creates with `created-by-claude` so automatically
created issues stay identifiable.

## Branching

Push directly to `main`. No pull request required for this project.

## Workflow deployment

The n8n workflows are **deployed but deliberately unpublished** — nothing runs
on a schedule. All three carry a `scheduleTrigger`, so publishing a workflow is
what activates its schedule. Run them manually from the n8n editor until that
changes.

| Workflow | File | id |
|---|---|---|
| Triage analytics — report | `workflows/report.json` | `yuzPI1WHGOcpzljg` |
| Triage analytics — ingest | `workflows/ingest.json` | `AE9bsoYqgcFuz1T3` |
| Triage analytics — sync and report | `workflows/orchestrator.json` | `n3cSgsUgaLDg23Wg` |

The third workflow (slug `n8n-triage-orchestrator`) runs the other two in
sequence. Both of those carry a second trigger, an `executeWorkflowTrigger`, so
they can be called as sub-workflows. Their ids are written down once, in
`SUB_WORKFLOWS` in `build/build-workflows.js`, and the orchestrator's Execute
Workflow nodes read them from there.

**Publish the orchestrator, or the ingest and the report. Never both.** The
orchestrator runs in the same weekly slot as the report (Monday 08:00), so with
all three published the report runs twice a week.

When the orchestrator is deployed, record its id in the table above.

Deployment goes through the instance MCP server, not the public REST API —
the API is unavailable on the n8n Cloud free trial, the MCP server is not
tier-gated. `scripts/deploy.sh` targets the REST API and is for when the
account moves to a paid plan.

**`scripts/deploy.sh` has never been executed.** It conforms to n8n's published
OpenAPI schema and `tests/deploy.test.js` exercises its logic, including a run
against a local stub of the API. That is not the same claim as "it works". Do
not describe it as tested, and do not let a green suite imply a successful
deploy.

Two rules the script depends on, both from that schema:

- The request body carries only `name`, `nodes`, `connections`, `settings` and
  the optional properties the schema accepts. `active` is `readOnly` and both
  request schemas set `additionalProperties: false`, so an extra property is a
  400. The generated files keep `active: false` on purpose; the body is shaped
  in `scripts/deploy-payload.js` instead.
- The two sub-workflows deploy **before** the orchestrator, and the ids the API
  returns are substituted into the orchestrator's Execute Workflow nodes. On a
  new instance the compiled-in ids do not exist. Never restore a glob loop.

## Tests

`npm test` runs `node --test tests/*.test.js`. **Never `node --test tests/`** —
with a trailing slash Node 24 treats the directory as a test file and fails
with `MODULE_NOT_FOUND`.

Zero dependencies, runtime and dev. Do not add any: library source is inlined
into n8n Code nodes, which cannot import.

**Every test must have been watched failing against a broken implementation.**
This suite once had 42 passing tests that could not detect 14 of 17 seeded
bugs. A test you have only ever seen pass has proven nothing.

## Data

- `skomp/n8n-data` — `issues.ndjson` (5,464 records, 2.9 MB) and `state.json`
- `skomp/n8n-reports` — dated reports, published to GitHub Pages at
  https://skomp.github.io/n8n-reports/
- `data/` is gitignored. The store lives in `n8n-data`, not here.

Read `issues.ndjson` with `Accept: application/vnd.github.raw`. The Contents
API returns HTTP 200 with an **empty** content field for files over 1 MB.
