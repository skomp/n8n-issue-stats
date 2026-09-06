# n8n triage analytics

This project ingests triaged GitHub issues from `n8n-io/n8n` and publishes a
weekly markdown report on issue triage outcomes: how many issues are accepted
versus rejected, which components carry the accepted load, rejection reasons,
and lead-time statistics.

## The three repos

- `n8n-io/n8n` — the source. Issues are read via its GraphQL API, filtered to
  the triage/team/closed label taxonomy in `src/lib/labels.js`.
- `skomp/n8n-data` — the data store. Holds the newline-delimited JSON issue
  snapshot (`issues.ndjson`) that this project reads and writes.
- `skomp/n8n-test` (this repo) — the code. Library modules under `src/lib/`,
  the local backfill CLI (`src/backfill.js`), the incremental sync
  (`src/sync.js`), and (once built) the n8n workflow deploy under `build/` and
  `scripts/`.

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
dependencies.

## Deployment is blocked on the free trial

Per the design spec's section 9, n8n's public API is unavailable while the
n8n Cloud instance is on the free trial plan. `scripts/deploy.sh` and the
workflow build in `build/` can be exercised offline, but do not expect a
successful deploy against a live n8n instance until the plan changes or an
alternative (e.g. an MCP-based) deployment route is confirmed.
