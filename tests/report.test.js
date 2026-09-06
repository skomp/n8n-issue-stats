import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rollup } from '../src/lib/rollup.js';
import {
  renderReport, renderHtml, reportPath, reportHtmlPath,
  escapeHtml, INDEX_PATH, ARCHIVE_URL, CAVEAT_COUNT,
} from '../src/lib/report.js';

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
  assert.match(md, /^Population: \*\*13\*\* triaged issues/m);
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
  assert.match(lead, /\*\*Not windowed — all 13 issues, all history\.\*\*/);
});

test('the preamble states both denominators and the size of each', () => {
  assert.match(md, /intake sections below cover the \*\*440 days since 2025-06-23\*\* — \*\*11\*\* of the 13 triaged issues/);
  assert.match(md, /\*\*lead times cover all history\*\*, all 13 issues/);
});

// I1 / spec section 8. The report previously buried its own stated headline
// inside an unranked table.
test('the headline states the accepted to rejected ratio for the window', () => {
  assert.match(md, /In the 440 days since 2025-06-23: \*\*9 accepted\*\* to \*\*2 rejected\*\*/);
  assert.match(md, /ratio of \*\*4\.50\*\* accepted issues per rejected issue, out of 11 issues created in the window/);
});

// The near-identical rate across two very different denominators is the
// finding, so both figures are published, never just the flattering one.
test('the headline states the should-not-have-been-filed count for BOTH populations', () => {
  assert.match(md, /\*\*1\*\* issue \(\*\*9%\*\* of 11\) should never have been filed as a bug/);
  assert.match(md, /Over all history the figure is \*\*1\*\* of 13 \(\*\*8%\*\*\)/);
});

test('the headline appears before the intake table, not after it', () => {
  assert.ok(md.indexOf('\n## Headline\n') < md.indexOf('\n## Intake and outcome\n'));
});

test('intake rows carry their counts and shares of the windowed population', () => {
  assert.match(md, /^\| Accepted \| 9 \| 82% \|$/m);
  assert.match(md, /^\| Rejected at triage \| 2 \| 18% \|$/m);
  assert.equal(rows('Intake and outcome').length, 2);
  assert.match(md, /Denominator: the \*\*11\*\* issues created in the window\./);
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
  assert.match(md, /^\| unclassified \| 4 \|$/m);
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
  assert.match(md, /Component coverage: \*\*56%\*\* of 9 accepted issues\./);
});

// C2 + I2: emptying the funnel passed, and it rendered its rows with nothing
// telling the reader how many issues carry no triage:* label at all.
test('triage funnel renders one row per state', () => {
  assert.match(md, /^\| triage:pending \| 6 \| 55% \|$/m);
  assert.match(md, /^\| triage:complete \| 2 \| 18% \|$/m);
  assert.match(md, /^\| triage:needs-info \| 2 \| 18% \|$/m);
  assert.equal(rows('Triage funnel').length, 3);
});

// C3: the denominator sentence counted LABELS, not issues. #900003 carries two
// triage:* labels, so the two counts differ here: 10 labels across 9 issues.
// Publishing the label sum would read "10 carry a triage:* label ... the other
// 1 carry none" against a truth of 9 and 2.
test('the triage funnel counts ISSUES in its denominator sentence, never labels', () => {
  assert.match(md, /Denominator: the \*\*11\*\* issues created in the window\. 9 carry a `triage:\*` label and appear above; the other 2 carry none/);
  assert.doesNotMatch(md, /10 carry a `triage:\*` label/, 'that is the label count, not the issue count');
  assert.doesNotMatch(md, /the other 1 carry none/);
});

