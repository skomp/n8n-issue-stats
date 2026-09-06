# n8n Triage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest the 5,464 triaged issues of `n8n-io/n8n`, classify them by segment and component, compute lead times, and publish a weekly markdown report to `skomp/n8n-reports`.

**Architecture:** Pure-function JS modules under `src/lib/` hold all logic. A local CLI uses them for the one-off backfill; a build step inlines the same modules into n8n Code nodes so the deployed workflows and the local tooling share one implementation. The store is NDJSON in `skomp/n8n-data`.

**Tech Stack:** Node 24 (already installed), **zero runtime dependencies**. Native `fetch`, native `node --test`, native `node:assert`. No npm install, no bundler, no TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-06-n8n-github-triage-analytics-design.md` — read it before Task 1. It carries every measured fact and must not be re-derived.

---

> ## CORRECTION — fix round 1, 2026-09-06
>
> **Every fixture-derived count in this plan is now out of date. Read the tests,
> not this plan, for expected values.**
>
> A mutation review ran 17 mutations against the finished build. 14 survived with
> the suite green, including deletion of both `mergedAt` filters. The root cause
> was that no real fixture record reaches the merged-PR branch of `componentOf`
> with an unmerged PR in play, so the filter had no test that could see it.
>
> Fix round 1 appended two SYNTHETIC records, numbered **900001** and **900002**,
> to `tests/fixtures/issues.sample.ndjson`. The 10 real records are byte-identical
> and were neither edited nor reordered. The fixture now holds **12 records**.
>
> | Claim in this plan | Was | Now |
> |---|---|---|
> | Fixture size | 10 real records | 10 real + 2 synthetic = 12 |
> | Segment split | 8 accepted / 2 rejected | 10 accepted / 2 rejected |
> | Issues with a merged closing PR | 5 of 10 | 6 of 12 |
> | `components.unclassified` | 2 | 3 |
> | `components['packages/nodes-base']` | 2 | 3 |
> | Component coverage on fixtures | 6/8 | 7/10 |
> | Task 3 step 5 assertion | `acc !== 8` | `acc !== 10` |
>
> **Fix round 3 superseded the "Now" column above.** It appended a third
> synthetic record, **900003**, carrying TWO `triage:*` labels: no fixture
> record carried more than one, so a funnel denominator built by summing
> `triageStates` (a count of LABELS) happened to equal the count of ISSUES and
> passed for the wrong reason. On the real store the two differ -- 1,546 labels
> across 1,309 issues. The 10 real records remain byte-identical and unreordered.
>
> | Claim | Fix round 1 | Fix round 3 (current) |
> |---|---|---|
> | Fixture size | 10 real + 2 synthetic = 12 | 10 real + 3 synthetic = **13** |
> | Segment split (all-time) | 10 accepted / 2 rejected | **11 accepted / 2 rejected** |
> | Issues with a merged closing PR | 6 of 12 | 6 of **13** (900003 links no PR) |
> | Triage labels vs triaged issues | equal by accident | **10 labels / 9 issues** in the test window |
> | Task 3 step 5 assertion | `acc !== 10` | `acc !== 11` |
>
> Fix round 3 also windowed the intake sections. `rollup()` now takes
> `{ windowDays = 180, now = new Date() }`; the rollup tests pass an explicit
> 440-day window ending 2026-09-06, which is the one that SPLITS this fixture
> (11 of 13 records inside it), so a windowed figure can never equal an
> all-time figure by accident. Within that window: `components.unclassified` is
> 4, `components['packages/nodes-base']` is 3, and component coverage is 5/9.
> Lead times are NOT windowed and stay at n=12 / n=6 / n=6.
>
> Two spec violations were also fixed, because the spec is binding above this
> plan. The plan omitted both:
>
> 1. Spec section 8 mandates a **Headline** metric. `rollup()` now returns
>    `headline: { shouldNotHaveBeenFiled, shareOfPopulation }`, counted from
>    `closed:incomplete-template`, `closed:support-issue` and
>    `closed:non-english` (an issue carrying two of them counts once). The
>    report renders a `## Headline` section before `## Intake and outcome`.
>    On the full store this measures 2,336 issues, 43%.
> 2. Spec section 8 mandates **"always print the denominator"**. The rejection
>    reasons, triage funnel and monthly intake tables printed none. Each now
>    carries a Share column and a stated denominator line.

---

## Global Constraints

- **The code in this plan is a PROPOSAL, not requirements.** It has not been executed. Be sceptical of it. If you conclude a snippet is wrong, say so with evidence and report the defect rather than implementing something you believe is incorrect. Two defects were already found and fixed during planning (see below); assume more remain.
- **If a file you own changes under you and you cannot account for the change, STOP and report it.** Do not revert it, stash it, `git checkout` it, or stage it. Quote the diff in your report. An unexplained edit is far more likely to be the owner working than corruption, and it is never yours to discard.
- Node 24, zero runtime dependencies. Dev dependencies are also forbidden — use `node --test`.
- All modules are ESM (`.js` with `"type": "module"` in `package.json`).
- Every pure function is tested against `tests/fixtures/issues.sample.ndjson`, which contains **10 real records** from the live repository. Assert **decoded values** (which component, how many days), never merely that a rule fired.
- Lead times are reported as **median and p90, never mean**.
- Every grouping prints its denominator. `unclassified` is a visible row, never dropped.
- Commit after every task. Do not push unless asked.

## Two defects already found during planning — do not reintroduce

1. **Scoped packages need three path segments.** `packages/@n8n/db` split at two segments yields `packages/@n8n`, which collapses **1,219** file references from ~40 distinct packages into one fictitious bucket that would rank second-largest in the report. Rule: if segment 1 starts with `@`, take three segments, else two.
2. **`closedByPullRequestsReferences` returns unmerged PRs.** **666 of 1,218** linked PRs (55%) have `mergedAt: null`. Fix lead time is computable for **543** issues, not the 909 that have any linked PR. Every merge-dependent calculation must filter `mergedAt != null` first.

## Measured facts (from the spec — do not re-derive)

| Fact | Value |
|---|---|
| Triaged population | 5,464 issues (33 labels, OR semantics) |
| Rejected at triage / accepted | 2,956 / 2,508 |
| Component coverage within accepted | 65% |
| Full backfill | 55 pages, 385 of 5,000 rate-limit points, ~3.5 min, 2.7 MB |
| GraphQL `issues(labels:)` | OR semantics (verified) |
| Ingest query cost | 6 points per 100-issue page (measured, not computed) |

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM flag, `test` and `backfill` scripts. No dependencies. |
| `src/lib/labels.js` | The 33 filter labels, the three families, ad-hoc component labels |
| `src/lib/github.js` | GraphQL POST + cursor pagination + rate-limit accounting |
| `src/lib/classify.js` | `segmentOf`, `componentOf` |
| `src/lib/metrics.js` | `leadTimes`, `median`, `p90` |
| `src/lib/rollup.js` | Fold records into the report data structure |
| `src/lib/report.js` | Render the rollup as markdown |
| `src/lib/store.js` | NDJSON parse/serialise, upsert by issue number |
| `src/backfill.js` | Local one-shot CLI |
| `src/sync.js` | Incremental sync, watermark handling |
| `build/build-workflows.js` | Inline `src/lib/*` into n8n Code nodes -> `workflows/*.json` |
| `scripts/deploy.sh` | POST/PUT workflows to n8n Cloud (blocked on free trial) |
| `tests/*.test.js` | One test file per lib module |
| `tests/fixtures/issues.sample.ndjson` | 10 real records — already committed |

