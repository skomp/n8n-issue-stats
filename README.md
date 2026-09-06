# n8n triage analytics

Measures how `n8n-io/n8n` handles incoming issues: how many are accepted as real
work, how many are bounced at triage and why, which components carry the load,
and how long fixes actually take. Publishes a dated markdown report on a weekly
schedule from n8n Cloud.

**The headline it produces:** of 5,464 triaged issues, **54% are rejected at
triage** — and 2,336 of them (43% of the whole population) were closed as
`incomplete-template`, `support-issue` or `non-english`, meaning they arguably
should never have entered the bug tracker.

---

## Quick start

```bash
npm test                                        # 101 tests, zero dependencies
GITHUB_TOKEN=$(gh auth token) npm run backfill  # one-off, ~3.5 min, writes data/issues.ndjson
```

There is nothing to install. Node 24, no `npm install`, no lockfile, no
`node_modules` — the project uses only `node --test`, native `fetch`, and the
standard library. That is a deliberate constraint, not an accident: this code
gets inlined into n8n Code nodes, which cannot import anything.

## Why this exists

An earlier attempt at the same analysis **ran out of memory during
aggregation**. That failure drove every significant decision here, so it is
worth being precise about the cause.

n8n holds every node's output array in memory for the entire execution. Fetch
40,000 issues and fold them in a Code node, and you are holding 40,000 items at
once. The fix is not a bigger heap — n8n Cloud does not let you set one — it is
never letting the item count grow:

- **The historical backfill does not run in n8n.** It is a local CLI, run once.
  n8n only ever handles the daily delta, roughly 20 records.
- **Every Code node takes one item and returns one item**, holding the store as
  a text string. Never one item per issue. This is the single most important
  invariant in the project and the generated code says so in a comment.
- **Transport is GraphQL with explicit field selection.** Measured against the
  live API: REST returns ~7,100 bytes per issue, a minimal GraphQL selection
  returns ~498. The whole store is 2.9 MB rather than ~40 MB.

Item *count* is what kills an n8n execution, not bytes. A 2.9 MB string in one
item is fine; 5,464 items are not.

## How it works

| Repo | Holds |
|---|---|
| `skomp/n8n-test` (this) | Library, CLIs, workflow generator, deploy script |
| `skomp/n8n-data` | `issues.ndjson` (5,464 records, 2.9 MB) and `state.json` (sync watermark) |
| `skomp/n8n-reports` | `reports/YYYY-MM-DD-triage.md` |

```
                    ┌─ local, once ────────────────────────────┐
GitHub GraphQL ────►│ src/backfill.js → data/issues.ndjson     │──► skomp/n8n-data
                    └──────────────────────────────────────────┘
                    ┌─ n8n Cloud, daily ───────────────────────┐
GitHub GraphQL ────►│ HTTP Request (paginated) → Code (upsert) │──► skomp/n8n-data
                    └──────────────────────────────────────────┘
                    ┌─ n8n Cloud, weekly ──────────────────────┐
skomp/n8n-data ────►│ HTTP Request → Code (rollup + render)    │──► skomp/n8n-reports
                    └──────────────────────────────────────────┘
```

`build/build-workflows.js` generates the two workflows by inlining `src/lib/*`
source into their Code nodes, so **the deployed logic cannot drift from the
tested logic**. There is one implementation, not two.

### Layout

```
src/lib/labels.js     The 33-label triage taxonomy
src/lib/github.js     GraphQL client, cursor pagination
src/lib/classify.js   segmentOf() and componentOf()
src/lib/metrics.js    Lead times, median, p90
src/lib/store.js      NDJSON parse/serialise/upsert
src/lib/rollup.js     Aggregation
src/lib/report.js     Markdown rendering
src/backfill.js       One-off historical load (local)
src/sync.js           Incremental sync with watermark
build/                Workflow generator
workflows/            Generated n8n workflow JSON
scripts/deploy.sh     REST deploy (needs a paid n8n plan — see below)
```

## Design decisions a reviewer should push on

**Only triaged issues are in scope.** 5,464 of 10,241, those carrying at least
one `triage:*`, `team:*` or `closed:*` label. n8n does not label most
community-filed issues, and there is **no severity label anywhere in the repo's
120** — so grouping the rest would require inference. Restricting to the
labelled population makes every published figure ground truth.

**No LLM classifier.** One was costed at $4.20 for the full backfill on Haiku
4.5 via the Batch API — cheap. It was rejected anyway, because a classifier
gives different answers on different runs, so historical figures would shift
underneath you. Inference presented as measurement is worse than a visible gap.