test('the triage funnel says its rows are labels, so they need not sum', () => {
  assert.match(md, /The rows count labels, not issues: an issue carrying two `triage:\*` labels appears in two rows, so the counts need not sum to 9/);
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
  assert.match(md, /^\| 2025-07 \| 1 \| 2 \| 3 \| 27% \|$/m);
  assert.match(md, /^\| 2025-10 \| 2 \| 0 \| 2 \| 18% \|$/m);
  assert.match(md, /^\| 2025-11 \| 3 \| 0 \| 3 \| 27% \|$/m);
  assert.match(md, /^\| 2026-03 \| 1 \| 0 \| 1 \| 9% \|$/m);
  assert.equal(rows('Monthly intake').length, 6);
  assert.doesNotMatch(md, /^\| 2025-06 \|/m, 'June 2025 is outside the window');
});

test('the monthly-intake table prints its denominator', () => {
  assert.match(md, /Denominator: the \*\*11\*\* issues created in the window, keyed by the month the issue was opened\./);
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

// ---------------------------------------------------------------------------
// The HTML report
// ---------------------------------------------------------------------------
//
// An HTML renderer is exceptionally easy to test uselessly: `html.includes(
// '<table>')` passes against a page whose every cell is empty, and
// `includes('5464')` passes against a page that prints the number once in a
// caption and nowhere in the data. So every assertion below is anchored to a
// COMPLETE rendered row, a specific cell, or a decoded value — the same rule
// the markdown tests above follow.

const html = renderHtml(r, { generatedAt: '2026-09-06T10:00:00Z' });

// The <style> block, isolated. Several tests reason about the CSS alone.
const styleBlock = html.split('<style>')[1].split('</style>')[0];
// Everything except the CSS, for tests that must not be satisfied by a colour
// or a property name that happens to appear in the stylesheet.
const htmlBody = html.split('</style>')[1];

const htmlSection = heading => {
  const body = html.split(`<h2>${heading}</h2>`)[1];
  assert.ok(body, `missing HTML section: ${heading}`);
  return body.split('<h2>')[0];
};

test('the HTML path is dated, and sits beside the markdown', () => {
  assert.equal(reportHtmlPath(new Date('2026-09-06T10:00:00Z')), 'reports/2026-09-06-triage.html');
  assert.equal(INDEX_PATH, 'index.html');
});

test('the HTML is a complete document with a title naming the report date', () => {
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>n8n triage report — 2026-09-06<\/title>/);
  assert.match(html, /<\/html>\n$/);
});

// --- The numbers, cell by cell ----------------------------------------------

test('the HTML prints the population and the window population as figures', () => {
  assert.match(html, /<span class="figure"><strong>13<\/strong><\/span> triaged issues from <code>n8n-io\/n8n<\/code>/);
  // Emptying the store must change the rendered page, not just the title.
  const empty = renderHtml(rollup([], WINDOW), { generatedAt: '2026-09-06T10:00:00Z' });
  assert.match(empty, /<span class="figure"><strong>0<\/strong><\/span> triaged issues/);
  assert.notEqual(html, empty);
});

test('the HTML carries the two-population explanation with both denominators', () => {
  assert.match(html, /<strong>This report uses two denominators, deliberately\.<\/strong>/);
  assert.match(html, /cover the <strong>440 days since 2025-06-23<\/strong> — <strong>11<\/strong> of the 13 triaged issues/);
  assert.match(html, /<strong>lead times cover all history<\/strong>, all 13 issues/);
});

test('the HTML headline states the ratio and both should-not-have-been-filed figures', () => {
  const headline = htmlSection('Headline');
  assert.match(headline, /In the 440 days since 2025-06-23: <strong>9 accepted<\/strong> to <strong>2 rejected<\/strong>/);
  assert.match(headline, /ratio of <strong>4\.50<\/strong> accepted issues per rejected issue, out of 11 issues created in the window/);
  assert.match(headline, /<strong>1<\/strong> issue \(<strong>9%<\/strong> of 11\) should never have been filed/);
  assert.match(headline, /Over all history the figure is <strong>1<\/strong> of 13 \(<strong>8%<\/strong>\)/);
});

test('HTML intake rows carry their counts and shares in the right cells', () => {
  assert.match(html, /<tr><td>Accepted<\/td><td class="num">9<\/td><td class="num">82%<\/td><\/tr>/);
  assert.match(html, /<tr><td>Rejected at triage<\/td><td class="num">2<\/td><td class="num">18%<\/td><\/tr>/);
  assert.match(htmlSection('Intake and outcome'), /Denominator: the <strong>11<\/strong> issues created in the window\./);
});

test('HTML rejection reasons render one row per reason, with the denominator', () => {
  const reasons = htmlSection('Rejection reasons');
  assert.match(reasons, /<tr><td>closed:incomplete-template<\/td><td class="num">1<\/td><td class="num">50%<\/td><\/tr>/);
  assert.match(reasons, /<tr><td>closed:enhancement\/feature<\/td><td class="num">1<\/td><td class="num">50%<\/td><\/tr>/);
  assert.equal([...reasons.matchAll(/<tr><td>/g)].length, 2);
  assert.match(reasons, /Denominator: the <strong>2<\/strong> issues rejected in the window\./);
});

test('HTML component rows carry their counts, including unclassified', () => {
  const component = htmlSection('Component');
  assert.match(component, /<tr><td>unclassified<\/td><td class="num">4<\/td><\/tr>/);
  assert.match(component, /<tr><td>packages\/nodes-base<\/td><td class="num">3<\/td><\/tr>/);
  assert.match(component, /<tr><td>packages\/@n8n\/db<\/td><td class="num">1<\/td><\/tr>/);
  assert.equal([...component.matchAll(/<tr><td>/g)].length, 4);
  assert.match(component, /Component coverage: <strong>56%<\/strong> of 9 accepted issues\./);
});

test('the HTML triage funnel counts ISSUES in its denominator sentence, never labels', () => {
  const funnel = htmlSection('Triage funnel');
  assert.match(funnel, /<tr><td>triage:pending<\/td><td class="num">6<\/td><td class="num">55%<\/td><\/tr>/);
  assert.equal([...funnel.matchAll(/<tr><td>/g)].length, 3);
  assert.match(funnel, /the <strong>11<\/strong> issues created in the window\. 9 carry a <code>triage:\*<\/code> label and appear above; the other 2 carry none/);
  assert.doesNotMatch(funnel, /10 carry a <code>triage:\*<\/code> label/, 'that is the label count, not the issue count');
});

test('each HTML lead-time row carries its own median, p90 and n', () => {
  // Swapping the fix row for the close row publishes the wrong statistic under
  // the right label, and every "contains a number" test stays green.
  const lead = htmlSection('Lead times');
  assert.match(lead, /<tr><td>Issue opened → closed<\/td><td class="num">5<\/td><td class="num">35\.5<\/td><td class="num">12<\/td><\/tr>/);
  assert.match(lead, /<tr><td>Issue opened → fix merged<\/td><td class="num">12<\/td><td class="num">114\.8<\/td><td class="num">6<\/td><\/tr>/);
  assert.match(lead, /<tr><td>Fix PR opened → merged<\/td><td class="num">5\.1<\/td><td class="num">87<\/td><td class="num">6<\/td><\/tr>/);
  assert.match(lead, /<strong>Not windowed — all 13 issues, all history\.<\/strong>/);
});

test('HTML monthly intake renders every windowed month the right way round', () => {
  const monthly = htmlSection('Monthly intake');
  assert.match(monthly, /<tr><td>2025-07<\/td><td class="num">1<\/td><td class="num">2<\/td><td class="num">3<\/td><td class="num">27%<\/td><\/tr>/);
  assert.match(monthly, /<tr><td>2025-11<\/td><td class="num">3<\/td><td class="num">0<\/td><td class="num">3<\/td><td class="num">27%<\/td><\/tr>/);
  assert.equal([...monthly.matchAll(/<tr><td>/g)].length, 6);
  assert.doesNotMatch(monthly, /<tr><td>2025-06</, 'June 2025 is outside the window');
  assert.match(monthly, /the <strong>11<\/strong> issues created in the window, keyed by the month the issue was opened\./);
});

test('every windowed HTML section states the window it was computed over', () => {
  for (const heading of ['Intake and outcome', 'Rejection reasons', 'Component',
                         'Triage funnel', 'Monthly intake']) {
    assert.ok(htmlSection(heading).includes(WINDOW_LINE),
      `HTML section "${heading}" does not state its window`);
  }
  assert.ok(!htmlSection('Lead times').includes(WINDOW_LINE));
});

// --- Escaping ----------------------------------------------------------------

test('escapeHtml neutralises every character that can break out of markup', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  // The ampersand MUST be replaced first, or the & of &lt; is escaped again.
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml(13), '13');
});

