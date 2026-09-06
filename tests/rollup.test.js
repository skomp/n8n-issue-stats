import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);
const round1 = n => n == null ? null : Math.round(n * 10) / 10;

// The fixture's records run from 2025-06-05 to 2026-03-01. A 440-day window
// ending 2026-09-06 opens on 2025-06-23, which SPLITS the fixture: the two
// June 2025 records (#16038, #16207) fall outside it and the other eleven inside.
// The split is deliberate — it is what stops a windowed count and an all-time
// count from being equal by accident, which is how a dropped window would
// otherwise pass unnoticed.
const NOW = new Date('2026-09-06T10:00:00Z');
const WINDOW = { now: NOW, windowDays: 440 };
const r = rollup(issues, WINDOW);

// The fixture holds 10 real records plus the synthetic 900001, 900002, 900003.
test('total is the FULL population, the window is reported beside it', () => {
  assert.equal(r.total, 13);
  assert.deepEqual(r.window, {
    since: '2025-06-23T10:00:00.000Z',
    days: 440,
    population: 11,
  });
  assert.ok(r.window.population < r.total, 'the window must actually exclude records');
});

test('segments partition the WINDOWED population exactly', () => {
  assert.equal(r.segments.accepted, 9);
  assert.equal(r.segments.rejected, 2);
  assert.equal(r.segments.accepted + r.segments.rejected, r.window.population);
});

// The two records outside the window are #16038 (team:nodes) and #16207
// (team:payday), so their components must be absent, not merely smaller.
test('component counts cover the windowed accepted segment and nothing else', () => {
  const summed = Object.values(r.components).reduce((a, b) => a + b, 0);
  assert.equal(summed, r.segments.accepted);
  assert.deepEqual(r.components, {
    'packages/@n8n/db': 1,
    'packages/@n8n/nodes-langchain': 1,
    'packages/nodes-base': 3,
    'unclassified': 4,
  });
  assert.ok(!('nodes' in r.components), '#16038 is outside the window');
  assert.ok(!('payday' in r.components), '#16207 is outside the window');
});

test('coverage excludes unclassified and is a real fraction of the window', () => {
  assert.equal(r.componentCoverage, 5 / 9);
});

test('rejection reasons are counted from closed:* labels', () => {
  assert.deepEqual(r.rejectionReasons, {
    'closed:incomplete-template': 1,
    'closed:enhancement/feature': 1,
  });
});

// I1 / spec section 8. This is the report's stated headline. On the full
// 5,464-record store it measures 2,336 issues, 43% of the population, against
// 722 of 1,736 (42%) in the 180-day window — the near-identical rate across
// two very different denominators is itself the finding, so the rollup carries
// both figures and the report prints both.
test('the headline counts windowed and all-time issues that should never have been filed', () => {
  assert.equal(r.headline.shouldNotHaveBeenFiled, 1);
  assert.equal(r.headline.shareOfPopulation, 1 / 11);
  assert.equal(r.headline.allTime.shouldNotHaveBeenFiled, 1);
  assert.equal(r.headline.allTime.shareOfPopulation, 1 / 13);
  assert.notEqual(r.headline.shareOfPopulation, r.headline.allTime.shareOfPopulation);
});

test('an issue carrying two of the three reasons is counted once', () => {
  const twice = rollup([{
    number: 1,
    createdAt: '2026-01-01T00:00:00Z',
    labels: { nodes: [{ name: 'closed:support-issue' }, { name: 'closed:non-english' }] },
  }], WINDOW);
  assert.equal(twice.headline.shouldNotHaveBeenFiled, 1);
  assert.equal(twice.headline.shareOfPopulation, 1);
  assert.equal(twice.headline.allTime.shouldNotHaveBeenFiled, 1);
});

test('closed:enhancement-feature is a rejection but not a headline reason', () => {
  // #16971 is rejected as closed:enhancement/feature. A feature request filed
  // as an issue is a legitimate filing; it must not inflate the headline.
  const one = rollup([issues.find(i => i.number === 16971)], WINDOW);
  assert.equal(one.segments.rejected, 1);
  assert.equal(one.headline.shouldNotHaveBeenFiled, 0);
});

