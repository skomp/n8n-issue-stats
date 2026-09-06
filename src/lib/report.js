const pct = (n, d) => d === 0 ? '0%' : `${Math.round(n / d * 100)}%`;
const num = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();

const table = (header, rows) =>
  [`| ${header.join(' | ')} |`,
   `|${header.map(() => '---').join('|')}|`,
   ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

const sortedEntries = obj => Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export function reportPath(date) {
  return `reports/${date.toISOString().slice(0, 10)}-triage.md`;
}

export function reportHtmlPath(date) {
  return `reports/${date.toISOString().slice(0, 10)}-triage.html`;
}

// The published copy of the latest HTML report. Overwritten every run, unlike
// the dated paths above — which is why its write needs a blob sha and theirs
// do not. See planIndexWrite() in build/build-workflows.js.
export const INDEX_PATH = 'index.html';

// The archive link is ABSOLUTE on purpose. The identical bytes are published
// to two different directory depths — reports/YYYY-MM-DD-triage.html and the
// site root as index.html — so a relative "reports/" href would resolve to
// reports/reports/ from the dated copy. A root-relative "/reports/" is wrong
// too: this is a project Pages site, served under /n8n-reports/.
export const ARCHIVE_URL = 'https://skomp.github.io/n8n-reports/reports/';

// The accepted:rejected ratio, expressed as accepted issues per rejected issue.
// Undefined when nothing was rejected, which prints as an em dash.
const ratio = (a, b) => b === 0 ? '—' : (a / b).toFixed(2);

// ---------------------------------------------------------------------------
// The caveats, rendered twice from ONE list
// ---------------------------------------------------------------------------
//
// The markdown and the HTML report are two renderings of the same numbers, and
// the caveats are the part a reader is most likely to need and least likely to
// miss if it silently disappears. Both renderers iterate THIS array, so an HTML
// build cannot quietly carry fewer caveats than the markdown: adding one means
// adding both renderings, side by side, in one place. tests/report.test.js
// asserts the two renderings stay the same length.
const CAVEATS = [
  {
    md: 'This measures **intake and triage, not delivery.** n8n moves accepted issues into **Linear**, at which point GitHub stops being the system of record. Do not read this as engineering throughput.',
    html: 'This measures <strong>intake and triage, not delivery.</strong> n8n moves accepted issues into <strong>Linear</strong>, at which point GitHub stops being the system of record. Do not read this as engineering throughput.',
  },
  {
    md: 'The intake sections and the lead times use **different populations on purpose.** Intake is a question about the recent past, so it is windowed; a lead time windowed by creation date is truncated, so it is not. Comparing a windowed count against an all-time one is a mistake the section notes exist to prevent.',
    html: 'The intake sections and the lead times use <strong>different populations on purpose.</strong> Intake is a question about the recent past, so it is windowed; a lead time windowed by creation date is truncated, so it is not. Comparing a windowed count against an all-time one is a mistake the section notes exist to prevent.',
  },
  {
    md: 'Only issues carrying one of 33 `triage:*`, `team:*` or `closed:*` labels are included. Unlabelled community issues are out of scope.',
    html: 'Only issues carrying one of 33 <code>triage:*</code>, <code>team:*</code> or <code>closed:*</code> labels are included. Unlabelled community issues are out of scope.',
  },
  {
    md: '`unclassified` counts accepted issues with no team label and no merged fix PR to derive a component from. It is reported, not hidden.',
    html: '<code>unclassified</code> counts accepted issues with no team label and no merged fix PR to derive a component from. It is reported, not hidden.',
  },
  {
    md: 'Fix lead time is computed only where a linked PR was actually **merged**. Linked-but-unmerged PRs are excluded.',
    html: 'Fix lead time is computed only where a linked PR was actually <strong>merged</strong>. Linked-but-unmerged PRs are excluded.',
  },
];

export const CAVEAT_COUNT = CAVEATS.length;

// This report publishes TWO denominators and must never let a reader guess
// which one a table used — see the comment at the top of src/lib/rollup.js for
// why the split exists. Every windowed table repeats `windowLine` verbatim;
// the lead-time table says plainly that it is not windowed. Do not collapse
// these into a single note at the top: a table read on its own would then
// carry no denominator at all.
export function renderReport(r, { generatedAt }) {
  const { total, segments: s, window: w } = r;
  const lt = r.leadTimes;
  const h = r.headline;
  // NOT Object.values(r.triageStates).reduce(...) — that sums LABELS, and an
  // issue may carry more than one triage:* label (237 of 1,309 do on the real
  // store). The funnel denominator sentence is about ISSUES, so it must use
  // the per-issue count. See src/lib/rollup.js.
  const triaged = r.triagedIssues;
  const since = w.since.slice(0, 10);
  const windowLine = `Window: the ${w.days} days since ${since}.`;

  return `# n8n triage report — ${generatedAt.slice(0, 10)}

Population: **${total}** triaged issues from \`n8n-io/n8n\`.
Generated ${generatedAt}.

**This report uses two denominators, deliberately.** The intake sections below cover the **${w.days} days since ${since}** — **${w.population}** of the ${total} triaged issues in the store, by issue creation date. The **lead times cover all history**, all ${total} issues: windowing a duration by the date the issue was created truncates the slow tail and understates the median by about 2x.

## Headline

- In the ${w.days} days since ${since}: **${s.accepted} accepted** to **${s.rejected} rejected** — a ratio of **${ratio(s.accepted, s.rejected)}** accepted issues per rejected issue, out of ${w.population} issues created in the window.
- **${h.shouldNotHaveBeenFiled}** ${h.shouldNotHaveBeenFiled === 1 ? 'issue' : 'issues'} (**${pct(h.shouldNotHaveBeenFiled, w.population)}** of ${w.population}) should never have been filed as a bug. Over all history the figure is **${h.allTime.shouldNotHaveBeenFiled}** of ${total} (**${pct(h.allTime.shouldNotHaveBeenFiled, total)}**) — the rate barely moves between the window and the full store, which is itself the finding. n8n closed them as \`closed:incomplete-template\`, \`closed:support-issue\` or \`closed:non-english\`. An issue carrying more than one of those reasons is counted once.

## Intake and outcome

${windowLine}

${table(['Segment', 'Issues', 'Share'], [
  ['Accepted', s.accepted, pct(s.accepted, w.population)],
  ['Rejected at triage', s.rejected, pct(s.rejected, w.population)],
])}

Denominator: the **${w.population}** issues created in the window.

## Rejection reasons

${windowLine}

${table(['Reason', 'Issues', 'Share of rejected'],
  sortedEntries(r.rejectionReasons).map(([k, v]) => [k, v, pct(v, s.rejected)]))}

Denominator: the **${s.rejected}** issues rejected in the window. An issue may carry more than one reason, so the counts need not sum to ${s.rejected} and the shares need not sum to 100%.

## Component

${windowLine} Accepted issues only. Component coverage: **${pct(r.componentCoverage * s.accepted, s.accepted)}** of ${s.accepted} accepted issues.

${table(['Component', 'Issues'], sortedEntries(r.components))}

## Triage funnel

${windowLine}

${table(['State', 'Issues', 'Share'],
  sortedEntries(r.triageStates).map(([k, v]) => [k, v, pct(v, w.population)]))}

Denominator: the **${w.population}** issues created in the window. ${triaged} carry a \`triage:*\` label and appear above; the other ${w.population - triaged} carry none and appear in no row. The rows count labels, not issues: an issue carrying two \`triage:*\` labels appears in two rows, so the counts need not sum to ${triaged} and the shares need not sum to 100%.

## Lead times

**Not windowed — all ${total} issues, all history.** A lead time windowed by creation date is truncated at both ends: a slow issue created inside the window has usually not finished yet, and a slow issue that has finished was created before it. On the real store that halves the reported median. The tail is the story, so these three rows always cover the whole population.

Reported as median and p90. Means are omitted deliberately: the distribution has a long tail and an average would be meaningless.

${table(['Measure', 'Median (days)', 'p90 (days)', 'n'], [
  ['Issue opened → closed', num(lt.close.median), num(lt.close.p90), lt.close.n],
  ['Issue opened → fix merged', num(lt.fix.median), num(lt.fix.p90), lt.fix.n],
  ['Fix PR opened → merged', num(lt.pr.median), num(lt.pr.p90), lt.pr.n],
])}

## Monthly intake

${windowLine}

${table(['Month', 'Accepted', 'Rejected', 'Total', 'Share'],
  Object.entries(r.byMonth).sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => [m, v.accepted, v.rejected, v.accepted + v.rejected, pct(v.accepted + v.rejected, w.population)]))}

Denominator: the **${w.population}** issues created in the window, keyed by the month the issue was opened.

## Coverage and caveats

${CAVEATS.map(c => `- ${c.md}`).join('\n')}
`;
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

// EVERY interpolated value passes through here. Component names, rejection
// reasons and triage states are GitHub LABEL names: they are chosen by people
// outside this repo, and a label named `<script>` or `a & b` would otherwise
// break the page or inject markup into it. `&` must be replaced FIRST or the
// ampersands introduced by the later replacements are double-escaped.
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Column 0 is a label and stays left-aligned; every other column holds digits
// that must line up, so it is right-aligned and tabular. The wrapper, not the
// page, is what scrolls when a table is wider than the viewport.
const htmlTable = (header, rows) => {
  const cell = (tag, value, i) =>
    `<${tag}${i === 0 ? '' : ' class="num"'}>${escapeHtml(value)}</${tag}>`;
  return [
    '<div class="table-wrap">',
    '<table>',
    `<thead><tr>${header.map((hd, i) => cell('th', hd, i)).join('')}</tr></thead>`,
    '<tbody>',
    ...rows.map(r => `<tr>${r.map((c, i) => cell('td', c, i)).join('')}</tr>`),
    '</tbody>',
    '</table>',
    '</div>',
  ].join('\n');
};

// Self-contained on purpose: one <style> block, no external stylesheet, no
// CDN script, no web font. The same bytes are served from GitHub Pages, from
// a file:// URL and from a mail client, and must render identically in all
// three. The palette is defined as tokens on bare :root and only the tokens
// are redefined for the dark scheme, so no colour is ever a literal that works
// in one scheme and disappears in the other.
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbf9;
  --surface: #ffffff;
  --text: #1b1b19;
  --muted: #5d5d57;
  --border: #dedcd5;
  --head-bg: #f1f0ec;
  --code-bg: #f1f0ec;
  --link: #2b5d8b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181a;
    --surface: #1d2023;
    --text: #e4e5e2;
    --muted: #9fa19c;
    --border: #33373b;
    --head-bg: #24282c;
    --code-bg: #24282c;
    --link: #8db8e0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.65rem; line-height: 1.25; margin: 0 0 0.5rem; }
h2 {
  font-size: 1.15rem;
  margin: 2.5rem 0 0.25rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
p { margin: 0.75rem 0; }
a { color: var(--link); }
strong { font-weight: 600; }
code {
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.meta { color: var(--muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
.meta .figure { font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 0.9rem; }
.lede {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.9rem 1.1rem;
}
ul { margin: 0.75rem 0; padding-left: 1.25rem; }
li { margin: 0.4rem 0; }
.table-wrap {
  overflow-x: auto;
  margin: 1rem 0 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}
table {
  border-collapse: collapse;
  width: 100%;
  min-width: 32rem;
  font-variant-numeric: tabular-nums;
}
th, td { padding: 0.45rem 0.85rem; text-align: left; border-bottom: 1px solid var(--border); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
thead th { background: var(--head-bg); font-weight: 600; font-size: 0.85rem; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.9rem;
}
`.trim();

// The HTML twin of renderReport(). It carries the same numbers, the same
// denominators, the same two-population explanation and the same caveats —
// see CAVEATS above, which both renderers iterate.
export function renderHtml(r, { generatedAt }) {
  const { total, segments: s, window: w } = r;
  const lt = r.leadTimes;
  const h = r.headline;
  const triaged = r.triagedIssues;
  const since = w.since.slice(0, 10);
  const date = generatedAt.slice(0, 10);
  const windowLine = `Window: the ${w.days} days since ${escapeHtml(since)}.`;
  const b = v => `<strong>${escapeHtml(v)}</strong>`;

  const body = [
    `<h1>n8n triage report — ${escapeHtml(date)}</h1>`,
    `<p class="meta"><span class="figure">${b(total)}</span> triaged issues from <code>n8n-io/n8n</code>. Generated ${escapeHtml(generatedAt)}.</p>`,

    `<p class="lede">${b('This report uses two denominators, deliberately.')} The intake sections below cover the ${b(`${w.days} days since ${since}`)} — ${b(w.population)} of the ${escapeHtml(total)} triaged issues in the store, by issue creation date. The ${b('lead times cover all history')}, all ${escapeHtml(total)} issues: windowing a duration by the date the issue was created truncates the slow tail and understates the median by about 2x.</p>`,

    '<h2>Headline</h2>',
    '<ul>',
    `<li>In the ${escapeHtml(w.days)} days since ${escapeHtml(since)}: ${b(`${s.accepted} accepted`)} to ${b(`${s.rejected} rejected`)} — a ratio of ${b(ratio(s.accepted, s.rejected))} accepted issues per rejected issue, out of ${escapeHtml(w.population)} issues created in the window.</li>`,
    `<li>${b(h.shouldNotHaveBeenFiled)} ${h.shouldNotHaveBeenFiled === 1 ? 'issue' : 'issues'} (${b(pct(h.shouldNotHaveBeenFiled, w.population))} of ${escapeHtml(w.population)}) should never have been filed as a bug. Over all history the figure is ${b(h.allTime.shouldNotHaveBeenFiled)} of ${escapeHtml(total)} (${b(pct(h.allTime.shouldNotHaveBeenFiled, total))}) — the rate barely moves between the window and the full store, which is itself the finding. n8n closed them as <code>closed:incomplete-template</code>, <code>closed:support-issue</code> or <code>closed:non-english</code>. An issue carrying more than one of those reasons is counted once.</li>`,
    '</ul>',

    '<h2>Intake and outcome</h2>',
    `<p class="note">${windowLine}</p>`,
    htmlTable(['Segment', 'Issues', 'Share'], [
      ['Accepted', s.accepted, pct(s.accepted, w.population)],
      ['Rejected at triage', s.rejected, pct(s.rejected, w.population)],
    ]),
    `<p class="note">Denominator: the ${b(w.population)} issues created in the window.</p>`,

    '<h2>Rejection reasons</h2>',
    `<p class="note">${windowLine}</p>`,
    htmlTable(['Reason', 'Issues', 'Share of rejected'],
      sortedEntries(r.rejectionReasons).map(([k, v]) => [k, v, pct(v, s.rejected)])),
    `<p class="note">Denominator: the ${b(s.rejected)} issues rejected in the window. An issue may carry more than one reason, so the counts need not sum to ${escapeHtml(s.rejected)} and the shares need not sum to 100%.</p>`,

    '<h2>Component</h2>',
    `<p class="note">${windowLine} Accepted issues only. Component coverage: ${b(pct(r.componentCoverage * s.accepted, s.accepted))} of ${escapeHtml(s.accepted)} accepted issues.</p>`,
    htmlTable(['Component', 'Issues'], sortedEntries(r.components)),

    '<h2>Triage funnel</h2>',
    `<p class="note">${windowLine}</p>`,
    htmlTable(['State', 'Issues', 'Share'],
      sortedEntries(r.triageStates).map(([k, v]) => [k, v, pct(v, w.population)])),
    `<p class="note">Denominator: the ${b(w.population)} issues created in the window. ${escapeHtml(triaged)} carry a <code>triage:*</code> label and appear above; the other ${escapeHtml(w.population - triaged)} carry none and appear in no row. The rows count labels, not issues: an issue carrying two <code>triage:*</code> labels appears in two rows, so the counts need not sum to ${escapeHtml(triaged)} and the shares need not sum to 100%.</p>`,

    '<h2>Lead times</h2>',
    `<p>${b(`Not windowed — all ${total} issues, all history.`)} A lead time windowed by creation date is truncated at both ends: a slow issue created inside the window has usually not finished yet, and a slow issue that has finished was created before it. On the real store that halves the reported median. The tail is the story, so these three rows always cover the whole population.</p>`,
    '<p class="note">Reported as median and p90. Means are omitted deliberately: the distribution has a long tail and an average would be meaningless.</p>',
    htmlTable(['Measure', 'Median (days)', 'p90 (days)', 'n'], [
      ['Issue opened → closed', num(lt.close.median), num(lt.close.p90), lt.close.n],
      ['Issue opened → fix merged', num(lt.fix.median), num(lt.fix.p90), lt.fix.n],
      ['Fix PR opened → merged', num(lt.pr.median), num(lt.pr.p90), lt.pr.n],
    ]),

    '<h2>Monthly intake</h2>',
    `<p class="note">${windowLine}</p>`,
    htmlTable(['Month', 'Accepted', 'Rejected', 'Total', 'Share'],
      Object.entries(r.byMonth).sort(([a], [bb]) => a.localeCompare(bb))
        .map(([m, v]) => [m, v.accepted, v.rejected, v.accepted + v.rejected, pct(v.accepted + v.rejected, w.population)])),
    `<p class="note">Denominator: the ${b(w.population)} issues created in the window, keyed by the month the issue was opened.</p>`,

    '<h2>Coverage and caveats</h2>',
    '<ul>',
    ...CAVEATS.map(c => `<li>${c.html}</li>`),
    '</ul>',

    `<footer><a href="${ARCHIVE_URL}">Every report, by date</a> — this page is a copy of the most recent one.</footer>`,
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>n8n triage report — ${escapeHtml(date)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
