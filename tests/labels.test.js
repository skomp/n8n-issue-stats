import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIAGE_LABELS, TEAM_LABELS, CLOSED_LABELS, ALL_FILTER_LABELS,
         SHOULD_NOT_HAVE_BEEN_FILED } from '../src/lib/labels.js';

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

// The report headline is counted from these three reasons; see rollup.js.
test('the headline reasons are a named subset of the closed labels', () => {
  assert.equal(SHOULD_NOT_HAVE_BEEN_FILED.length, 3);
  assert.deepEqual(SHOULD_NOT_HAVE_BEEN_FILED,
    ['closed:incomplete-template', 'closed:support-issue', 'closed:non-english']);
  assert.ok(SHOULD_NOT_HAVE_BEEN_FILED.every(l => CLOSED_LABELS.includes(l)));
  // closed:enhancement/feature is a rejection but a legitimate filing.
  assert.ok(!SHOULD_NOT_HAVE_BEEN_FILED.includes('closed:enhancement/feature'));
});
