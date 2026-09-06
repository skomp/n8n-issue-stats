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

// I6: closeDays and prDays previously had no decoded expectation, so
// computing closeDays against `updatedAt` and prDays against the ISSUE's
// createdAt both survived the suite. On the 10 real records closedAt and
// updatedAt differ by at most 9 seconds, so only the synthetic records
// 900001/900002 can separate them.
test('close lead time is measured to closedAt, not updatedAt', () => {
  assert.equal(round1(leadTimes(byNumber.get(900001)).closeDays), 3.7);
  assert.equal(round1(leadTimes(byNumber.get(900002)).closeDays), 9.2);
  assert.equal(round1(leadTimes(byNumber.get(17688)).closeDays), 112);
  assert.equal(round1(leadTimes(byNumber.get(16207)).closeDays), 35.5);
});

test('PR lead time is measured from the PR opening, not the issue opening', () => {
  // #16038: issue opened 2025-06-05, PR opened 2025-06-19, merged 2025-06-20.
  // Measuring from the issue would give 15.4, the fixDays value.
  assert.equal(round1(leadTimes(byNumber.get(16038)).prDays), 0.9);
  assert.equal(round1(leadTimes(byNumber.get(17688)).prDays), 87);
  assert.equal(round1(leadTimes(byNumber.get(22016)).prDays), 22.3);
  assert.equal(round1(leadTimes(byNumber.get(22153)).prDays), 2.8);
  assert.equal(round1(leadTimes(byNumber.get(22122)).prDays), 3.6);
});

// SYNTHETIC FIXTURES 900001/900002. C1: the test above named "an unmerged
// linked PR yields no fix lead time" passed for the WRONG reason — without the
// mergedAt filter, merged[0].mergedAt is null and days() returns null through
// its own `from && to` guard, so the assertion could not tell the two apart.
// #900002 has BOTH an unmerged and a merged PR, so dropping the filter yields a
// real number computed from the wrong PR rather than null.
test('an unmerged-only PR yields no fix or PR lead time', () => {
  const lt = leadTimes(byNumber.get(900001));
  assert.equal(lt.fixDays, null);
  assert.equal(lt.prDays, null);
});

test('lead times use the merged PR when an unmerged PR is also linked', () => {
  // The unmerged PR sorts first by number and by createdAt; only the mergedAt
  // filter keeps it out. Computed from PR 900202 (merged 2026-02-10T14:24:00Z).
  const lt = leadTimes(byNumber.get(900002));
  assert.equal(round1(lt.fixDays), 8.6);
  assert.equal(round1(lt.prDays), 6.6);
});

// SYNTHETIC FIXTURE 900004. Deleting the `.sort()` in leadTimes() left all 187
// tests green: no fixture linked TWO merged PRs, so merged[0] was the only
// merged PR either way. On the real store 8 issues have two or more merged PRs
// and for #28046 the order genuinely differs (PR 28053 merged 2026-04-24, PR
// 28517 merged 2026-04-15), so dropping the sort would attribute the lead time
// to the LATER merge.
//
// #900004 lists its two merged PRs newest-merge-FIRST, so array order and merge
// order disagree. Decoded by hand from the fixture dates:
//   issue opened   2025-06-10T00:00:00Z
//   PR 900402 opened 2025-06-15T00:00:00Z, merged 2025-07-10T09:36:00Z  <- earlier
//   PR 900401 opened 2025-06-20T00:00:00Z, merged 2025-08-01T00:00:00Z  <- later
// Earlier merge: fixDays = 30.4, prDays = 25.4.
// Later merge:   fixDays = 52,   prDays = 42.
test('lead times come from the EARLIEST merged PR, not the first one listed', () => {
  const lt = leadTimes(byNumber.get(900004));
  assert.equal(round1(lt.fixDays), 30.4);
  assert.equal(round1(lt.prDays), 25.4);
  // Without the sort these would be the later merge's figures.
  assert.notEqual(round1(lt.fixDays), 52);
  assert.notEqual(round1(lt.prDays), 42);
  // The issue is still open, so it has no close lead time at all.
  assert.equal(lt.closeDays, null);
});

test('lead times are never negative', () => {
  for (const issue of byNumber.values()) {
    for (const v of Object.values(leadTimes(issue))) {
      if (v != null) assert.ok(v >= 0, `negative lead time on #${issue.number}`);
    }
  }
});
