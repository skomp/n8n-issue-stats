import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';
import { renderReport, reportPath } from '../src/lib/report.js';

const issues = readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
  .trim().split('\n').map(JSON.parse);

// See tests/rollup.test.js for why the window is 440 days here: it is the one
// that splits this fixture, so a windowed figure and an all-time figure can
// never coincide by accident.
const NOW = new Date('2026-09-06T10:00:00Z');
const WINDOW = { now: NOW, windowDays: 440 };
const WINDOW_LINE = 'Window: the 440 days since 2025-06-23.';
const r = rollup(issues, WINDOW);
const md = renderReport(r, { generatedAt: '2026-09-06T10:00:00Z' });

// Every assertion in this file must be anchored to a rendered ROW or a rendered
// NUMBER. Seven mutations — emptying three tables, hardcoding the population,
// printing coverage as 0%, dropping `unclassified`, and swapping the fix
// lead-time row for the close row — all passed a suite built on substrings,
// because the static caveat prose happens to contain the words being searched.
const section = heading => {
  const body = md.split(`\n## ${heading}\n`)[1];
  assert.ok(body, `missing section: ${heading}`);
  return body.split('\n## ')[0];
};

const rows = heading => section(heading).split('\n')
  .filter(l => l.startsWith('|') && !l.startsWith('|---') && !/^\| (Segment|Reason|Component|State|Measure|Month) /.test(l));

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
  const empty = renderReport(rollup([], WINDOW), { generatedAt: '2026-09-06T10:00:00Z' });
  assert.match(empty, /^Population: \*\*0\*\* triaged issues/m);
  assert.notEqual(md.split('\n')[2], empty.split('\n')[2]);
});

// The whole point of the windowing change: a reader must never have to guess
// which denominator a table used. Every windowed table names the window, and
// the lead-time table says it is NOT windowed.
test('every windowed table states the window it was computed over', () => {
  for (const heading of ['Intake and outcome', 'Rejection reasons', 'Component',
                         'Triage funnel', 'Monthly intake']) {
    assert.ok(section(heading).includes(WINDOW_LINE),
      `section "${heading}" does not state its window`);
  }
});

test('the lead-time section states that it is NOT windowed', () => {
  const lead = section('Lead times');
  assert.ok(!lead.includes(WINDOW_LINE), 'lead times must not claim the intake window');
  assert.match(lead, /\*\*Not windowed — all 12 issues, all history\.\*\*/);
});

test('the preamble states both denominators and the size of each', () => {
  assert.match(md, /intake sections below cover the \*\*440 days since 2025-06-23\*\* — \*\*10\*\* of the 12 triaged issues/);
  assert.match(md, /\*\*lead times cover all history\*\*, all 12 issues/);
});

// I1 / spec section 8. The report previously buried its own stated headline
// inside an unranked table.
test('the headline states the accepted to rejected ratio for the window', () => {
  assert.match(md, /In the 440 days since 2025-06-23: \*\*8 accepted\*\* to \*\*2 rejected\*\*/);
  assert.match(md, /ratio of \*\*4\.00\*\* accepted issues per rejected issue, out of 10 issues created in the window/);
});

// The near-identical rate across two very different denominators is the
// finding, so both figures are published, never just the flattering one.
test('the headline states the should-not-have-been-filed count for BOTH populations', () => {
  assert.match(md, /\*\*1\*\* issue \(\*\*10%\*\* of 10\) should never have been filed as a bug/);
  assert.match(md, /Over all history the figure is \*\*1\*\* of 12 \(\*\*8%\*\*\)/);
});

test('the headline appears before the intake table, not after it', () => {
  assert.ok(md.indexOf('\n## Headline\n') < md.indexOf('\n## Intake and outcome\n'));
});

test('intake rows carry their counts and shares of the windowed population', () => {
  assert.match(md, /^\| Accepted \| 8 \| 80% \|$/m);
  assert.match(md, /^\| Rejected at triage \| 2 \| 20% \|$/m);
  assert.equal(rows('Intake and outcome').length, 2);
  assert.match(md, /Denominator: the \*\*10\*\* issues created in the window\./);
});

