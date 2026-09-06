# n8n GitHub analytics — running decisions log

Started 2026-09-06. Brainstorm in progress; this file exists so the work survives
a lost session. Supersede it with the real spec when the design is agreed.

## Goal (one sentence)

Ingest all issues and PRs from `n8n-io/n8n`, classify them by component and
severity, compute lead times, and publish stats — built offline, deployed to
n8n Cloud as code, and memory-bounded so the aggregation cannot OOM again.

## Fixed context

- n8n Cloud instance: `skomp.app.n8n.cloud`. Not self-hosted.
- Project repo: `skomp/n8n-issue-stats` (public, empty).
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
   Extended 2026-09-06: the same run also publishes a styled, self-contained HTML
   twin at the dated path, and copies it to `index.html` for GitHub Pages.

## Consequence: the memory problem is largely designed away

5,464 issues at ~243 B is roughly **1.3 MB** for the entire dataset — down from
~267 MB for a full REST ingest of all 37,600 records. The elaborate sharding and
incremental-rollup machinery considered earlier is no longer required to avoid
an OOM. Keep the ingest streaming and page-at-a-time on principle, but do not
build sharding for a dataset this size. (Revisit only if repo-wide PR ingest is
ever added back to scope.)

## Superseded by the spec

The full design now lives in
`docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md`.
This file remains as the decision trail. The spec is authoritative.

## Late finding: the accepted/rejected seam

Measured after the full backfill (5,464 records):

| Segment | Issues | Share |
|---|---|---|
| Rejected at triage (`closed:*`) | 2,956 | 54% |
| Accepted | 2,508 | 46% |

Component coverage within accepted is 65%; only 40 rejected issues carry a
`team:*` label, and every unclassified issue is closed. Component is a property
of accepted work, so component grouping applies to the accepted segment only.

## Open questions

None. Both earlier questions were resolved:

- **n8n Cloud plan**: free trial. This closed the public REST API (API-key creation
  is gated), which is why deployment goes through the instance MCP server instead —
  that authorises over OAuth and is not tier-gated.
- **Report cadence**: weekly, confirmed by the owner.

Everything still outstanding is tracked as a GitHub issue in `skomp/n8n-issue-stats`.

## Later decisions

**Ingest fans out into two branches (2026-09-06).** The GraphQL fetch and the
2.86 MB store download share no data — the query needs only the watermark from
`state.json` — so they are separate branches joined by a Merge node in
`chooseBranch` / `waitForAll` mode with `output: "empty"`.