test('a component name from a hostile GitHub label cannot inject markup', () => {
  // Component names are GitHub LABEL names: chosen outside this repo. A team
  // label named team:<script> renders as the component <script>.
  const hostile = [{
    number: 1,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    labels: { nodes: [{ name: 'team:<script>alert("xss")</script>' }, { name: 'triage:pending' }] },
  }];
  const page = renderHtml(rollup(hostile, WINDOW), { generatedAt: '2026-09-06T10:00:00Z' });

  // The name is present, escaped, in its own cell...
  assert.match(page, /<tr><td>&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;<\/td><td class="num">1<\/td><\/tr>/);
  // ...and nowhere as live markup. Only the page's own <script>-free document
  // structure remains, so a raw <script> anywhere is an injection.
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /alert\("xss"\)/, 'the raw, unescaped label leaked into the page');
});

// --- Self-contained, offline, theme-aware -----------------------------------

test('the page is self-contained: no external stylesheet, script or font', () => {
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheet — it must render from file://');
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(styleBlock, /@import/i);
  assert.doesNotMatch(styleBlock, /@font-face/i);
  assert.doesNotMatch(styleBlock, /https?:/i, 'the stylesheet must not fetch anything');
  // Exactly one inline stylesheet, and it is not empty.
  assert.equal([...html.matchAll(/<style>/g)].length, 1);
  assert.ok(styleBlock.length > 500);
  // The ONLY external reference on the page is the archive link.
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0]);
  assert.deepEqual(urls, [ARCHIVE_URL]);
});

