# n8n GitHub Triage Analytics — Design

Date: 2026-09-06
Status: approved in brainstorm, ready for implementation planning

## 1. Goal

Ingest the triaged issues of `n8n-io/n8n`, group them by component and by triage
outcome, calculate lead times, and publish a dated markdown report. Author the
workflows offline in git and deploy them to n8n Cloud with a script.

**Amended 2026-09-06.** Each run publishes the report as markdown **and** as a
styled HTML page, served from GitHub Pages. See section 5, "Published output".
Deployment used the instance MCP server rather than the script, because the
public API is gated on the free trial; see section 9.

The pipeline must stay memory-bounded. An earlier attempt by the owner failed
with an out-of-memory error in the aggregation step.

## 2. Measured facts — do not re-derive

Every number below was measured against the live API on 2026-09-06. An
implementer must not spend budget re-establishing them.

### Repository scale

| Fact | Value |
|---|---|
| Issues in `n8n-io/n8n` | 10,241 (381 open) |
| Pull requests | 27,382 (20,966 merged) |
| New issues + PRs per month | ~2,000 |
| Distinct labels | 120 |

### Transport

| Fact | Value |
|---|---|
| REST payload per record | ~7,100 bytes |
| GraphQL payload per record, minimal fields | ~243 bytes |
| GraphQL payload per record, with PR file paths | ~498 bytes |
| REST rate limit | 5,000 requests/hour |
| GraphQL rate limit | 5,000 points/hour |

### The backfill, measured end to end

A complete backfill ran successfully during design:

| Fact | Value |
|---|---|
| Pages fetched | 55 |
| Rate-limit points consumed | **385 of 5,000** |
| Records retrieved | **5,464** |
| Wall time | ~3.5 minutes |
| Store size on disk | 2.7 MB |

The record count matches the GitHub search API count for the same label set
exactly, which validates both the label filter and the pagination.

### Query cost, measured not computed

| Query | Measured cost |
|---|---|
| 100 issues + 5 closing PRs | 2 points |
| 100 issues + 5 closing PRs + 100 file paths each | 6 points |
| 100 PRs + 100 file paths each | 1 point |

A calculation from GitHub's documented point formula predicted 506 points for
the second query. The measured cost is 6. **Do not compute GraphQL point costs
from the formula — measure them.** This finding removed a two-phase fetch from
the design.

### API semantics verified by experiment

| Behaviour | Result |
|---|---|
| GraphQL `issues(labels: [a, b])` | **OR** — 702 + 170 returned 872 |
| REST `labels=a,b` | AND (per GitHub docs) |
| Search syntax `label:a,b` | OR |
| GraphQL `filterBy: {since:}` | Works, composes with `orderBy: UPDATED_AT ASC` |
| `Issue.closedByPullRequestsReferences` | GA, returns the closing PR with `mergedAt` |
| GraphQL `search` connection | Hard-capped at 1,000 results — unusable here |

## 3. The population

"Triaged" means the issue carries at least one of 33 labels, in three families:

- `triage:*` — 9 labels (pending, in-progress, needs-info, needs-reproduction,
  ready-for-review, complete, stalled, ping, tests-needed)
- `team:*` — 15 labels (nodes, ai, api, iam, chat, design, qa-dx, lifecycle,
  relay, identity, cats, payday, adore, ins, instance-ai)
- `closed:*` — 9 labels (duplicate, cant-reproduce, working-as-expected,
  support-issue, incomplete-template, enhancement/feature, info, non-english,
  requested)

This yields **5,464 issues, 53% of all issues** in the repository.

### Why not all 10,241 issues

n8n does not label most community-filed issues. Only 17% carry a `team:*`
label. There is **no severity label anywhere in the 120** — no `severity:*`,
no `priority:*`, no P0/P1/P2. Grouping unlabelled issues would require an
LLM classifier, which the owner rejected. Restricting to the labelled
population makes every figure ground truth.

## 4. Key structural finding: the accepted/rejected seam

The population splits cleanly, and this shapes the entire report:

| Segment | Issues | Share |
|---|---|---|
| **Rejected at triage** (has a `closed:*` reason) | 2,956 | 54% |
| **Accepted** (no rejection reason) | 2,508 | 46% |

Within the accepted segment:

| | Issues | Share of accepted |
|---|---|---|
| Carries a `team:*` label | 1,608 | 64% |
| Tracked in Linear (`status:in-linear` / `in linear`) | 2,469 | 98% |
| Component derived from closing-PR file paths | +93 | 4% |
| Unclassified | 807 | 32% |
| **Component coverage** | | **65%** |