---

### Task 1: Scaffold and label taxonomy

**Files:**
- Create: `package.json`, `src/lib/labels.js`, `tests/labels.test.js`
- Test: `tests/labels.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `TRIAGE_LABELS`, `TEAM_LABELS`, `CLOSED_LABELS`, `ALL_FILTER_LABELS` (string arrays); `ADHOC_COMPONENT_LABELS` (string array)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/labels.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIAGE_LABELS, TEAM_LABELS, CLOSED_LABELS, ALL_FILTER_LABELS } from '../src/lib/labels.js';

test('label families have the measured sizes', () => {
  assert.equal(TRIAGE_LABELS.length, 9);
  assert.equal(TEAM_LABELS.length, 15);
  assert.equal(CLOSED_LABELS.length, 9);
  assert.equal(ALL_FILTER_LABELS.length, 33);
});

test('filter list is deduplicated and fully qualified', () => {
  assert.equal(new Set(ALL_FILTER_LABELS).size, 33);
  assert.ok(ALL_FILTER_LABELS.every(l => /^(triage|team|closed):/.test(l)));
});

test('known members are present verbatim', () => {
  assert.ok(TEAM_LABELS.includes('team:nodes'));
  assert.ok(CLOSED_LABELS.includes('closed:incomplete-template'));
  assert.ok(TRIAGE_LABELS.includes('triage:needs-reproduction'));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/labels.test.js`
