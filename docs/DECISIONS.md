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

## Decisions taken

1. **Data scope**: full history, one-off bounded backfill, then incremental
   sync on a watermark.
2. **Storage**: files in git (`skomp/n8n-data`), NDJSON/Parquet.
   **Sharded by month** (`data/issues/YYYY-MM.ndjson`) — a single large file
   would reintroduce the OOM, since the GitHub Contents API replaces whole
   files with the content base64-encoded in the request body.
3. **Aggregation**: incremental rollup files updated in place, not a full
   re-read of history. This is what permanently kills the OOM.
4. **Severity**: LLM-assigned (critical/high/medium/low) with a confidence
   score and one-line rationale, reported *alongside* the ground-truth
   `triage:*` and `closed:*` axes so inference is always distinguishable
   from GitHub's own data.

## Open questions

- [ ] Which n8n Cloud plan is `skomp` on? Decides gateway-credit allowance and
      whether Git source control is available.
- [ ] Gateway credit -> token conversion rate (`app.n8n.cloud/service-pricing`,
      login-gated). Decides whether the backfill fits a monthly allowance.
- [ ] Classifier model (Haiku 4.5 / Sonnet 5 / Opus 5 / escalate-on-low-confidence).
- [ ] Component strategy: labels + PR file paths + LLM fallback — needs confirming.
- [ ] Deployment mechanism: `kodflow/n8n` Terraform provider vs the public API
      from CI vs the new `n8n-cli` package format vs the instance MCP server.
- [ ] What the output actually is (dashboard? committed markdown report? Slack?).