// C2: this table was emptied by a mutation and the suite stayed green.
test('rejection reasons render one row per reason', () => {
  assert.match(md, /^\| closed:incomplete-template \| 1 \| 50% \|$/m);
  assert.match(md, /^\| closed:enhancement\/feature \| 1 \| 50% \|$/m);
  assert.equal(rows('Rejection reasons').length, 2);
});

// I2 / spec section 8: "always print the denominator".
test('the rejection-reasons table prints its denominator', () => {
  assert.match(md, /Denominator: the \*\*2\*\* issues rejected in the window\./);
});

// C2: `md.includes('unclassified')` was satisfied by the caveat prose, so the
// test named "unclassified is shown" passed with the ROW deleted.
test('unclassified is shown as a table row, never silently dropped', () => {
  assert.match(md, /^\| unclassified \| 3 \|$/m);
});

// #16038 (team:nodes) and #16207 (team:payday) fall outside the window, so
// their component rows must be absent — not merely smaller.
test('component rows carry their actual counts and exclude out-of-window issues', () => {
  assert.match(md, /^\| packages\/nodes-base \| 3 \|$/m);
  assert.match(md, /^\| packages\/@n8n\/db \| 1 \|$/m);
  assert.match(md, /^\| packages\/@n8n\/nodes-langchain \| 1 \|$/m);
  assert.equal(rows('Component').length, 4);
  assert.doesNotMatch(md, /^\| nodes \| 1 \|$/m);
  assert.doesNotMatch(md, /^\| payday \| 1 \|$/m);
});

test('component coverage is printed as its actual percentage', () => {
  assert.match(md, /Component coverage: \*\*63%\*\* of 8 accepted issues\./);
});

// C2 + I2: emptying the funnel passed, and it rendered 8 of 12 issues with
// nothing telling the reader the other 4 carry no triage:* label.
test('triage funnel renders one row per state', () => {
  assert.match(md, /^\| triage:pending \| 5 \| 50% \|$/m);
  assert.match(md, /^\| triage:complete \| 2 \| 20% \|$/m);
  assert.match(md, /^\| triage:needs-info \| 1 \| 10% \|$/m);
  assert.equal(rows('Triage funnel').length, 3);
});

test('the triage funnel prints its denominator and its uncovered remainder', () => {
  assert.match(md, /Denominator: the \*\*10\*\* issues created in the window\. 8 carry a `triage:\*` label and appear above; the other 2 carry none/);
});

// C2: swapping the fix row for the close row passed 42/42 and published the
// wrong statistic under the right label. `n` is also the guard against the
// lead times being silently windowed: all three counts are over all history.
test('each lead-time row carries its own median, p90 and n', () => {
  assert.match(md, /^\| Issue opened → closed \| 5 \| 35\.5 \| 12 \|$/m);
  assert.match(md, /^\| Issue opened → fix merged \| 12 \| 114\.8 \| 6 \|$/m);
  assert.match(md, /^\| Fix PR opened → merged \| 5\.1 \| 87 \| 6 \|$/m);
});

// C2 + I2 + I4: emptying this table passed, and a transposed accepted/rejected
// pair renders as a different row.
test('monthly intake renders every windowed month the right way round', () => {
  assert.match(md, /^\| 2025-07 \| 1 \| 2 \| 3 \| 30% \|$/m);
  assert.match(md, /^\| 2025-10 \| 2 \| 0 \| 2 \| 20% \|$/m);
  assert.match(md, /^\| 2025-11 \| 3 \| 0 \| 3 \| 30% \|$/m);
  assert.equal(rows('Monthly intake').length, 5);
  assert.doesNotMatch(md, /^\| 2025-06 \|/m, 'June 2025 is outside the window');
});

test('the monthly-intake table prints its denominator', () => {
  assert.match(md, /Denominator: the \*\*10\*\* issues created in the window, keyed by the month the issue was opened\./);
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
  assert.equal(md, renderReport(rollup(issues, WINDOW), { generatedAt: '2026-09-06T10:00:00Z' }));
});