Expected: FAIL — cannot find module `../src/lib/labels.js`

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "n8n-triage-analytics",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test tests/*.test.js",
    "backfill": "node src/backfill.js"
  }
}
```

- [ ] **Step 4: Implement `src/lib/labels.js`**

```javascript
export const TRIAGE_LABELS = [
  'triage:pending', 'triage:in-progress', 'triage:needs-info',
  'triage:needs-reproduction', 'triage:ready-for-review', 'triage:complete',
  'triage:stalled', 'triage:ping', 'triage:tests-needed',
];

export const TEAM_LABELS = [
  'team:nodes', 'team:ai', 'team:api', 'team:iam', 'team:chat', 'team:design',
  'team:qa-dx', 'team:lifecycle', 'team:relay', 'team:identity', 'team:cats',
  'team:payday', 'team:adore', 'team:ins', 'team:instance-ai',
];

export const CLOSED_LABELS = [
  'closed:duplicate', 'closed:cant-reproduce', 'closed:working-as-expected',
  'closed:support-issue', 'closed:incomplete-template',
  'closed:enhancement/feature', 'closed:info', 'closed:non-english',
  'closed:requested',
];

export const ALL_FILTER_LABELS = [...TRIAGE_LABELS, ...TEAM_LABELS, ...CLOSED_LABELS];

// Retained deliberately: these matched ZERO issues in the measured population
// because they never co-occur with the 33 filter labels. They cost nothing and
// n8n's labelling may change. Do not delete them assuming they are broken.
export const ADHOC_COMPONENT_LABELS = [
  'core', 'ui', 'dx', 'deployment', 'performance', 'security',
];
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `node --test tests/labels.test.js`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add package.json src/lib/labels.js tests/labels.test.js
git commit -m "Add label taxonomy for the triaged-issue filter"
```

---

### Task 2: Segment and component classification

This task carries both planning-stage defects. Read the "Two defects" section above before starting.

**Files:**
- Create: `src/lib/classify.js`, `tests/classify.test.js`
- Test: `tests/classify.test.js`

**Interfaces:**
- Consumes: `ADHOC_COMPONENT_LABELS` from `src/lib/labels.js`
- Produces:
  - `segmentOf(issue) -> 'rejected' | 'accepted'`
  - `componentOf(issue) -> string | null` — returns `null` for rejected issues, `'unclassified'` for accepted issues with no signal
  - `packageOf(paths) -> string | null` — exported for direct testing

- [ ] **Step 1: Write the failing test**

Expected values below were computed from the real fixture records. They are correct as of 2026-09-06.

```javascript
// tests/classify.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentOf, componentOf, packageOf } from '../src/lib/classify.js';

const byNumber = new Map(
  readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
    .trim().split('\n').map(JSON.parse).map(i => [i.number, i])
);

test('segments split on the presence of a closed:* reason', () => {
  assert.equal(segmentOf(byNumber.get(16861)), 'rejected');
  assert.equal(segmentOf(byNumber.get(16971)), 'rejected');
  assert.equal(segmentOf(byNumber.get(16038)), 'accepted');
  assert.equal(segmentOf(byNumber.get(21305)), 'accepted');
});

test('team label wins and is stripped of its prefix', () => {
  assert.equal(componentOf(byNumber.get(16038)), 'nodes');
  assert.equal(componentOf(byNumber.get(16207)), 'payday');
});

test('rejected issues have no component at all', () => {
  assert.equal(componentOf(byNumber.get(16861)), null);
  assert.equal(componentOf(byNumber.get(16971)), null);
});

test('accepted issues with no signal are explicitly unclassified', () => {
  assert.equal(componentOf(byNumber.get(21305)), 'unclassified');
  assert.equal(componentOf(byNumber.get(21298)), 'unclassified');
});

// REGRESSION: a two-segment split collapses ~40 packages into `packages/@n8n`,
// which would rank second-largest in the report and does not exist.
test('scoped packages keep three path segments', () => {
  assert.equal(componentOf(byNumber.get(17688)), 'packages/@n8n/nodes-langchain');
  assert.equal(componentOf(byNumber.get(22016)), 'packages/@n8n/db');
  assert.equal(packageOf(['packages/@n8n/db/src/x.ts']), 'packages/@n8n/db');
});

test('unscoped packages keep two path segments', () => {
  assert.equal(componentOf(byNumber.get(22153)), 'packages/nodes-base');
  assert.equal(componentOf(byNumber.get(22122)), 'packages/nodes-base');
  assert.equal(packageOf(['packages/cli/src/x.ts']), 'packages/cli');
});

test('the dominant package wins, not the first seen', () => {
  assert.equal(
    packageOf(['packages/cli/a.ts', 'packages/core/b.ts', 'packages/core/c.ts']),
    'packages/core'
  );
});

test('non-package paths are ignored', () => {
  assert.equal(packageOf(['README.md', '.github/workflows/ci.yml']), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/classify.test.js`
Expected: FAIL — cannot find module `../src/lib/classify.js`

- [ ] **Step 3: Implement `src/lib/classify.js`**

```javascript
import { ADHOC_COMPONENT_LABELS } from './labels.js';

const namesOf = issue => (issue.labels?.nodes ?? []).map(l => l.name);

export function segmentOf(issue) {
  return namesOf(issue).some(n => n.startsWith('closed:')) ? 'rejected' : 'accepted';
}

export function packageOf(paths) {
  const counts = new Map();
  for (const path of paths) {
    if (!path.startsWith('packages/')) continue;
    const seg = path.split('/');
    // Scoped packages need three segments: packages/@n8n/db, not packages/@n8n.
    const depth = seg[1]?.startsWith('@') ? 3 : 2;
    if (seg.length < depth) continue;
    const key = seg.slice(0, depth).join('/');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export function componentOf(issue) {
  if (segmentOf(issue) === 'rejected') return null;

  const names = namesOf(issue);

  const team = names.find(n => n.startsWith('team:'));
  if (team) return team.slice('team:'.length);

  if (names.some(n => n.startsWith('node/'))) return 'nodes';

  const adhoc = names.find(n => ADHOC_COMPONENT_LABELS.includes(n));
  if (adhoc) return adhoc;

  // Only MERGED pull requests are evidence of where the fix landed.
  const paths = (issue.closedByPullRequestsReferences?.nodes ?? [])
    .filter(pr => pr.mergedAt != null)
    .flatMap(pr => (pr.files?.nodes ?? []).map(f => f.path));

  return packageOf(paths) ?? 'unclassified';
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/classify.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Verify against the whole population**

This guards the aggregate, not just the fixtures. Run the backfill store through the classifier once it exists (Task 7); for now assert the fixture split is **11 accepted / 2 rejected**.

> **CORRECTED in fix round 3.** This step previously carried two different
> figures two lines apart: the guard read `if (acc !== 10)` while the expected
> output below it read `accepted 8 rejected 2`. Fix round 1 corrected the guard
> from 8 to 10 when synthetic records 900001 and 900002 were appended, and
> missed the `Expected:` line. Fix round 3 appended synthetic record 900003, so
> the fixture is now 13 records: 11 accepted, 2 rejected. Both the guard and
> the expected output below are now that figure.

```bash
node -e "
import('./src/lib/classify.js').then(async ({segmentOf}) => {
  const {readFileSync} = await import('node:fs');
  const rs = readFileSync('tests/fixtures/issues.sample.ndjson','utf8').trim().split('\n').map(JSON.parse);
  const acc = rs.filter(r => segmentOf(r)==='accepted').length;
  console.log('accepted', acc, 'rejected', rs.length-acc, 'total', rs.length);
  if (acc !== 11) { console.error('EXPECTED 11 accepted'); process.exit(1); }
});"
```
Expected: `accepted 11 rejected 2 total 13`

- [ ] **Step 6: Commit**

```bash
git add src/lib/classify.js tests/classify.test.js
git commit -m "Add segment and component classification

Scoped packages keep three path segments; a two-segment split would
collapse ~40 packages into a fictitious packages/@n8n bucket. Component
derivation uses only merged PRs, since 55% of linked PRs never merged."
```

---

### Task 3: Lead-time metrics

**Files:**
- Create: `src/lib/metrics.js`, `tests/metrics.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `median(nums) -> number | null`
  - `p90(nums) -> number | null`
  - `leadTimes(issue) -> { closeDays: number|null, fixDays: number|null, prDays: number|null }`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/metrics.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { median, p90, leadTimes } from '../src/lib/metrics.js';

const byNumber = new Map(
  readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
    .trim().split('\n').map(JSON.parse).map(i => [i.number, i])
);
const round1 = n => n == null ? null : Math.round(n * 10) / 10;

// Deliberately not binary fractions: 0.5/0.25/0.75 pass both before and
// after a rounding bug.
test('median handles odd and even lengths', () => {
  assert.equal(median([0.74, 1.3, 9.1]), 1.3);
  assert.equal(median([0.74, 1.3, 9.1, 12.7]), 5.2);
  assert.equal(median([]), null);
});

test('p90 picks the 90th percentile by nearest-rank', () => {
  // Nearest-rank: ceil(10 * 0.9) = 9, so the 9th value (1-indexed) = 9, NOT 10.
  // Verified by executing this implementation against the fixtures.
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([0.74]), 0.74);
  assert.equal(p90([]), null);
});

test('fix lead time is measured to the merge, in days', () => {
  assert.equal(round1(leadTimes(byNumber.get(16038)).fixDays), 15.4);
  assert.equal(round1(leadTimes(byNumber.get(17688)).fixDays), 114.8);
  assert.equal(round1(leadTimes(byNumber.get(22016)).fixDays), 22.7);
  assert.equal(round1(leadTimes(byNumber.get(22153)).fixDays), 2.9);
  assert.equal(round1(leadTimes(byNumber.get(22122)).fixDays), 6.4);
});

// REGRESSION: 666 of 1,218 linked PRs were never merged. Issue 16207 has a
// team label AND a linked PR, but that PR is unmerged — fixDays must be null,
// not NaN, not 0, not a negative number.
test('an unmerged linked PR yields no fix lead time', () => {
  assert.equal(leadTimes(byNumber.get(16207)).fixDays, null);
  assert.equal(leadTimes(byNumber.get(16971)).fixDays, null);
});

test('an issue with no linked PR yields no fix lead time', () => {
  assert.equal(leadTimes(byNumber.get(21305)).fixDays, null);
});

test('lead times are never negative', () => {
  for (const issue of byNumber.values()) {
    for (const v of Object.values(leadTimes(issue))) {
      if (v != null) assert.ok(v >= 0, `negative lead time on #${issue.number}`);
    }
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/metrics.test.js`
Expected: FAIL — cannot find module `../src/lib/metrics.js`

- [ ] **Step 3: Implement `src/lib/metrics.js`**

```javascript
const DAY_MS = 86_400_000;
const days = (from, to) =>
  from && to ? (Date.parse(to) - Date.parse(from)) / DAY_MS : null;

export function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p90(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

export function leadTimes(issue) {
  // Only merged PRs count. 55% of linked PRs were closed without merging.
  const merged = (issue.closedByPullRequestsReferences?.nodes ?? [])
    .filter(pr => pr.mergedAt != null)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const first = merged[0] ?? null;

  return {
    closeDays: days(issue.createdAt, issue.closedAt),
    fixDays: first ? days(issue.createdAt, first.mergedAt) : null,
    prDays: first ? days(first.createdAt, first.mergedAt) : null,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/metrics.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics.js tests/metrics.test.js
git commit -m "Add lead-time metrics with median and p90

Only merged PRs produce a fix lead time: 666 of 1,218 linked PRs in the
measured population were closed without merging."
```

---

### Task 4: NDJSON store

**Files:**
- Create: `src/lib/store.js`, `tests/store.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parseStore(text) -> Map<number, issue>`
  - `serialiseStore(map) -> string` — newline-terminated NDJSON, ascending by issue number
  - `upsert(map, issues) -> Map` — mutates and returns, keyed on `number`
  - `watermarkOf(map) -> string | null` — max `updatedAt` as an ISO string

- [ ] **Step 1: Write the failing test**

```javascript
// tests/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore, serialiseStore, upsert, watermarkOf } from '../src/lib/store.js';

const text = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

test('parses every fixture record', () => {
  assert.equal(parseStore(text).size, 10);
});

test('round-trips without loss', () => {
  const once = parseStore(text);
  assert.deepEqual([...parseStore(serialiseStore(once)).keys()].sort(), [...once.keys()].sort());
});

test('serialises ascending by issue number and ends with a newline', () => {
  const out = serialiseStore(parseStore(text));
  const nums = out.trim().split('\n').map(l => JSON.parse(l).number);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  assert.ok(out.endsWith('\n'));
});

test('tolerates blank lines and trailing whitespace', () => {
  assert.equal(parseStore('\n' + text + '\n\n').size, 10);
});

// The incremental sync deliberately re-fetches an overlapping window.
test('upsert replaces by number rather than appending duplicates', () => {
  const store = parseStore(text);
  const before = store.size;
  const changed = { ...store.get(16038), title: 'CHANGED' };
  upsert(store, [changed]);
  assert.equal(store.size, before);
  assert.equal(store.get(16038).title, 'CHANGED');
});

test('watermark is the maximum updatedAt', () => {
  const store = parseStore(text);
  const expected = [...store.values()].map(i => i.updatedAt).sort().at(-1);
  assert.equal(watermarkOf(store), expected);
  assert.equal(watermarkOf(new Map()), null);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/store.test.js`
Expected: FAIL — cannot find module `../src/lib/store.js`

- [ ] **Step 3: Implement `src/lib/store.js`**

```javascript
export function parseStore(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const issue = JSON.parse(trimmed);
    map.set(issue.number, issue);
  }
  return map;
}

export function serialiseStore(map) {
  return [...map.values()]
    .sort((a, b) => a.number - b.number)
    .map(i => JSON.stringify(i))
    .join('\n') + '\n';
}

export function upsert(map, issues) {
  for (const issue of issues) map.set(issue.number, issue);
  return map;
}

export function watermarkOf(map) {
  let max = null;
  for (const issue of map.values()) {
    if (issue.updatedAt && (max === null || issue.updatedAt > max)) max = issue.updatedAt;
  }
  return max;
}
```

ISO-8601 UTC strings sort lexicographically in timestamp order, so string comparison is correct here. Every `updatedAt` GitHub returns ends in `Z`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/store.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.js tests/store.test.js
git commit -m "Add NDJSON store with upsert by issue number"
```

---

### Task 5: GitHub GraphQL client

**Files:**
- Create: `src/lib/github.js`, `tests/github.test.js`

**Interfaces:**
- Consumes: `ALL_FILTER_LABELS` from `src/lib/labels.js`
- Produces:
  - `ISSUES_QUERY` (string) — the exact query from the spec
  - `fetchPage({token, cursor, since}) -> {nodes, endCursor, hasNextPage, cost, remaining}`
  - `fetchAll({token, since, onPage}) -> {issues, pages, points}`

- [ ] **Step 1: Write the failing test**

Network is not mocked; the client is exercised against a stub `fetch` so the test is offline and deterministic.

```javascript
// tests/github.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUES_QUERY, fetchPage, fetchAll } from '../src/lib/github.js';

const page = (nodes, hasNextPage, endCursor) => ({
  ok: true,
  json: async () => ({
    data: {
      rateLimit: { cost: 6, remaining: 4000 },
      repository: { issues: { pageInfo: { hasNextPage, endCursor }, nodes } },
    },
  }),
});

test('query pins the ascending order the spec requires', () => {
  assert.match(ISSUES_QUERY, /direction:\s*ASC/);
  assert.match(ISSUES_QUERY, /field:\s*UPDATED_AT/);
  assert.doesNotMatch(ISSUES_QUERY, /DESC/);
});

test('query requests the fields the classifier and metrics need', () => {
  for (const field of ['createdAt', 'closedAt', 'updatedAt', 'mergedAt',
                       'closedByPullRequestsReferences', 'files', 'labels']) {
    assert.ok(ISSUES_QUERY.includes(field), `missing ${field}`);
  }
});

test('fetchAll follows cursors until exhausted', async () => {
  const pages = [
    page([{ number: 1 }, { number: 2 }], true, 'c1'),
    page([{ number: 3 }], false, null),
  ];
  let seen = [];
  globalThis.fetch = async (_url, opts) => {
    seen.push(JSON.parse(opts.body).variables.cursor);
    return pages.shift();
  };
  const res = await fetchAll({ token: 't' });
  assert.equal(res.issues.length, 3);
  assert.equal(res.pages, 2);
  assert.equal(res.points, 12);
  assert.deepEqual(seen, [null, 'c1']);
});

test('a GraphQL errors array is thrown, not silently ignored', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'boom' }] }) });
  await assert.rejects(() => fetchPage({ token: 't' }), /boom/);
});

test('an HTTP failure is thrown with its status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad credentials' });
  await assert.rejects(() => fetchPage({ token: 't' }), /401/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/github.test.js`
Expected: FAIL — cannot find module `../src/lib/github.js`

- [ ] **Step 3: Implement `src/lib/github.js`**

```javascript
import { ALL_FILTER_LABELS } from './labels.js';

export const ISSUES_QUERY = `
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
}`;

export async function fetchPage({ token, cursor = null, since = null }) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'skomp-n8n-triage-analytics',
    },
    body: JSON.stringify({
      query: ISSUES_QUERY,
      variables: { cursor, since, labels: ALL_FILTER_LABELS },
    }),
  });

  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.errors) throw new Error(`GitHub GraphQL: ${body.errors.map(e => e.message).join('; ')}`);

  const conn = body.data.repository.issues;
  return {
    nodes: conn.nodes,
    endCursor: conn.pageInfo.endCursor,
    hasNextPage: conn.pageInfo.hasNextPage,
    cost: body.data.rateLimit.cost,
    remaining: body.data.rateLimit.remaining,
  };
}

export async function fetchAll({ token, since = null, onPage = null }) {
  const issues = [];
  let cursor = null, pages = 0, points = 0;

  for (;;) {
    const page = await fetchPage({ token, cursor, since });
    issues.push(...page.nodes);
    pages += 1;
    points += page.cost;
    if (onPage) onPage({ pages, points, received: issues.length, remaining: page.remaining });
    if (!page.hasNextPage) break;
    cursor = page.endCursor;
  }

  return { issues, pages, points };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/github.test.js`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.js tests/github.test.js
git commit -m "Add GitHub GraphQL client with cursor pagination

Ordering is pinned ascending by updatedAt: descending pagination has a
documented race where records shift between pages mid-crawl."
```

---

### Task 6: Rollup aggregation

> **SUPERSEDED IN PART — read `src/lib/rollup.js` before reusing this task's
> code.** Fix round 3 gave `rollup()` an options argument
> (`{ windowDays = 180, now = new Date() }`), added `window: { since, days,
> population }` and `triagedIssues` to the returned shape, windowed the intake
> sections while deliberately leaving all three lead-time measures over full
> history, and split the headline into windowed and `allTime` figures. The
> code blocks below are the ORIGINAL build and no longer match what ships.
> The same applies to Task 7's report renderer.

**Files:**
- Create: `src/lib/rollup.js`, `tests/rollup.test.js`

**Interfaces:**
- Consumes: `segmentOf`, `componentOf` from `classify.js`; `leadTimes`, `median`, `p90` from `metrics.js`
- Produces: `rollup(issues) -> Rollup`, where `Rollup` is:

```javascript
{
  total: number,
  segments: { accepted: number, rejected: number },
  // Spec section 8 mandates this as the report's HEADLINE. Counted from issues
  // carrying any of closed:incomplete-template, closed:support-issue,
  // closed:non-english; an issue with two of them counts once.
  headline: { shouldNotHaveBeenFiled: number, shareOfPopulation: number },
  rejectionReasons: Record<string, number>,   // 'closed:duplicate' -> count
  components: Record<string, number>,         // accepted only; includes 'unclassified'
  componentCoverage: number,                  // 0..1, share of accepted that is not 'unclassified'
  triageStates: Record<string, number>,       // 'triage:pending' -> count
  leadTimes: {
    close: { median: number|null, p90: number|null, n: number },
    fix:   { median: number|null, p90: number|null, n: number },
    pr:    { median: number|null, p90: number|null, n: number },
  },
  byMonth: Record<string, { accepted: number, rejected: number }>,  // 'YYYY-MM'
}
```

- [ ] **Step 1: Write the failing test**

```javascript
// tests/rollup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);
const r = rollup(issues);

test('segments partition the population exactly', () => {
  assert.equal(r.total, 10);
  assert.equal(r.segments.accepted, 8);
  assert.equal(r.segments.rejected, 2);
  assert.equal(r.segments.accepted + r.segments.rejected, r.total);
});

test('component counts cover the accepted segment and nothing else', () => {
  const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
  assert.equal(summed, r.segments.accepted);
  assert.equal(r.components['packages/nodes-base'], 2);
  assert.equal(r.components['nodes'], 1);
  assert.equal(r.components['payday'], 1);
  assert.equal(r.components['unclassified'], 2);
});

test('coverage excludes unclassified and is a real fraction', () => {
  assert.equal(r.componentCoverage, 6 / 8);
});

test('rejection reasons are counted from closed:* labels', () => {
  assert.equal(r.rejectionReasons['closed:incomplete-template'], 1);
  assert.equal(r.rejectionReasons['closed:enhancement/feature'], 1);
});

// CORRECTED in fix round 1, and again in fix round 3: 6 of the 13 fixtures
// have a merged closing PR (it was 5 of 10 before the synthetic records
// 900001/900002 were appended; record 900003, appended in fix round 3, is
// open and links no PR, so the count of 6 is unchanged).
//
// CORRECTION NOTE (fix round 3): the snippet below previously read
// `assert.equal(r.leadTimes.fix.n, 5)` and `assert.ok(median > 0)` under a
// comment claiming 6 of the 12 and claiming the assertion had been
// strengthened to check the median and p90 BY VALUE. The comment was right
// and the code was stale -- `median > 0` holds for almost any wrong number,
// which is the exact defect fix round 1 existed to remove. The real
// tests/rollup.test.js has always been correct; only this snippet was wrong.
test('fix lead time is computed over merged PRs only', () => {
  assert.equal(r.leadTimes.fix.n, 6);
  assert.equal(Math.round(r.leadTimes.fix.median * 10) / 10, 12);
  assert.equal(Math.round(r.leadTimes.fix.p90 * 10) / 10, 114.8);
});

test('months are keyed YYYY-MM and sum to the total', () => {
  const summed = Object.values(r.byMonth).reduce((a, m) => a + m.accepted + m.rejected, 0);
  assert.equal(summed, r.total);
  assert.ok(Object.keys(r.byMonth).every(k => /^\d{4}-\d{2}$/.test(k)));
});

test('an empty population does not throw', () => {
  const empty = rollup([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.leadTimes.fix.median, null);
  assert.equal(empty.componentCoverage, 0);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/rollup.test.js`
Expected: FAIL — cannot find module `../src/lib/rollup.js`

- [ ] **Step 3: Implement `src/lib/rollup.js`**

```javascript
import { segmentOf, componentOf } from './classify.js';
import { leadTimes, median, p90 } from './metrics.js';

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
const summarise = xs => ({ median: median(xs), p90: p90(xs), n: xs.length });

export function rollup(issues) {
  const segments = { accepted: 0, rejected: 0 };
  const rejectionReasons = {}, components = {}, triageStates = {}, byMonth = {};
  const close = [], fix = [], pr = [];

  for (const issue of issues) {
    const segment = segmentOf(issue);
    segments[segment] += 1;

    const names = (issue.labels?.nodes ?? []).map(l => l.name);
    for (const n of names) {
      if (n.startsWith('closed:')) bump(rejectionReasons, n);
      if (n.startsWith('triage:')) bump(triageStates, n);
    }

    if (segment === 'accepted') bump(components, componentOf(issue));

    const month = (issue.createdAt ?? '').slice(0, 7);
    if (month) {
      byMonth[month] ??= { accepted: 0, rejected: 0 };
      byMonth[month][segment] += 1;
    }

    const lt = leadTimes(issue);
    if (lt.closeDays != null) close.push(lt.closeDays);
    if (lt.fixDays != null) fix.push(lt.fixDays);
    if (lt.prDays != null) pr.push(lt.prDays);
  }

  const classified = segments.accepted - (components.unclassified ?? 0);

  return {
    total: issues.length,
    segments,
    rejectionReasons,
    components,
    componentCoverage: segments.accepted === 0 ? 0 : classified / segments.accepted,
    triageStates,
    leadTimes: { close: summarise(close), fix: summarise(fix), pr: summarise(pr) },
    byMonth,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/rollup.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/rollup.js tests/rollup.test.js
git commit -m "Add rollup aggregation over the triaged population"
```

---

### Task 7: Markdown report renderer

**Files:**
- Create: `src/lib/report.js`, `tests/report.test.js`

**Interfaces:**
- Consumes: the `Rollup` shape from Task 6
- Produces:
  - `renderReport(rollup, {generatedAt}) -> string` (markdown)
  - `reportPath(date) -> string` — e.g. `reports/2026-09-06-triage.md`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/report.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';
import { renderReport, reportPath } from '../src/lib/report.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);
const md = renderReport(rollup(issues), { generatedAt: '2026-09-06T10:00:00Z' });

test('path is dated and stable', () => {
  assert.equal(reportPath(new Date('2026-09-06T10:00:00Z')), 'reports/2026-09-06-triage.md');
});

test('every required section is present', () => {
  for (const heading of ['Intake and outcome', 'Rejection reasons', 'Component',
                         'Triage funnel', 'Lead times', 'Coverage and caveats']) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
});

test('the denominator is always printed', () => {
  assert.ok(md.includes('10'), 'population size must appear');
  assert.match(md, /coverage/i);
});

test('unclassified is shown, never silently dropped', () => {
  assert.ok(md.includes('unclassified'));
});

// The spec forbids REPORTING a mean; the prose may still explain why.
// A document-wide word ban fails against our own caveat text ("an average
// would be meaningless") and tempts an implementer to delete the caveat.
// Assert on the table headers instead, which is what the rule is about.
test('no mean or average column is published', () => {
  assert.match(md, /median/i);
  assert.match(md, /p90/i);
  const headers = md.split('\n').filter(l => l.startsWith('| Measure'));
  assert.ok(headers.length > 0, 'lead-time table must exist');
  for (const h of headers) assert.doesNotMatch(h, /\bmean\b|\baverage\b/i);
});

test('the Linear caveat is stated so nobody reads this as delivery data', () => {
  assert.match(md, /Linear/);
});

test('rendering is deterministic for a fixed input', () => {
  assert.equal(md, renderReport(rollup(issues), { generatedAt: '2026-09-06T10:00:00Z' }));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/report.test.js`
Expected: FAIL — cannot find module `../src/lib/report.js`

- [ ] **Step 3: Implement `src/lib/report.js`**

```javascript
const pct = (n, d) => d === 0 ? '0%' : `${Math.round(n / d * 100)}%`;
const num = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();

const table = (header, rows) =>
  [`| ${header.join(' | ')} |`,
   `|${header.map(() => '---').join('|')}|`,
   ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

const sortedEntries = obj => Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export function reportPath(date) {
  return `reports/${date.toISOString().slice(0, 10)}-triage.md`;
}

export function renderReport(r, { generatedAt }) {
  const { total, segments: s } = r;
  const lt = r.leadTimes;

  return `# n8n triage report — ${generatedAt.slice(0, 10)}

Population: **${total}** triaged issues from \`n8n-io/n8n\`.
Generated ${generatedAt}.

## Intake and outcome

${table(['Segment', 'Issues', 'Share'], [
  ['Accepted', s.accepted, pct(s.accepted, total)],
  ['Rejected at triage', s.rejected, pct(s.rejected, total)],
])}

## Rejection reasons

${table(['Reason', 'Issues'], sortedEntries(r.rejectionReasons))}

An issue may carry more than one reason, so these need not sum to ${s.rejected}.

## Component

Accepted issues only. Component coverage: **${pct(r.componentCoverage * s.accepted, s.accepted)}** of ${s.accepted} accepted issues.

${table(['Component', 'Issues'], sortedEntries(r.components))}

## Triage funnel

${table(['State', 'Issues'], sortedEntries(r.triageStates))}

## Lead times

Reported as median and p90. Means are omitted deliberately: the distribution has a long tail and an average would be meaningless.

${table(['Measure', 'Median (days)', 'p90 (days)', 'n'], [
  ['Issue opened → closed', num(lt.close.median), num(lt.close.p90), lt.close.n],
  ['Issue opened → fix merged', num(lt.fix.median), num(lt.fix.p90), lt.fix.n],
  ['Fix PR opened → merged', num(lt.pr.median), num(lt.pr.p90), lt.pr.n],
])}

## Monthly intake

${table(['Month', 'Accepted', 'Rejected'],
  Object.entries(r.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => [m, v.accepted, v.rejected]))}

## Coverage and caveats

- This measures **intake and triage, not delivery.** n8n moves accepted issues into **Linear**, at which point GitHub stops being the system of record. Do not read this as engineering throughput.
- Only issues carrying one of 33 \`triage:*\`, \`team:*\` or \`closed:*\` labels are included. Unlabelled community issues are out of scope.
- \`unclassified\` counts accepted issues with no team label and no merged fix PR to derive a component from. It is reported, not hidden.
- Fix lead time is computed only where a linked PR was actually **merged**. Linked-but-unmerged PRs are excluded.
`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/report.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/report.js tests/report.test.js
git commit -m "Add markdown report renderer"
```

---

### Task 8: Backfill CLI

**Files:**
- Create: `src/backfill.js`, `README.md`
- Modify: `package.json` (already has the `backfill` script from Task 1)

**Interfaces:**
- Consumes: `fetchAll` (Task 5), `serialiseStore`/`upsert`/`parseStore` (Task 4)
- Produces: `data/issues.ndjson` on disk, ready to commit to `skomp/n8n-data`

This task has no unit test — it is I/O and network orchestration. It is verified by running it and asserting the measured outcome.

- [ ] **Step 1: Implement `src/backfill.js`**

```javascript
import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchAll } from './lib/github.js';
import { serialiseStore, upsert } from './lib/store.js';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set. Use a fine-grained PAT with Issues:read and Pull requests:read.');
  process.exit(1);
}

const out = process.argv[2] ?? 'data/issues.ndjson';

const { issues, pages, points } = await fetchAll({
  token,
  onPage: ({ pages, received, remaining }) =>
    process.stderr.write(`\rpage ${pages}  issues ${received}  rate-limit remaining ${remaining}   `),
});
process.stderr.write('\n');

const store = upsert(new Map(), issues);
mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(out, serialiseStore(store));

console.log(`wrote ${store.size} issues to ${out} (${pages} pages, ${points} rate-limit points)`);
if (store.size !== issues.length) {
  console.warn(`note: ${issues.length - store.size} duplicate issue numbers were collapsed`);
}
```

- [ ] **Step 2: Run it against the live API**

```bash
GITHUB_TOKEN=$(gh auth token) node src/backfill.js data/issues.ndjson
```

Expected, from the measured backfill during design: **55 pages, ~385 rate-limit points, 5,464 issues, ~3.5 minutes.** A materially different issue count means the label filter or pagination is wrong — investigate before continuing.

- [ ] **Step 3: Assert the outcome against the spec's measured figures**

```bash
test "$(wc -l < data/issues.ndjson)" -eq 5464 && echo "OK: 5464 records" || echo "MISMATCH"
node -e "
import('./src/lib/rollup.js').then(async ({rollup}) => {
  const {readFileSync} = await import('node:fs');
  const rs = readFileSync('data/issues.ndjson','utf8').trim().split('\n').map(JSON.parse);
  // windowDays MUST be passed explicitly. rollup() defaults to a 180-day
  // intake window, so rollup(rs) measures 1,688 recently created issues, not
  // the full 5,464-record population the figures below were measured over.
  // 100000 days is longer than the repository has existed, so it selects
  // everything and reproduces the spec's all-time figures.
  const r = rollup(rs, { windowDays: 100000 });
  console.log('accepted', r.segments.accepted, '(expect 2508)');
  console.log('rejected', r.segments.rejected, '(expect 2956)');
  console.log('coverage', Math.round(r.componentCoverage*100)+'%', '(expect 65%)');
});"
```

**Correction, 2026-09-06.** This snippet previously called `rollup(rs)` with no
options. After the windowing change that measured the 180-day window, so it
printed accepted 824, rejected 864 and coverage 95% against expectations of
2508, 2956 and 65% — a permanent, misleading MISMATCH against a correct
implementation. Executed with the explicit window above, it prints 2508 / 2956
/ 65.0%.

- [ ] **Step 4: Write `README.md`**

Cover: what the project does, the three repos, how to get a token, how to run the backfill, how to run tests, and the free-trial deployment blocker with a pointer to the spec's section 9.

- [ ] **Step 5: Commit**

```bash
git add src/backfill.js README.md package.json
git commit -m "Add local backfill CLI

Verified against the live API: 55 pages, 385 rate-limit points, 5,464 issues."
```

- [ ] **Step 6: Publish the store to skomp/n8n-data**

```bash
gh api repos/skomp/n8n-data/contents/issues.ndjson \
  -X PUT -f message="Add backfilled triaged issues from n8n-io/n8n" \
  -f content="$(base64 -i data/issues.ndjson)"
```

If the file exceeds the Contents API limit, push it with a normal git clone and commit instead. 2.7 MB is well inside the limit, so this should succeed.

---

### Task 9: Incremental sync

**Files:**
- Create: `src/sync.js`, `tests/sync.test.js`

**Interfaces:**
- Consumes: `fetchAll` (Task 5), store helpers (Task 4)
- Produces:
  - `syncSince(store, {token}) -> {store, fetched, watermark}`
  - `overlapWindow(watermark) -> string | null` — exported for direct testing

- [ ] **Step 1: Write the failing test**

```javascript
// tests/sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStore } from '../src/lib/store.js';
import { syncSince, overlapWindow } from '../src/sync.js';

const text = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8');

test('the query window is pulled back to absorb clock skew', () => {
  assert.equal(overlapWindow('2026-09-06T12:00:00Z'), '2026-09-06T11:55:00Z');
});

test('an empty store asks for everything', () => {
  assert.equal(overlapWindow(null), null);
});

// The overlap re-fetches records already held. That must not duplicate them.
test('re-syncing the same records leaves the store size unchanged', async () => {
  const store = parseStore(text);
  const before = store.size;
  const existing = [...store.values()].slice(0, 3);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: existing } },
    }}),
  });
  const res = await syncSince(store, { token: 't' });
  assert.equal(res.store.size, before);
  assert.equal(res.fetched, 3);
});

test('the returned watermark is the newest updatedAt in the store', async () => {
  const store = parseStore(text);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: {
      rateLimit: { cost: 1, remaining: 4999 },
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    }}),
  });
  const res = await syncSince(store, { token: 't' });
  const expected = [...store.values()].map(i => i.updatedAt).sort().at(-1);
  assert.equal(res.watermark, expected);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/sync.test.js`
Expected: FAIL — cannot find module `../src/sync.js`

- [ ] **Step 3: Implement `src/sync.js`**

```javascript
import { fetchAll } from './lib/github.js';
import { upsert, watermarkOf } from './lib/store.js';

const OVERLAP_MS = 5 * 60 * 1000;

// Deliberately re-fetch a 5-minute overlap. Duplicates are cheap because
// upsert is keyed on issue number; a gap is silent and permanent.
export function overlapWindow(watermark) {
  if (!watermark) return null;
  return new Date(Date.parse(watermark) - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function syncSince(store, { token }) {
  const since = overlapWindow(watermarkOf(store));
  const { issues } = await fetchAll({ token, since });
  upsert(store, issues);
  return { store, fetched: issues.length, watermark: watermarkOf(store) };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/sync.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, all files

- [ ] **Step 6: Commit**

```bash
git add src/sync.js tests/sync.test.js
git commit -m "Add incremental sync with an overlapping watermark window"
```

---

### Task 10: Workflow build and deploy

**Files:**
- Create: `build/build-workflows.js`, `scripts/deploy.sh`, `workflows/.gitkeep`

**Interfaces:**
- Consumes: everything in `src/lib/`
- Produces: `workflows/ingest.json`, `workflows/report.json`

**Deployment is blocked on the free trial.** Per spec section 9, n8n's public API is unavailable during the trial. Build the artefacts and the script; test the script's JSON transformation offline. Do not expect a successful deploy until the plan changes or the MCP route is confirmed.

- [ ] **Step 1: Write the failing test for the field stripper**

```javascript
// tests/build.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripInstanceFields } from '../build/build-workflows.js';

test('instance-specific fields are removed before commit', () => {
  const cleaned = stripInstanceFields({
    id: 'abc', versionId: 'v1', versionCounter: 3, activeVersionId: 'a',
    sourceWorkflowId: 's', name: 'keep me', staticData: { x: 1 },
    shared: [{ role: 'owner' }], createdAt: 't', updatedAt: 't',
    meta: { instanceId: 'i', templateId: 'keep' },
    tags: [{ id: 'tid', name: 'keep' }],
    nodes: [{ id: 'nid', webhookId: 'wid', name: 'Node', type: 'n8n-nodes-base.code' }],
    connections: {},
  });

  for (const gone of ['id', 'versionId', 'versionCounter', 'activeVersionId',
                      'sourceWorkflowId', 'staticData', 'shared', 'createdAt', 'updatedAt']) {
    assert.ok(!(gone in cleaned), `${gone} should have been stripped`);
  }
  assert.equal(cleaned.name, 'keep me');
  assert.ok(!('instanceId' in cleaned.meta));
  assert.equal(cleaned.meta.templateId, 'keep');
  assert.ok(!('id' in cleaned.nodes[0]));
  assert.ok(!('webhookId' in cleaned.nodes[0]));
  assert.equal(cleaned.nodes[0].name, 'Node');
  assert.ok(!('id' in cleaned.tags[0]));
  assert.equal(cleaned.tags[0].name, 'keep');
});

test('stripping is idempotent', () => {
  const once = stripInstanceFields({ id: 'a', name: 'w', nodes: [], connections: {} });
  assert.deepEqual(stripInstanceFields(once), once);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/build.test.js`
Expected: FAIL — cannot find module `../build/build-workflows.js`

- [ ] **Step 3: Implement `stripInstanceFields` in `build/build-workflows.js`**

```javascript
const WORKFLOW_FIELDS = ['id', 'versionId', 'versionCounter', 'activeVersionId',
  'sourceWorkflowId', 'staticData', 'shared', 'createdAt', 'updatedAt', 'activeVersion'];
const NODE_FIELDS = ['id', 'webhookId', 'createdAt', 'updatedAt'];

const omit = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

export function stripInstanceFields(workflow) {
  const out = omit(workflow, WORKFLOW_FIELDS);
  if (out.meta) out.meta = omit(out.meta, ['instanceId']);
  if (out.nodes) out.nodes = out.nodes.map(n => omit(n, NODE_FIELDS));
  if (out.tags) out.tags = out.tags.map(t => omit(t, ['id']));
  return out;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/build.test.js`
Expected: PASS, 2 tests

- [ ] **Step 5: Build the two workflows**

Add to `build/build-workflows.js` a generator that emits `workflows/ingest.json` and `workflows/report.json`. Each is an n8n workflow whose Code node body is the concatenated source of the relevant `src/lib/*.js` modules with `export ` prefixes removed, followed by a small driver.

**Critical memory constraint, from spec section 5:** the report workflow's Code node must receive the store as a **single item containing text**, parse it internally, and return **one item** holding the rollup. It must never emit one item per issue — that is the failure mode that caused the original out-of-memory error.

Structure:
- `ingest.json` — Schedule Trigger (daily) → HTTP Request (read `state.json` + `issues.ndjson` from `n8n-data`) → Code (sync logic) → HTTP Request (PUT both files back)
- `report.json` — Schedule Trigger (weekly) → HTTP Request (read `issues.ndjson`, one item) → Code (rollup + render, one item out) → HTTP Request (PUT the dated report to `n8n-reports`)

- [ ] **Step 6: Write `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${N8N_API_KEY:?set N8N_API_KEY (Settings > n8n API). Unavailable on the free trial.}"
BASE="${N8N_BASE_URL:-https://skomp.app.n8n.cloud}/api/v1"

for wf in workflows/*.json; do
  name=$(jq -r .name "$wf")
  id=$(curl -sf -H "X-N8N-API-KEY: $N8N_API_KEY" "$BASE/workflows" \
       | jq -r --arg n "$name" '.data[] | select(.name==$n) | .id' | head -1)

  if [ -n "$id" ]; then
    echo "updating $name ($id)"
    curl -sf -X PUT -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
      --data @"$wf" "$BASE/workflows/$id" > /dev/null
  else
    echo "creating $name"
    curl -sf -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
      --data @"$wf" "$BASE/workflows" > /dev/null
  fi
done
echo "done"
```

- [ ] **Step 7: Verify the script fails cleanly without a key**

Run: `unset N8N_API_KEY; bash scripts/deploy.sh; echo "exit=$?"`
Expected: a clear message naming the free-trial limitation, non-zero exit, no traceback.

- [ ] **Step 8: Commit**

```bash
chmod +x scripts/deploy.sh
git add build/ scripts/ workflows/ tests/build.test.js
git commit -m "Add workflow build and deploy script

Deployment is blocked on the n8n Cloud free trial, where the public API is
unavailable. The build and the field stripper are testable offline."
```

---

## Correction — 2026-09-06, after the Task 1-7 review

Two defects in THIS PLAN, found after the code was delivered. Both were transcribed
faithfully by the implementers, because a plan reads as requirements.

1. **The plan dropped two of its own spec's requirements.** Spec section 8 mandates a
   Headline metric (the `shouldNotHaveBeenFiled` count — 2,336 issues, 43%) and says
   "Always print the denominator. Every grouping states what share of the population
   it covers." The Task 6 Rollup shape omitted the headline field entirely, and the
   Task 7 template put a denominator on one of five groupings. The spec was right;
   the plan failed to carry it.

2. **The tests specified here were written to pass, not to fail.** A mutation review of
   the delivered code ran 17 mutations and **14 survived with the full suite green** —
   including deletion of BOTH `mergedAt` filters, the defect this plan itself flags as
   load-bearing. The `leadTimes` test that claims to cover it passes for the wrong
   reason: without the filter, `days(createdAt, null)` returns null via a guard, so the
   assertion sees null either way. That test could never have failed.

The Rollup shape above is corrected. Full remediation requirements are in
`.superpowers/sdd/2026-09-06-n8n-triage-analytics/fix-round-1-findings.md`.

**The lesson for anyone reading this plan: a test that passes against the current
implementation has proven nothing until you have watched it fail against a broken one.**

## Self-review

**Spec coverage.** Section 3 population → Task 1. Section 4 accepted/rejected seam → Tasks 2, 6. Section 6 ingest contract, ascending order, watermark → Tasks 5, 9. Section 7 component derivation → Task 2. Section 8 report contents and statistical rules → Tasks 6, 7. Section 9 deployment and field stripping → Task 10. Section 10 secrets → Tasks 8, 10. Section 11 verification → distributed; the population-level assertions live in Task 8 Step 3.

**Placeholders.** None. Every code step carries runnable content; Task 10 Step 5 specifies structure and the binding memory constraint rather than a full workflow JSON, because that artefact is generated and is too large to transcribe usefully.

**Type consistency.** `segmentOf`/`componentOf`/`packageOf` (Task 2) are consumed under those exact names in Task 6. `leadTimes` returns `{closeDays, fixDays, prDays}` in Task 3 and is destructured under those names in Task 6. `parseStore`/`serialiseStore`/`upsert`/`watermarkOf` (Task 4) are used under those names in Tasks 8 and 9. The `Rollup` shape declared in Task 6 matches every field `renderReport` reads in Task 7.

**Plan code was executed, not just written.** Every proposed function in Tasks 2, 3 and 6 was run against the real fixtures before this plan was committed: 26 claims checked, 25 correct. The one failure was an incorrect expected value in the p90 test (10 vs the correct 9), now fixed. Treat the remaining code as a proposal regardless — execution against 10 fixtures is not proof against 5,464 records.

**Known gap.** Task 10 Step 5 is the least specified step in the plan, because generating n8n workflow JSON depends on node type versions that cannot be read from the instance while the API is unavailable. Expect to iterate there, and confirm the deploy route first.