// This test CANNOT verify that the URL resolves — it makes no network call, and
// that is exactly what made its predecessor useless. The old assertion pinned
// https://skomp.github.io/n8n-reports/reports/ as a literal and agreed with the
// code about a fact neither could check: that URL returns 404, because GitHub
// Pages generates no directory index and the workflow never writes
// reports/index.html. The URL below was checked by hand and returns 200 with a
// real dated file listing. Anyone changing it must re-check it the same way;
// a green suite here is not evidence that the link works.
test('the archive link is absolute, because the same bytes are served from two depths', () => {
  // index.html sits at the site root and the dated copy sits in reports/. A
  // relative "reports/" href resolves to reports/reports/ from the dated copy.
  assert.equal(ARCHIVE_URL, 'https://github.com/skomp/n8n-reports/tree/main/reports');
  assert.match(html, /<footer><a href="https:\/\/github\.com\/skomp\/n8n-reports\/tree\/main\/reports">Every report, by date, on GitHub<\/a>/);
  // Not the Pages directory URL, which 404s.
  assert.doesNotMatch(html, /skomp\.github\.io\/n8n-reports\/reports/);
});

test('every colour is a token defined on bare :root', () => {
  // A literal outside the token blocks is a colour that works in one theme and
  // vanishes in the other. Every hex in the stylesheet must be the VALUE of a
  // custom property.
  for (const line of styleBlock.split('\n')) {
    if (!line.includes('#')) continue;
    assert.match(line.trim(), /^--[\w-]+:\s*#[0-9a-f]{3,8};$/i,
      `colour literal outside a token definition: ${line.trim()}`);
  }

  const rootBlock = styleBlock.split(':root {')[1].split('}')[0];
  const defined = new Set([...rootBlock.matchAll(/(--[\w-]+):/g)].map(m => m[1]));
  const used = new Set([...styleBlock.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]));
  assert.ok(used.size >= 6, 'expected the palette to be used, not merely declared');
  for (const token of used) {
    assert.ok(defined.has(token), `${token} is used but never defined on bare :root`);
  }
});