Only **40** rejected issues carry a `team:*` label, and **every** unclassified
issue is CLOSED — not one is open.

> **Correction, 2026-09-06.** An earlier revision of this spec stated component
> coverage as **68%**. That figure was wrong. It was measured with an ad-hoc query that
> counted every linked pull request as component evidence, including the 55% that were
> closed without merging — which contradicts this spec's own rule in section 7 that only
> merged PRs may contribute. Recomputed correctly against the full 5,464-record store,
> the figure is **65%**. The implementation was right and the original measurement was
> wrong; no code changed as a result of this correction.

**Interpretation.** Component is a property of accepted work, not of every
issue. An issue closed as `incomplete-template` or `support-issue` has no
component because it never became work. The 32% unclassified figure is
therefore not a data-quality problem to be fixed; it is a real property of
the triage process.

**Consequence for the report.** Component grouping applies to the accepted
segment only. The rejected segment is analysed by rejection reason instead.
The headline metric is the ratio itself: more than half of triaged issues
never become work.

Note also that n8n moves accepted issues into Linear. GitHub stops being the
system of record at that point, so this pipeline measures **intake and
triage**, not delivery. Do not present it as a measure of engineering output.

## 5. Architecture

### Repositories

| Repo | Contents |
|---|---|
| `skomp/n8n-issue-stats` | Workflow JSON, deploy script, this spec |
| `skomp/n8n-data` | `issues.ndjson`, `state.json` (watermark) |
| `skomp/n8n-reports` | `reports/YYYY-MM-DD-triage.md`, `reports/YYYY-MM-DD-triage.html`, `index.html` |

All three exist and are public.

#### Published output — amended 2026-09-06

The original table listed markdown only. What shipped writes **three files per
run**:

| Path | Content |
|---|---|
| `reports/YYYY-MM-DD-triage.md` | the markdown report |
| `reports/YYYY-MM-DD-triage.html` | the same numbers as a styled, self-contained page — one inline `<style>` block, no external stylesheet, script or web font, so identical bytes render from GitHub Pages, from `file://` and from a mail client |
| `index.html` | a byte-for-byte copy of the latest HTML report |

`skomp/n8n-reports` serves **GitHub Pages** from the repository root, so the
latest report is published at <https://skomp.github.io/n8n-reports/>. Pages
generates no directory index, so the archive link in each page's footer points
at the GitHub tree <https://github.com/skomp/n8n-reports/tree/main/reports>
rather than at a Pages directory URL.

All three writes are **idempotent upserts**: each read its existing sha before
writing, so a same-day re-run replaces the file instead of failing. See
`skomp/n8n-issue-stats#2`.

### Moving parts

1. **Backfill script** — runs locally, once. Fetches all 5,464 records and
   writes the initial `issues.ndjson` to `n8n-data`. Proven: 55 pages,
   385 points, 3.5 minutes.
2. **Ingest workflow** — n8n Cloud, scheduled daily. Reads the watermark,
   fetches only issues updated since, upserts by issue number, writes the
   watermark back.
3. **Report workflow** — n8n Cloud, scheduled weekly (confirmed). Reads the store,
   computes rollups, renders markdown **and HTML** (amended 2026-09-06), commits
   all three files to `n8n-reports`.
4. **Deploy script** — runs locally. Pushes workflow JSON from `n8n-issue-stats`
   to n8n Cloud through the public API.

#### Three workflows, not two — amended 2026-09-06

A third workflow shipped: an **orchestrator** (`n3cSgsUgaLDg23Wg`, *Triage
analytics — sync and report*). It runs the ingest and then the report,
sequentially, through two Execute Workflow nodes that both set
`options.waitForSubWorkflow: true`, so the report never reads a store the ingest
has not finished writing.

To make that possible, the ingest (`AE9bsoYqgcFuz1T3`) and the report
(`yuzPI1WHGOcpzljg`) each carry a **second entry point**: an
`executeWorkflowTrigger` node beside their own schedule trigger. Each trigger
starts the same first working node, so an orchestrated run and a scheduled run
execute an identical graph. n8n fires each trigger as its own isolated
execution, so adding the second entry point left the schedules untouched.

### How the out-of-memory failure is prevented

Three independent measures. The first is the one that matters:

1. **The backfill never runs in n8n.** It runs locally, once. n8n only ever
   handles the daily delta — on the order of 20 records.
2. **The report workflow never converts the store into n8n items.** It fetches
   `issues.ndjson` as a *single* text item, parses and folds it inside one
   Code node, and emits only the rollup object. One item in, one item out.
   n8n holds every node's output array in memory for the whole execution, so
   5,464 items would reintroduce the original failure.
3. **Transport is GraphQL with explicit field selection.** 498 bytes per
   record against ~7,100 for REST — a 14x reduction on the fields we need,
   and the whole store is 2.7 MB.

**Deliberately not built:** monthly shard files and incremental rollup files.
Both were designed and then dropped once the dataset was measured at 2.7 MB.
Reintroduce them only if repo-wide PR ingest is ever added to scope.

## 6. Ingest contract

### Query

This exact query ran 55 times during design with no errors. Page size 100,
ordered ascending.

```graphql
query($cursor: String, $labels: [String!]!, $since: DateTime) {
  rateLimit { cost remaining }
  repository(owner: "n8n-io", name: "n8n") {
    issues(first: 100, after: $cursor, labels: $labels,
           filterBy: {since: $since},
           orderBy: {field: UPDATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state createdAt updatedAt closedAt
        author { login }
        labels(first: 30) { nodes { name } }
        reactions { totalCount }
        comments { totalCount }
        closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
          nodes { number createdAt mergedAt
                  files(first: 100) { nodes { path } } }
        }
      }
    }
  }
}
```

Omit `filterBy` for the backfill; supply it for incremental runs.

### Ordering is a correctness requirement, not a preference

Pagination MUST be ascending by `updatedAt`. GitHub's `direction: DESC` on
`updated` has a documented race: records that change mid-crawl shift between
pages, so items are silently skipped or duplicated. Ascending order means
newly-updated records append behind the cursor instead of displacing pages
already read.

### Watermark

`state.json` in `n8n-data` holds the highest `updatedAt` observed. Each run
queries `since = watermark - 5 minutes` to absorb clock skew, and de-duplicates
on upsert by issue `number`. The overlap is deliberate: duplicates are cheap,
gaps are silent and permanent.

### Upsert

`issues.ndjson` is keyed by issue `number`. A record with an existing number
replaces it; a new number appends. Ordering within the file is not significant.

## 7. Component derivation

Deterministic, no inference. First match wins:

1. `team:*` label present -> that team name
2. `node/*` label present -> `nodes`
3. Ad-hoc label present (`core`, `ui`, `dx`, `deployment`, `performance`,
   `security`) -> that name
4. Closing PR's changed paths -> the `packages/<name>` prefix holding the most
   changed files
5. Otherwise -> `unclassified`

Applied to the accepted segment only. Measured coverage: **65%**.

**Note on steps 2 and 3:** both matched zero issues in the measured population,
because `node/*` and the ad-hoc labels never co-occur with the 33 filter
labels. They are retained because they cost nothing and n8n's labelling may
change. An implementer should not be alarmed by them matching nothing, and
should not delete them on the assumption they are broken.

The n8n monorepo's real package list — the target vocabulary for step 4 — is
`packages/{cli, core, extensions, frontend, modules, node-dev, nodes-base,
testing, workflow}` plus ~40 scoped packages under `packages/@n8n/`.

## 8. Report contents

Written to `skomp/n8n-reports/reports/YYYY-MM-DD-triage.md`.

**Amended 2026-09-06.** Every run also writes
`reports/YYYY-MM-DD-triage.html` and a root `index.html` copy of the latest
report, published through GitHub Pages at
<https://skomp.github.io/n8n-reports/>. The two renderings carry the same
numbers, the same denominators and the same caveats: both iterate one shared
caveat list, and the tests assert the two renderings stay the same length. See
"Published output — amended 2026-09-06" in section 5.

### Headline

The accepted/rejected ratio, and the count of issues rejected for reasons that
suggest the issue should never have been filed as a bug
(`incomplete-template`, `support-issue`, `non-english`). Measured today:
**2,336 issues, 43% of the triaged population.**

### Sections

