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

// Only 5 of the 10 fixtures have a merged closing PR.
test('fix lead time is computed over merged PRs only', () => {
  assert.equal(r.leadTimes.fix.n, 5);
  assert.ok(r.leadTimes.fix.median > 0);
  assert.ok(r.leadTimes.fix.p90 >= r.leadTimes.fix.median);
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