test('the dark scheme redefines only tokens, and body paints an explicit background', () => {
  const dark = styleBlock.split('@media (prefers-color-scheme: dark) {')[1].split('\n}')[0];
  assert.ok(dark, 'no dark-scheme block');
  for (const line of dark.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (line === ':root {' || line === '}') continue;
    assert.match(line, /^--[\w-]+:\s*\S+;$/,
      `the dark block must redefine tokens only, found: ${line}`);
  }
  // Every token the dark block redefines must already exist in light.
  const rootBlock = styleBlock.split(':root {')[1].split('}')[0];
  const light = new Set([...rootBlock.matchAll(/(--[\w-]+):/g)].map(m => m[1]));
  for (const [, token] of dark.matchAll(/(--[\w-]+):/g)) {
    assert.ok(light.has(token), `${token} is defined only for the dark scheme`);
  }
  // The viewer paints its own ground behind a transparent body.
  assert.match(styleBlock, /body\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(styleBlock, /body\s*\{[^}]*color:\s*var\(--text\)/);
});

test('wide tables scroll inside their own container, never the page', () => {
  assert.match(styleBlock, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  // Every table is wrapped. An unwrapped one makes the whole page scroll
  // sideways on a phone.
  const tables = [...htmlBody.matchAll(/<table>/g)].length;
  const wrappers = [...htmlBody.matchAll(/<div class="table-wrap">\n<table>/g)].length;
  assert.equal(tables, 6, 'expected six tables');
  assert.equal(wrappers, tables, 'every table must sit in a .table-wrap');
});

test('columns of digits are tabular', () => {
  assert.match(styleBlock, /table\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(styleBlock, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(styleBlock, /\.num\s*\{[^}]*text-align:\s*right/);
  // The class has to be on the cells, not merely declared.
  assert.ok([...htmlBody.matchAll(/class="num"/g)].length > 20);
});

test('the page carries no emoji section markers', () => {
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});

// --- Parity with the markdown ------------------------------------------------

test('the HTML carries every caveat the markdown carries', () => {
  // Both renderings come from one CAVEATS array, so this is a guard against
  // that being unpicked rather than against a typo.
  const mdCaveats = md.split('## Coverage and caveats\n\n')[1]
    .trim().split('\n').filter(l => l.startsWith('- '));
  const htmlCaveats = [...htmlSection('Coverage and caveats').matchAll(/<li>/g)];
  assert.equal(mdCaveats.length, CAVEAT_COUNT);
  assert.equal(htmlCaveats.length, CAVEAT_COUNT,
    'the HTML dropped a caveat the markdown publishes');

  // Each caveat, identified by a phrase that appears in no other one.
  for (const phrase of ['system of record', 'different populations on purpose',
                        'Unlabelled community issues are out of scope',
                        'It is reported, not hidden',
                        'Linked-but-unmerged PRs are excluded']) {
    assert.ok(md.includes(phrase), `markdown lost: ${phrase}`);
    assert.ok(html.includes(phrase), `HTML lost: ${phrase}`);
  }
});

test('the HTML carries every section heading the markdown does', () => {
  for (const heading of ['Headline', 'Intake and outcome', 'Rejection reasons', 'Component',
                         'Triage funnel', 'Lead times', 'Monthly intake', 'Coverage and caveats']) {
    assert.ok(html.includes(`<h2>${heading}</h2>`), `missing HTML section: ${heading}`);
  }
});

test('HTML rendering is deterministic for a fixed input', () => {
  assert.equal(html, renderHtml(rollup(issues, WINDOW), { generatedAt: '2026-09-06T10:00:00Z' }));
});
