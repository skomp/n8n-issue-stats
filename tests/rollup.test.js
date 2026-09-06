import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);
const r = rollup(issues);
const round1 = n => n == null ? null : Math.round(n * 10) / 10;

// The fixture holds 10 real records plus the synthetic 900001 and 900002.
test('segments partition the population exactly', () => {
  assert.equal(r.total, 12);
  assert.equal(r.segments.accepted, 10);
  assert.equal(r.segments.rejected, 2);
  assert.equal(r.segments.accepted + r.segments.rejected, r.total);
});

test('component counts cover the accepted segment and nothing else', () => {
  const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
  assert.equal(summed, r.segments.accepted);
  assert.deepEqual(r.components, {
    'nodes': 1,
    'packages/@n8n/db': 1,
    'packages/@n8n/nodes-langchain': 1,
    'packages/nodes-base': 3,
    'payday': 1,
    'unclassified': 3,
  });
});

test('coverage excludes unclassified and is a real fraction', () => {
  assert.equal(r.componentCoverage, 7 / 10);
});

test('rejection reasons are counted from closed:* labels', () => {
  assert.deepEqual(r.rejectionReasons, {
    'closed:incomplete-template': 1,
    'closed:enhancement/feature': 1,
  });
});

// I1 / spec section 8. This is the report's stated headline. On the full
// 5,464-record store it measures 2,336 issues, 43% of the population.
test('the headline counts issues that should never have been filed', () => {
  assert.equal(r.headline.shouldNotHaveBeenFiled, 1);
  assert.equal(r.headline.shareOfPopulation, 1 / 12);
});

test('an issue carrying two of the three reasons is counted once', () => {
  const twice = rollup([{
    number: 1,
    createdAt: '2026-01-01T00:00:00Z',
    labels: { nodes: [{ name: 'closed:support-issue' }, { name: 'closed:non-english' }] },
  }]);
  assert.equal(twice.headline.shouldNotHaveBeenFiled, 1);
  assert.equal(twice.headline.shareOfPopulation, 1);
});

test('closed:enhancement-feature is a rejection but not a headline reason', () => {
  // #16971 is rejected as closed:enhancement/feature. A feature request filed
  // as an issue is a legitimate filing; it must not inflate the headline.
  const one = rollup([issues.find(i => i.number === 16971)]);
  assert.equal(one.segments.rejected, 1);
  assert.equal(one.headline.shouldNotHaveBeenFiled, 0);
});

// I4: deleting the triage: bump entirely left the suite green, despite
// triageStates being a mandated Rollup field rendered as a whole report section.
test('triage states are counted from triage:* labels', () => {
  assert.deepEqual(r.triageStates, {
    'triage:pending': 5,
    'triage:complete': 2,
    'triage:needs-info': 1,
  });
});

test('four fixtures carry no triage label at all', () => {
  // The funnel therefore covers 8 of 12. The report must say so; see report.test.js.
  const covered = Object.values(r.triageStates).reduce((a, b) => a + b, 0);
  assert.equal(covered, 8);
  assert.ok(covered < r.total);
});

// I5: `assert.ok(median > 0)` held for almost any wrong number — feeding `fix`
// from closeDays instead of fixDays published the wrong statistic and passed.
test('lead times are summarised by their actual median and p90', () => {
  assert.deepEqual(
    { median: round1(r.leadTimes.fix.median), p90: round1(r.leadTimes.fix.p90), n: r.leadTimes.fix.n },
    { median: 12, p90: 114.8, n: 6 }
  );
  assert.deepEqual(
    { median: round1(r.leadTimes.close.median), p90: round1(r.leadTimes.close.p90), n: r.leadTimes.close.n },
    { median: 5, p90: 35.5, n: 12 }
  );
  assert.deepEqual(
    { median: round1(r.leadTimes.pr.median), p90: round1(r.leadTimes.pr.p90), n: r.leadTimes.pr.n },
    { median: 5.1, p90: 87, n: 6 }
  );
});

// I4: the old test asserted only the SUM of accepted and rejected, which is
// invariant under transposing them. Assert each month by value.
test('months are keyed YYYY-MM with accepted and rejected the right way round', () => {
  assert.deepEqual(r.byMonth, {
    '2025-06': { accepted: 2, rejected: 0 },
    '2025-07': { accepted: 1, rejected: 2 },
    '2025-10': { accepted: 2, rejected: 0 },
    '2025-11': { accepted: 3, rejected: 0 },
    '2026-01': { accepted: 1, rejected: 0 },
    '2026-02': { accepted: 1, rejected: 0 },
  });
});

test('an empty population does not throw', () => {
  const empty = rollup([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.leadTimes.fix.median, null);
  assert.equal(empty.componentCoverage, 0);
  assert.deepEqual(empty.headline, { shouldNotHaveBeenFiled: 0, shareOfPopulation: 0 });
  assert.deepEqual(empty.triageStates, {});
  assert.deepEqual(empty.byMonth, {});
});