// I4: deleting the triage: bump entirely left the suite green, despite
// triageStates being a mandated Rollup field rendered as a whole report section.
test('triage states are counted from triage:* labels', () => {
  assert.deepEqual(r.triageStates, {
    'triage:pending': 6,
    'triage:complete': 2,
    'triage:needs-info': 2,
  });
});

// C3: the funnel denominator was derived by SUMMING triageStates, which is a
// count of LABELS, not of issues. On the real store that is 1,546 labels
// across 1,309 issues -- 237 issues carry more than one -- so the report
// published "1546 carry a triage label ... the other 3918 carry none" against
// a truth of 1,309 and 4,155. No fixture record carried two triage:* labels,
// so sum(labels) === count(issues) held there by accident and the test could
// not fail. #900003 exists to break that coincidence: assert the two counts
// DIFFER, so collapsing them back into one is caught here.
test('triagedIssues counts issues while triageStates counts labels, and they differ', () => {
  const labels = Object.values(r.triageStates).reduce((a, b) => a + b, 0);
  assert.equal(labels, 10, 'ten triage:* labels are present in the window');
  assert.equal(r.triagedIssues, 9, 'across nine issues -- #900003 carries two');
  assert.notEqual(r.triagedIssues, labels);
});

test('two windowed fixtures carry no triage label at all', () => {
  // The funnel therefore covers 9 of the window's 11. See report.test.js.
  assert.equal(r.triagedIssues, 9);
  assert.ok(r.triagedIssues < r.window.population);
  assert.equal(r.window.population - r.triagedIssues, 2);
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

// The load-bearing half of the windowing split. Windowing the lead times would
// understate the median fix time by 2x on the real store (25.3 days over all
// history, 12.7 days windowed) through truncation bias. `close.n` counts every
// closed issue in the store, so it must stay at the ALL-TIME figure even
// though the window admits only 11 of the 13 records.
test('lead times cover all history, never the window', () => {
  assert.equal(r.leadTimes.close.n, 12);
  assert.ok(r.leadTimes.close.n > r.window.population);

  // Narrowing the window must not move a single lead-time number.
  const narrow = rollup(issues, { now: NOW, windowDays: 30 });
  assert.equal(narrow.window.population, 0);
  assert.deepEqual(narrow.leadTimes, r.leadTimes);
});

// I4: the old test asserted only the SUM of accepted and rejected, which is
// invariant under transposing them. Assert each month by value.
test('months are keyed YYYY-MM with accepted and rejected the right way round', () => {
  assert.deepEqual(r.byMonth, {
    '2025-07': { accepted: 1, rejected: 2 },
    '2025-10': { accepted: 2, rejected: 0 },
    '2025-11': { accepted: 3, rejected: 0 },
    '2026-01': { accepted: 1, rejected: 0 },
    '2026-02': { accepted: 1, rejected: 0 },
    '2026-03': { accepted: 1, rejected: 0 },
  });
  assert.ok(!('2025-06' in r.byMonth), 'June 2025 is outside the window');
});

test('rollup(issues) with no options defaults to a 180-day window ending now', () => {
  const before = Date.now();
  const d = rollup(issues);
  const after = Date.now();

  assert.equal(d.window.days, 180);
  const since = Date.parse(d.window.since);
  const day = 86_400_000;
  assert.ok(since >= before - 180 * day && since <= after - 180 * day,
    `since ${d.window.since} is not 180 days before now`);

  // Defaults change the window, never the full population or the lead times.
  assert.equal(d.total, 13);
  assert.equal(d.leadTimes.close.n, 12);
});

test('an empty population does not throw', () => {
  const empty = rollup([], WINDOW);
  assert.equal(empty.total, 0);
  assert.equal(empty.window.population, 0);
  assert.equal(empty.leadTimes.fix.median, null);
  assert.equal(empty.componentCoverage, 0);
  assert.deepEqual(empty.headline, {
    shouldNotHaveBeenFiled: 0,
    shareOfPopulation: 0,
    allTime: { shouldNotHaveBeenFiled: 0, shareOfPopulation: 0 },
  });
  assert.deepEqual(empty.triageStates, {});
  assert.equal(empty.triagedIssues, 0);
  assert.deepEqual(empty.byMonth, {});
});
