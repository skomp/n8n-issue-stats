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

// The accepted:rejected ratio, expressed as accepted issues per rejected issue.
// Undefined when nothing was rejected, which prints as an em dash.
const ratio = (a, b) => b === 0 ? '—' : (a / b).toFixed(2);

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
  const triaged = Object.values(r.triageStates).reduce((a, b) => a + b, 0);
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

Denominator: the **${w.population}** issues created in the window. ${triaged} carry a \`triage:*\` label and appear above; the other ${w.population - triaged} carry none and appear in no row.

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

- This measures **intake and triage, not delivery.** n8n moves accepted issues into **Linear**, at which point GitHub stops being the system of record. Do not read this as engineering throughput.
- The intake sections and the lead times use **different populations on purpose.** Intake is a question about the recent past, so it is windowed; a lead time windowed by creation date is truncated, so it is not. Comparing a windowed count against an all-time one is a mistake the section notes exist to prevent.
- Only issues carrying one of 33 \`triage:*\`, \`team:*\` or \`closed:*\` labels are included. Unlabelled community issues are out of scope.
- \`unclassified\` counts accepted issues with no team label and no merged fix PR to derive a component from. It is reported, not hidden.
- Fix lead time is computed only where a linked PR was actually **merged**. Linked-but-unmerged PRs are excluded.
`;
}