1. **Intake and outcome** — accepted vs rejected, with the trend by month.
2. **Rejection reasons** — breakdown of the 2,956 rejected issues by
   `closed:*` reason. Measured distribution across the 5,464-issue population:

   | Reason | Issues |
   |---|---|
   | `closed:incomplete-template` | 1,150 |
   | `closed:support-issue` | 955 |
   | `closed:enhancement/feature` | 239 |
   | `closed:non-english` | 234 |
   | `closed:working-as-expected` | 129 |
   | `closed:duplicate` | 115 |
   | `closed:cant-reproduce` | 79 |
   | `closed:requested` | 68 |
   | `closed:info` | 19 |

   These sum to more than 2,956 because an issue may carry several reasons.
3. **Component** — accepted issues by component, with the coverage figure
   stated on the table.
4. **Triage funnel** — counts by `triage:*` state.
5. **Lead times** — three distinct measures:
   - issue `createdAt` -> `closedAt`
   - issue `createdAt` -> closing PR `mergedAt` (fix lead time)
   - closing PR `createdAt` -> `mergedAt`
6. **Coverage and caveats** — population size, what fraction is unclassified,
   and an explicit statement that Linear-tracked work is invisible here.

### Report window — added 2026-09-06

The store keeps **full history**. The report **windows its intake sections to the
last 6 months** (`createdAt >= now - 180d`) and computes **lead times over all
history**. This split is deliberate and load-bearing.

**Why lead times must not be windowed.** Measured on the real store:

| Fix lead time | n | median |
|---|---|---|
| All history | 543 | **25.3 days** |
| Created in last 6 months only | 247 | **12.7 days** |

A 6-month window understates the median by roughly 2x. The mechanism is truncation
bias: an issue created 8 months ago and fixed 2 months ago falls outside a
created-date window, and slow-to-fix issues are exactly the ones that spill out of a
short window. Dropping them removes the tail, and the tail is the lead-time story.
This is the same failure the median-over-mean rule exists to prevent, reintroduced at
the data-selection layer where no statistic can correct for it.

**Windowed sections:** intake and outcome, rejection reasons, component, triage
funnel, monthly intake, and the headline.
**Unwindowed sections:** all three lead-time measures.

**Do not window `filterBy: {since:}` at the API to achieve this.** That parameter
filters on `updatedAt`, not `createdAt` — it returns 2,286 issues where a created-date
window returns 1,736, because 550 issues created before the window were touched inside
it. The window is a report-side filter on `createdAt`, applied after ingest.

**Measured window figures** (window opening 2026-03-06, against 5,464 all-time):

| Figure | Windowed | All-time |
|---|---|---|
| Population | 1,736 | 5,464 |
| Accepted | 843 | 2,508 |
| Rejected | 893 | 2,956 |
| Should-not-have-been-filed | 722 (**42%**) | 2,336 (**43%**) |

The headline section states both, because the near-identical rate is itself the
finding: the intake-quality problem is stable over time, not improving.

### Statistical rules

- **Report median and p90, never mean.** Lead-time distributions on a public
  repository have a long tail; a handful of multi-year-old issues drag any
  average into meaninglessness.
- **State the window on every windowed table.** A reader must never have to guess
  whether a number covers 6 months or 6 years.
- **Always print the denominator.** Every grouping states what share of the
  population it covers. `unclassified` is a visible row, never dropped.

## 9. Deployment

### RESOLVED — amended 2026-09-06

**This section is superseded. Deployment is not blocked.** The instance-level
MCP server at `/mcp-server/http` was tested on the free trial and it **works**.
All three workflows were created, updated and executed through it. The
"Untested — test this first" row and the "BLOCKED ON THE CURRENT PLAN" warning
below describe the state at design time and are kept for the record only.

What was actually deployed, all through the MCP server:

| Workflow | id |
|---|---|
| Ingest | `AE9bsoYqgcFuz1T3` |
| Report | `yuzPI1WHGOcpzljg` |
| Orchestrator | `n3cSgsUgaLDg23Wg` |

The finding the original row predicted holds: the MCP server does not depend on
the gated API-key surface, so it is available on the trial while
`https://skomp.app.n8n.cloud/api/v1/workflows` is not. The public API and the
deploy script remain the target once the account is on a paid plan.

---

**BLOCKED ON THE CURRENT PLAN. Read this before implementing.**

`skomp` is on the n8n Cloud **free trial**. n8n's documentation states
plainly: *"The n8n API isn't available during the free trial. Please upgrade
to access this feature."* API keys are created at Settings > n8n API, and that
surface is gated.

The intended mechanism — a local script pushing workflow JSON to
`https://skomp.app.n8n.cloud/api/v1/workflows` with the `X-N8N-API-KEY`
header — therefore **cannot run today**. It remains the target design once the
account is on a paid plan.

