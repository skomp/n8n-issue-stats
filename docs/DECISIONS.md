# n8n GitHub analytics — running decisions log

Started 2026-09-06. Brainstorm in progress; this file exists so the work survives
a lost session. Supersede it with the real spec when the design is agreed.

## Goal (one sentence)

Ingest all issues and PRs from `n8n-io/n8n`, classify them by component and
severity, compute lead times, and publish stats — built offline, deployed to
n8n Cloud as code, and memory-bounded so the aggregation cannot OOM again.

## Fixed context

- n8n Cloud instance: `skomp.app.n8n.cloud`. Not self-hosted.
- Project repo: `skomp/n8n-test` (public, empty).
- Data store repo: `skomp/n8n-data` (public, empty).
- Reports repo: `skomp/n8n-reports` (public, empty).
- Instance MCP server registered locally: `https://skomp.app.n8n.cloud/mcp-server/http`
  (this is n8n's *instance management* MCP server, not the MCP Server Trigger node).
  Needs a Claude Code restart before its tools are usable.

## Measured facts (do not re-derive)

| Fact | Value | Source |
|---|---|---|
| Issues in n8n-io/n8n | 10,241 (381 open) | `search/issues`, 2026-09-06 |
| PRs | 27,382 (20,966 merged) | same |
| Total records | ~37,600 | |
| New issues+PRs / month | ~2,000 | trailing 30d |
| REST payload per record | ~7.1 KB | measured |
| GraphQL payload per record (minimal fields) | ~243 B | measured — 29x smaller |
| Full dataset via GraphQL | ~9.1 MB | |
| Backfill cost | 377 GraphQL calls, ~2,300 of 5,000 hourly points | |
| Labels in repo | 120 | |
| Issues with a `team:*` label | 1,763 / 10,241 (17%) | |
| Issues with no label at all | 1,296 | |
| Sample of 500 newest issues: component label | 41.6% | |
| Sample of 500 newest issues: linked closing PR | 23.0% | |
| Sample: covered by either | 46.6% | |
| Issue body text | mean 2,850 chars, p50 2,003, p90 5,380 | |

## Findings that shaped the design

- **No severity label exists** anywhere in the 120. Severity must be derived.
- **Component does exist** as `team:*` (15 labels) + `node/*` + ad-hoc
  (`core`, `ui`, `dx`, `deployment`, `performance`, `security`).
  `component:*` is a red herring — only 2 niche labels use it.
- **n8n monorepo packages are a better component taxonomy**: `packages/{cli,
  core,frontend,nodes-base,workflow,modules,extensions,testing,node-dev}` plus
  ~40 `@n8n/*`. A fix PR's changed paths are ground truth for component.
- **`Issue.closedByPullRequestsReferences` is GA** and returns the closing PR
  with `mergedAt`, nestable in the bulk issues query at no extra request.
  This solves lead-time linking. Verified live on a real n8n issue.
- **Do NOT use the REST timeline API** for linking: 1 request per issue =
  37,623 requests = 7.5+ hours of rate limit.
- **Paginate ascending by `updated`.** `direction=desc` has a documented
  page-shifting race that silently skips or duplicates records.
- **n8n Source Control / Git is Business+Enterprise only.** Probably closed to us.
- **No official n8n Terraform provider.** Only `kodflow/n8n` (v1.6.0, maintained)
  is viable. `devops247-online/n8n` has a 404 source repo — do not use.
- **Public API works on all paid Cloud plans**: `https://skomp.app.n8n.cloud/api/v1`,
  header `X-N8N-API-KEY`.
- Workflow JSON carries instance-specific fields that must be stripped before
  commit: `id`, `versionId`, `webhookId`, `meta.instanceId`, `shared[]`, `staticData`.

## LLM classification cost (worst case: all 10,241 issues)

Batch API, 50% off, body capped at 2,000 chars (~620 in / 40 out tokens each):

| model | backfill | ongoing/month |
|---|---|---|
| Haiku 4.5 | $4.20 | $0.33 |
| Sonnet 5 | $8.40 | $0.66 |
| Opus 5 | $20.99 | $1.64 |

Cost is not a constraint. Reproducibility is: classify once, commit the verdict
to the store, never re-classify unless the issue body changes.

## Population measurements (triage scoping)

| Definition | Issues | Share |
|---|---|---|
| any `triage:*` | 1,309 | 13% |
| any `team:*` | 1,648 | 16% |
| `triage:*` or `team:*` | 2,757 | 27% |
| any `closed:*` | 2,956 | 29% |
| **`triage:*` or `team:*` or `closed:*`** | **5,464** | **53%** |

Triage lifecycle spread: pending 702, needs-info 608, complete 170, ping 30,
in-progress 18, needs-reproduction 11, stalled 7.

**Verified**: GraphQL `issues(labels: [...])` uses **OR** semantics
(702 + 170 = 872 exactly). REST uses AND and search syntax uses OR — do not
assume they match. Also avoid the GraphQL `search` connection: it hard-caps
at 1,000 results, which is below our population.

## Decisions taken

1. **Data scope**: full history, one-off backfill, then incremental sync on a
   watermark. Paginate ascending by `updated` — never descending.
2. **Population**: triaged issues only — `triage:*` OR `team:*` OR `closed:*`
   = **5,464 issues**. Fetched with a single label-filtered GraphQL connection.
3. **No LLM classifier.** Component comes from `team:*` / `node/*` labels and,
   where needed, the changed file paths of the closing PR mapped onto
   `packages/*`. Deterministic and reproducible.
4. **Severity is replaced by ground truth**: the `triage:*` lifecycle and the
   `closed:*` outcome. Nothing in the output is inferred.
5. **PR scope**: only PRs that close a triaged issue, obtained free via
   `closedByPullRequestsReferences` nested in the issue query. No second
   ingest path. Repo-wide PR metrics are explicitly out of scope.
6. **Transport**: GraphQL with minimal field selection (~243 B/record vs
   ~7.1 KB for REST).
7. **Storage**: NDJSON in `skomp/n8n-data`.
8. **Output**: dated markdown report committed to `skomp/n8n-reports`.

## Consequence: the memory problem is largely designed away

5,464 issues at ~243 B is roughly **1.3 MB** for the entire dataset — down from
~267 MB for a full REST ingest of all 37,600 records. The elaborate sharding and
incremental-rollup machinery considered earlier is no longer required to avoid
an OOM. Keep the ingest streaming and page-at-a-time on principle, but do not
build sharding for a dataset this size. (Revisit only if repo-wide PR ingest is
ever added back to scope.)

## Open questions

- [ ] Which n8n Cloud plan is `skomp` on? Decides whether n8n's native Git
      source control (Business/Enterprise only) is available as a deploy path.
- [ ] Deployment mechanism: `kodflow/n8n` Terraform provider vs the public API
      from CI vs the `n8n-cli` package format vs the instance MCP server.
- [ ] Report contents: which stats beyond component grouping, triage-flow
      breakdown and lead times.
