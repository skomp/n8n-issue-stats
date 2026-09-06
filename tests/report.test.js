import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';
import { renderReport, reportPath } from '../src/lib/report.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);
const md = renderReport(rollup(issues), { generatedAt: '2026-09-06T10:00:00Z' });

// Every assertion in this file must be anchored to a rendered ROW or a rendered
// NUMBER. Seven mutations — emptying three tables, hardcoding the population,
// printing coverage as 0%, dropping `unclassified`, and swapping the fix
// lead-time row for the close row — all passed a suite built on substrings,
// because the static caveat prose happens to contain the words being searched.
const rows = heading => {
  const body = md.split(`\n## ${heading}\n`)[1];
  assert.ok(body, `missing section: ${heading}`);
  return body.split('\n## ')[0].split('\n')
    .filter(l => l.startsWith('|') && !l.startsWith('|---') && !/^\| (Segment|Reason|Component|State|Measure|Month) /.test(l));
};

test('path is dated and stable', () => {
  assert.equal(reportPath(new Date('2026-09-06T10:00:00Z')), 'reports/2026-09-06-triage.md');
});

test('every required section is present as a heading, not as prose', () => {
  for (const heading of ['Headline', 'Intake and outcome', 'Rejection reasons', 'Component',
                         'Triage funnel', 'Lead times', 'Monthly intake', 'Coverage and caveats']) {
    assert.match(md, new RegExp(`^## ${heading}$`, 'm'), `missing section: ${heading}`);
  }
});

// I3: the old assertion was `md.includes('10')`, which matched the T10:00:00Z
// in generatedAt. A report rendered from rollup([]) satisfied it.
test('the population is printed as its actual count', () => {
  assert.match(md, /^Population: \*\*12\*\* triaged issues/m);
  const empty = renderReport(rollup([]), { generatedAt: '2026-09-06T10:00:00Z' });
  assert.match(empty, /^Population: \*\*0\*\* triaged issues/m);
  assert.notEqual(md.split('\n')[2], empty.split('\n')[2]);
});

// I1 / spec section 8. The report previously buried its own stated headline
// inside an unranked table.
test('the headline states the accepted to rejected ratio', () => {
  assert.match(md, /\*\*10 accepted\*\* to \*\*2 rejected\*\*/);
  assert.match(md, /ratio of \*\*5\.00\*\* accepted issues per rejected issue/);
});

test('the headline states the should-not-have-been-filed count and its share', () => {
  assert.match(md, /\*\*1\*\* issue \(\*\*8%\*\* of 12\) should never have been filed as a bug/);
});

test('the headline appears before the intake table, not after it', () => {
  assert.ok(md.indexOf('\n## Headline\n') < md.indexOf('\n## Intake and outcome\n'));
});

test('intake rows carry their counts and shares', () => {
  assert.match(md, /^\| Accepted \| 10 \| 83% \|$/m);
  assert.match(md, /^\| Rejected at triage \| 2 \| 17% \|$/m);
  assert.equal(rows('Intake and outcome').length, 2);
});

// C2: this table was emptied by a mutation and the suite stayed green.
test('rejection reasons render one row per reason', () => {
  assert.match(md, /^\| closed:incomplete-template \| 1 \| 50% \|$/m);
  assert.match(md, /^\| closed:enhancement\/feature \| 1 \| 50% \|$/m);
  assert.equal(rows('Rejection reasons').length, 2);
});

// I2 / spec section 8: "always print the denominator".
test('the rejection-reasons table prints its denominator', () => {
  assert.match(md, /Denominator: all \*\*2\*\* rejected issues\./);
});

// C2: `md.includes('unclassified')` was satisfied by the caveat prose, so the
// test named "unclassified is shown" passed with the ROW deleted.
test('unclassified is shown as a table row, never silently dropped', () => {
  assert.match(md, /^\| unclassified \| 3 \|$/m);
});

test('component rows carry their actual counts', () => {
  assert.match(md, /^\| packages\/nodes-base \| 3 \|$/m);
  assert.match(md, /^\| packages\/@n8n\/db \| 1 \|$/m);
  assert.match(md, /^\| packages\/@n8n\/nodes-langchain \| 1 \|$/m);
  assert.match(md, /^\| nodes \| 1 \|$/m);
  assert.match(md, /^\| payday \| 1 \|$/m);
  assert.equal(rows('Component').length, 6);
});

test('component coverage is printed as its actual percentage', () => {
  assert.match(md, /Component coverage: \*\*70%\*\* of 10 accepted issues\./);
});

// C2 + I2: emptying the funnel passed, and it rendered 8 of 12 issues with
// nothing telling the reader the other 4 carry no triage:* label.
test('triage funnel renders one row per state', () => {
  assert.match(md, /^\| triage:pending \| 5 \| 42% \|$/m);
  assert.match(md, /^\| triage:complete \| 2 \| 17% \|$/m);
  assert.match(md, /^\| triage:needs-info \| 1 \| 8% \|$/m);
  assert.equal(rows('Triage funnel').length, 3);
});

test('the triage funnel prints its denominator and its uncovered remainder', () => {
  assert.match(md, /Denominator: all \*\*12\*\* triaged issues\. 8 carry a `triage:\*` label and appear above; the other 4 carry none/);
});

// C2: swapping the fix row for the close row passed 42/42 and published the
// wrong statistic under the right label.
test('each lead-time row carries its own median, p90 and n', () => {
  assert.match(md, /^\| Issue opened → closed \| 5 \| 35\.5 \| 12 \|$/m);
  assert.match(md, /^\| Issue opened → fix merged \| 12 \| 114\.8 \| 6 \|$/m);
  assert.match(md, /^\| Fix PR opened → merged \| 5\.1 \| 87 \| 6 \|$/m);
});

// C2 + I2 + I4: emptying this table passed, and a transposed accepted/rejected
// pair renders as a different row.
test('monthly intake renders every month the right way round', () => {
  assert.match(md, /^\| 2025-06 \| 2 \| 0 \| 2 \| 17% \|$/m);
  assert.match(md, /^\| 2025-07 \| 1 \| 2 \| 3 \| 25% \|$/m);
  assert.match(md, /^\| 2025-11 \| 3 \| 0 \| 3 \| 25% \|$/m);
  assert.equal(rows('Monthly intake').length, 6);
});

test('the monthly-intake table prints its denominator', () => {
  assert.match(md, /Denominator: all \*\*12\*\* triaged issues, keyed by the month the issue was opened\./);
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
  assert.match(md, /moves accepted issues into \*\*Linear\*\*/);
});

test('rendering is deterministic for a fixed input', () => {
  assert.equal(md, renderReport(rollup(issues), { generatedAt: '2026-09-06T10:00:00Z' }));
});