> **Correction.** This decision was originally recorded as "runs two branches
> concurrently", with wall-clock overlap as the rationale. That is **not
> established**: n8n executes nodes sequentially within one execution, and the
> two runs available compared different data volumes (2 issues vs 439), so
> neither can serve as evidence. The Merge barrier is still *required* for
> correctness given the fan-out, and nothing is harmed — but the concurrency
> claim is unmeasured and is tracked as
> [#7](https://github.com/skomp/n8n-issue-stats/issues/7).

The Merge is a **barrier, not a join**. `Fetch issues` emits one item per
GraphQL page while the store branch emits one, so `combineAll` would produce an
N x 1 cartesian output and `combineByPosition` would drop every page after the
first. `output: "empty"` emits a single empty item — verified in n8n's own
source, `nodes/Merge/v3/actions/mode/chooseBranch.ts`, which pushes one object
rather than returning an empty array, so the downstream node still runs. It also
keeps the 2.9 MB store out of a second node's saved output. `Upsert store`
therefore reads all four of its inputs by node name.

`useDataOfInput` is **1-based** (n8n resolves it as `inputsData[n - 1]`) while a
connection's `index` is **0-based**. `output: "empty"` uses neither, which is
one fewer off-by-one to get wrong.

**All three report writes are idempotent upserts (2026-09-06, revised).** Each
of the three files is preceded by its own `Read ... sha` node running with
`neverError` and `fullResponse`, and `planWrite()` sends the sha only when that
read returned one. Any status other than 2xx or 404 throws rather than guessing:
a PUT with no sha over an existing file fails with an opaque 422, which is a
much worse place to discover a transient 500.

**Correction.** This entry previously read "`index.html` is the only write that
needs a blob sha", on the reasoning that the dated paths are unique per run.
They are not — they are unique per **day**. A same-day re-run therefore 422'd on
both dated files while `index.html`, which did supply a sha, succeeded, and the
published page disagreed with the archived report for that date. Reported as
skomp/n8n-issue-stats#2 and hit during deployment on 2026-09-06, when the controller
had to delete `reports/2026-09-06-triage.md` by hand before re-running.

**Overwrite with a conditional sha, not delete-then-create (2026-09-06).** The
issue described the fix as "delete before recreate". A conditional-sha PUT
reaches the same end state in **one** request per file, with no window in which
the report is absent from the archive, and no half-applied state if a second
call fails. An explicit DELETE followed by a PUT doubles the request count and
adds both of those failure modes for no gain.

The writes stay ordered dated-first, `index.html` **last**: it is the pointer at
the archive and must not be advanced to a report the archive does not have.

**A third workflow runs the other two in sequence (2026-09-06).**
`Triage analytics — sync and report` (slug `n8n-triage-orchestrator`,
`workflows/orchestrator.json`) holds a weekly Schedule Trigger and two Execute
Workflow nodes, typeVersion 1.3: `Run ingest`, then `Run report`. It carries no
logic of its own.

To be callable at all, a workflow needs an **Execute Workflow Trigger**. Both
sub-workflows now carry one (typeVersion 1.2, `inputSource: "passthrough"`)
beside the Schedule Trigger they already had. n8n supports several triggers on
one workflow and fires each as its own isolated execution, so the daily and
weekly cadences are unchanged. The ingest's Execute Workflow Trigger fans out to
**both** branch heads, exactly as `Daily` does — wired to one, an orchestrated
run would fetch without downloading the store and still report success.

`waitForSubWorkflow` is set **explicitly to true** on both Execute Workflow
nodes although true is the current n8n default. Sequential execution is the only
reason this workflow exists: without the wait, `Run report` renders from the
store as it was **before** this week's sync, and the run is green. That is a
correctness property, not a default to inherit.

`workflowInputs` is deliberately **absent**. Both triggers are `passthrough`, so
there is no input schema, and the editor's
`{ mappingMode: "defineBelow", value: null }` is a UI initialisation state, not
a configuration.

The sub-workflows are addressed by **id** in a resource locator
(`{ __rl: true, mode: "id", value, cachedResultName }`), so a wrong id points at
a different workflow and the run still succeeds. The ids live once, in
`SUB_WORKFLOWS` in `build/build-workflows.js`, and each workflow's own name is
read back from there as the `cachedResultName`.

**Consequence: the schedules now overlap.** All three workflows carry a
`scheduleTrigger`, and the orchestrator uses the report's slot (Monday 08:00).
Publish the orchestrator, **or** the ingest and the report — never both, or the
report runs twice a week. Nothing is published today, so nothing is broken.

**HTML report and GitHub Pages (2026-09-06).** The report publishes three files
per run instead of one: `reports/YYYY-MM-DD-triage.md`, the same content as a
self-contained styled HTML page, and `index.html` as a copy of the latest.
Pages serves the root from `main`, so https://skomp.github.io/n8n-reports/
always shows the newest report. All three writes are idempotent upserts — each
reads its blob sha first and omits it when the read 404s — so a same-day re-run
leaves the published page and the archive in agreement
([#2](https://github.com/skomp/n8n-issue-stats/issues/2)).

The footer links to the archive at
`https://github.com/skomp/n8n-reports/tree/main/reports`, **not** at a Pages
path. GitHub Pages does not generate directory indexes, so
`https://skomp.github.io/n8n-reports/reports/` returns 404 — publishing a real
archive page is tracked as [#3](https://github.com/skomp/n8n-issue-stats/issues/3).

**Orchestrator (2026-09-06).** A third workflow runs ingest then report through
`executeWorkflow` nodes with `waitForSubWorkflow: true`, so the report always
renders from a store synced in the same run. Both sub-workflows carry a second
trigger (`executeWorkflowTrigger`) so they can be called this way while keeping
their own schedules.

Merging the two into one workflow was considered and rejected. n8n runs a
sub-workflow in its own execution context; a single merged workflow would hold
the fetched pages, the 2.86 MB store and the rendered report in one execution's
memory — recreating the pressure this project exists to avoid.

**Sticky-note documentation (2026-09-06).** Ten sticky notes across the three
canvases, grouped by phase rather than per node. Each carries the *reason* a
step is shaped as it is — why `Accept: application/vnd.github.raw` is
mandatory, why the Merge passes no data, why pagination is ascending, why a 404
on a sha read is not an error. Those facts cost real work to discover and are
invisible from the node graph; someone who "simplifies" them breaks the
pipeline in ways that stay green.

**`scripts/deploy.sh` (2026-09-06).** Two schema defects fixed: it sent
`active`, which n8n's OpenAPI spec marks `readOnly` under
`additionalProperties: false` (so it would have 400'd on its first call), and
it matched workflows by name, which would have allocated new ids on a fresh
instance while the orchestrator held the old ones as literals. Payload shaping
and id substitution moved into `scripts/deploy-payload.js` so the tested code
is the deployed code.

**The script has still never run** — creating an API key is gated on the free
trial. It conforms to the published schema and its logic is unit tested; that
is a different claim from "known to work", and
[#8](https://github.com/skomp/n8n-issue-stats/issues/8) stays open until it runs
against a paid-plan instance.