**Component is only computed for accepted issues.** A bounced issue never gets
a team label because it never becomes work; only 40 of 2,956 rejected issues
have one. Coverage is **65% across all history but 95.3% over the last 180
days** — n8n's labelling discipline has improved sharply, so the windowed
report is far more complete than the lifetime figure suggests. Whatever the
window, the gap is published as `unclassified` rather than hidden.

**Intake windows to six months; lead times never do.** Windowing a lead time by
creation date understates the median by 2× — 25.3 days becomes 12.7 — because
slow issues fall outside a short window and the tail is the whole distribution.
`rollup()` returns `total` (full population) and `window: {since, days,
population}` so every table can print the denominator it actually used.

**Medians and p90, never means.** Fix lead time is 25.3 days at the median and
155.9 at p90. An average would be meaningless.

## What the tests are for

101 tests, and the number is not the point. Partway through, a mutation review
seeded 17 deliberate bugs into a suite of 42 passing tests. **14 of them
survived with the suite fully green** — including deleting the `mergedAt`
filter, the single most load-bearing rule in the codebase.

The tests were written to pass, not to fail. They have since been rebuilt so
that every rule has a test that has been *watched failing* against a broken
implementation, and the suite now catches all of them. If you change something
here, hold that standard: **a test you have only ever seen pass has proven
nothing.**

Fixtures are 10 real records pulled from the live API plus 3 synthetic ones
(numbers `9000xx`) covering branches real data does not exercise. Assertions are
on decoded values — which component, how many days — never on shape.

## Four bugs that only fail in production

None of these is a coding error. Each is an assumption that holds in testing and
breaks in production, and each was caught by checking against something real.
They are documented because the class matters more than the instances.

| What | How it would have failed |
|---|---|
| **GitHub's Contents API silently truncates >1 MB.** Returns HTTP 200, `encoding: "none"`, empty `content`. | Read store → empty → upsert 20 → write back. **Store drops 5,464 → 20 records and the run reports success.** Requires `Accept: application/vnd.github.raw` plus a non-empty guard before any write. |
| **n8n's Code node has no network access.** `fetch`, `axios` and http modules fail at runtime. | The ingest workflow deploys clean, validates clean, dies at 3am on its first scheduled run. Fetching must happen in an HTTP Request node. |
| **`closedByPullRequestsReferences` returns unmerged PRs.** 666 of 1,218 (55%) were closed without merging. | Fix lead time computed against `null`, and component attributed to an abandoned PR. |
| **Scoped npm packages need three path segments.** | `packages/@n8n/db` truncated to `packages/@n8n` collapses ~40 packages into one fictitious bucket that would rank second-largest in the report. |

The through-line: a check cheap enough that it cannot fail proves nothing.
Reading a 136-byte `state.json` does not prove you can read a 2.9 MB
`issues.ndjson`.

## Deployment

n8n's **public REST API is unavailable on the free trial**. `scripts/deploy.sh`
targets it and is correct for a paid plan, but cannot run today.

The instance-level **MCP server works instead** — it authorises over OAuth and
is not tier-gated, unlike Git source control (Business/Enterprise only). So
workflows can be authored offline and deployed as code without a paid plan:

```bash
claude mcp add --transport http n8n https://<instance>.app.n8n.cloud/mcp-server/http
```

Node type versions are read from the live instance rather than assumed —
`scheduleTrigger` 1.4, `httpRequest` 4.5, `code` 2. All three initial guesses
were wrong, two of them silently.

## Limits worth stating plainly

- **This measures intake and triage, not delivery.** 98% of accepted issues
  move into Linear, at which point GitHub stops being the system of record.
  Do not read it as engineering throughput.
- **35% of accepted issues have no component** across all history, though only
  4.7% within the last 180 days. Reported as `unclassified` either way.
- **Fix lead time covers 543 issues**, not 5,464 — only those with a linked PR
  that actually merged.
- **The backfill sometimes trips GitHub's secondary rate limit** around page 20
  of 55. A five-minute cooldown clears it, and the CLI only writes on full
  completion so retrying is safe.
- **The four dominant rejection reasons are process problems, not engineering
  ones** — a skipped issue template, no support channel, no non-English
  routing. Acting on this report means changing intake, not code.

## Documentation

- `docs/superpowers/specs/` — the design, with every measured figure and the
  reasoning behind each decision
- `docs/superpowers/plans/` — the implementation plan, including a correction
  recording two requirements the plan dropped from its own spec
- `docs/DECISIONS.md` — the decision trail