**This blocks only deployment, not the pipeline.** The ingest and report
workflows execute inside n8n and call the GitHub API; they never call n8n's own
API. Everything in sections 4 through 8 is unaffected.

### Options while on the trial

| Option | Status |
|---|---|
| Instance-level MCP server at `/mcp-server/http` | **Tested 2026-09-06 — it works on the free trial.** Amended: this row previously read "Untested — test this first". It exposes workflow create/edit tools, n8n's docs specify no plan tier for it (unlike Source Control, which explicitly names Business/Enterprise), and it authenticates by OAuth as well as API key, so it does not depend on the gated API-key surface. All three workflows were deployed and executed through it. |
| Upgrade to Starter | Unblocks the public API and the deploy script exactly as specified. |
| Manual import through the UI | Always available. Author in the UI, export JSON into git for versioning, deploy by hand until the plan changes. |

Testing the MCP option requires restarting Claude Code so the registered
server's tools load, then attempting to list workflows on the instance.

### Why not the alternatives

| Option | Rejected because |
|---|---|
| Terraform `kodflow/n8n` | Single-maintainer community provider (19 stars). Viable, but a third-party dependency on the deploy path for three workflows. |
| Terraform `devops247-online/n8n` | **Source repository returns 404.** The binary is downloadable but unauditable. Do not use. |
| Official `n8n-cli` / `.n8np` packages | Explicitly Preview — "the package format and API may change". |
| n8n native Git source control | Business/Enterprise plans only. `skomp` is on the free trial, so this was never available. |
| GitHub Actions | The owner chose local execution. Note for the record that Actions is free with unlimited minutes on public repositories, so this constraint is optional. |

### Fields to strip before committing workflow JSON

These are instance-specific and cause collisions on import:
`id`, `versionId`, `versionCounter`, `activeVersionId`, `sourceWorkflowId`,
`node.id`, `node.webhookId`, `meta.instanceId`, `shared[]`, `staticData`,
`tags[].id`, and all `createdAt`/`updatedAt` timestamps.

Credential references travel as id + name + type only. Secrets never appear in
exported workflow JSON, by design. On import n8n matches an existing credential
of the same type or creates an empty placeholder.

## 10. Secrets

| Secret | Held by | Purpose |
|---|---|---|
| GitHub fine-grained PAT | n8n credential | Read issues/PRs on a public repo; write contents on `n8n-data` and `n8n-reports` |
| n8n API key | Local environment only | Deploy workflows |

The GitHub token needs `Issues: read`, `Pull requests: read`, `Metadata: read`
on `n8n-io/n8n`, and `Contents: write` on the two owned repos. No write access
to `n8n-io/n8n` is required or should be granted.

## 11. Verification

Checks that assert values, not shapes:

- Backfill returns exactly 5,464 records for the 33-label filter, matching the
  search API count.
- Accepted + rejected sums to the total; the rejected count equals the count of
  issues carrying any `closed:*` label.
- A known issue with a known closing PR yields the correct `mergedAt` and a
  correctly signed, non-zero lead time.
- Running the incremental sync twice in a row produces no duplicate issue
  numbers in the store.
- A component derived from PR paths is asserted on its **decoded value** (which
  package), not merely on the fact that a rule fired.
- The report workflow's peak memory does not scale with store size: verify the
  Code node receives one item, not thousands.

## 12. Out of scope

- Repo-wide PR metrics across all 27,382 PRs. Only PRs closing a triaged issue
  are ingested, and they arrive free inside the issue query.
- LLM classification of unlabelled issues. Rejected by the owner. Cost was
  measured at $4.20 for a full backfill on Haiku 4.5 via the Batch API, so the
  constraint was reproducibility and complexity, not money.
- Severity scoring. No severity label exists; triage state and closure reason
  are used instead.
- Anything about work after it enters Linear.

## 13. Open questions

No open question blocks deployment.

Resolved after design — amended 2026-09-06:

- **Does the instance MCP server work on the free trial?** **Yes.** This was
  recorded here as "the only question that blocks deployment". It was tested and
  it works: all three workflows were created, updated and executed through it.
  It is the deploy path for the trial period. See section 9.

Resolved during design:

- n8n Cloud plan: **free trial**. Native Git source control was never an
  option (Business/Enterprise only), and the public API is unavailable.
- Report cadence: **weekly**, confirmed by the owner.
