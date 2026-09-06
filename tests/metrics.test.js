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

test('lead times are never negative', () => {
  for (const issue of byNumber.values()) {
    for (const v of Object.values(leadTimes(issue))) {
      if (v != null) assert.ok(v >= 0, `negative lead time on #${issue.number}`);
    }
  }
});
