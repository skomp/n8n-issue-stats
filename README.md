# n8n triage analytics

This project ingests triaged GitHub issues from `n8n-io/n8n` and publishes a
weekly markdown report on issue triage outcomes: a headline stating the
accepted/rejected ratio and how many issues should never have been filed as a
bug, then how many issues are accepted versus rejected, which components carry
the accepted load, rejection reasons, and lead-time statistics. Every grouping
in the report prints its denominator.

## The three repos

- `n8n-io/n8n` — the source. Issues are read via its GraphQL API, filtered to
  the triage/team/closed label taxonomy in `src/lib/labels.js`.
- `skomp/n8n-data` — the data store. Holds the newline-delimited JSON issue
  snapshot (`issues.ndjson`) that this project reads and writes.
- `skomp/n8n-reports` — the dated markdown reports (`reports/YYYY-MM-DD-triage.md`).
- `skomp/n8n-test` (this repo) — the code. Library modules under `src/lib/`,
  the local backfill CLI (`src/backfill.js`), the incremental sync
  (`src/sync.js`), the n8n workflow generator (`build/build-workflows.js`),
  the generated workflow JSON (`workflows/`), and the deploy script
  (`scripts/deploy.sh`).

## Getting a token

The backfill and sync scripts need a GitHub token with `Issues: read` and
`Pull requests: read` scopes on `n8n-io/n8n`. A fine-grained personal access
token works, as does a token from `gh auth token` if your `gh` session already
has read access to that repository. Export it as `GITHUB_TOKEN`.

## Running the backfill

The backfill CLI fetches the full triaged-issue population and writes it to
`data/issues.ndjson`:

```bash
GITHUB_TOKEN=$(gh auth token) node src/backfill.js data/issues.ndjson
```

Measured against the live API: 55 pages, 385 rate-limit points, 5,464 issues,
taking a few minutes. A materially different issue count means the label
filter or pagination changed upstream — investigate before trusting the
output.

Note: GitHub's GraphQL API enforces a secondary (abuse-detection) rate limit
based on request frequency, separate from the point-based primary limit. If a
run fails partway with an HTTP 403 naming a secondary rate limit, wait a few
minutes and re-run the same command; the backfill is not incremental; a
failed run does not write a partial file, so re-running is always safe.

`data/` is git-ignored in this repo — the store belongs in `skomp/n8n-data`,
not here.

## Running the tests

```bash
npm test
```

This runs the full suite with Node's built-in test runner
(`node --test tests/*.test.js`). The project has zero runtime or dev
dependencies. Use the glob form: `node --test tests/` (with a trailing slash)
is broken in Node 24 and silently runs nothing.

### The test fixture

`tests/fixtures/issues.sample.ndjson` holds **12 records: 10 real** ones
captured from the live repository, then **2 synthetic** ones numbered 900001
and 900002. The synthetic records exist because no real record reaches the
merged-PR branch of `componentOf` with an unmerged PR also linked, so the
`mergedAt` filters in `src/lib/classify.js` and `src/lib/metrics.js` had no
test that could fail when they were deleted. Both filters are load-bearing:
55% of linked PRs are never merged.

Do not edit or reorder the 10 real records. Append new synthetic records at
the end of the file, and update the tests that assert fixture-derived counts
(`tests/rollup.test.js`, `tests/report.test.js`, `tests/store.test.js`).

Assert **decoded values**, not shapes. A test that only checks
`median > 0` holds for almost any wrong number.

## Building the workflows

```bash
node build/build-workflows.js
```

Regenerates `workflows/ingest.json` and `workflows/report.json` from the
functions in `src/lib/`. Each Code node's script is the concatenated source of
the relevant `src/lib/*.js` modules (imports and `export` keywords stripped)
followed by a small driver, so the deployed logic is never a re-typed copy of
the tested logic — `tests/build.test.js` exercises the same functions
(`buildReportPayload`, `runIngest`, `fetchAllWithRetry`) that get embedded into
the generated JSON via `Function.prototype.toString()`.

Two constraints are load-bearing here, both from the design spec's section 5:

- The **report** workflow's Code node receives the whole issue store as a
  single item of text and returns a single item holding the rollup. It must
  never emit one item per issue — n8n holds every node's output array in
  memory for the whole run, and one item per issue (5,464+) reproduces the
  out-of-memory failure this project exists to avoid. The generated Code node
  carries a comment saying so.
- The **ingest** workflow's Code node retries GitHub's secondary
  (abuse-detection) rate limit with a 5-minute backoff — the real backfill hit
  it around page 20 of 55 on two of three runs, and a 5-minute cooldown
  cleared it every time. It never retries a stalled pagination cursor
  (`fetchAll` throws on that deliberately): that is a hard failure, not a
  transient one. `isStalledCursorError` / `isSecondaryRateLimitError` /
  `fetchAllWithRetry` in `build/build-workflows.js` implement and test this
  distinction.

Node type versions (`n8n-nodes-base.scheduleTrigger`, `.httpRequest`, `.code`)
could not be read from the live instance — the public API is unavailable on
the free trial. `NODE_TYPE_VERSIONS` in `build/build-workflows.js` documents
the conservative, widely-supported values used instead; confirm them against
the instance before relying on the generated workflows. The same applies to
two structural assumptions baked into the generated JSON: that the Code node
can read `$env.GITHUB_TOKEN`, and that an HTTP Request node's
`predefinedCredentialType: 'githubApi'` is the right way to attach the GitHub
credential — neither is verifiable without the live instance.

## Deployment is blocked on the free trial

Per the design spec's section 9, n8n's public API is unavailable while the
n8n Cloud instance is on the free trial plan. `scripts/deploy.sh` refuses to
run without `N8N_API_KEY` set, printing a message naming the free-trial
limitation and exiting non-zero:

```bash
$ unset N8N_API_KEY; bash scripts/deploy.sh; echo "exit=$?"
scripts/deploy.sh: line 4: N8N_API_KEY: set N8N_API_KEY (Settings > n8n API). ...
exit=1
```

That is the only deploy verification currently possible. Do not expect a
successful deploy against the live instance until the plan changes (upgrade
off the free trial) or an alternative route (e.g. the instance-level MCP
server) is confirmed.
