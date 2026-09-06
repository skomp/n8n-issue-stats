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
