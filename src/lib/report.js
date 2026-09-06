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

export function renderReport(r, { generatedAt }) {
  const { total, segments: s } = r;
  const lt = r.leadTimes;

  return `# n8n triage report — ${generatedAt.slice(0, 10)}

Population: **${total}** triaged issues from \`n8n-io/n8n\`.
Generated ${generatedAt}.

## Intake and outcome

${table(['Segment', 'Issues', 'Share'], [
  ['Accepted', s.accepted, pct(s.accepted, total)],
  ['Rejected at triage', s.rejected, pct(s.rejected, total)],
])}

## Rejection reasons

${table(['Reason', 'Issues'], sortedEntries(r.rejectionReasons))}

An issue may carry more than one reason, so these need not sum to ${s.rejected}.

## Component

Accepted issues only. Component coverage: **${pct(r.componentCoverage * s.accepted, s.accepted)}** of ${s.accepted} accepted issues.

${table(['Component', 'Issues'], sortedEntries(r.components))}

## Triage funnel

${table(['State', 'Issues'], sortedEntries(r.triageStates))}

## Lead times

Reported as median and p90. Means are omitted deliberately: the distribution has a long tail and an average would be meaningless.

${table(['Measure', 'Median (days)', 'p90 (days)', 'n'], [
  ['Issue opened → closed', num(lt.close.median), num(lt.close.p90), lt.close.n],
  ['Issue opened → fix merged', num(lt.fix.median), num(lt.fix.p90), lt.fix.n],
  ['Fix PR opened → merged', num(lt.pr.median), num(lt.pr.p90), lt.pr.n],
])}

## Monthly intake

${table(['Month', 'Accepted', 'Rejected'],
  Object.entries(r.byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => [m, v.accepted, v.rejected]))}

## Coverage and caveats

- This measures **intake and triage, not delivery.** n8n moves accepted issues into **Linear**, at which point GitHub stops being the system of record. Do not read this as engineering throughput.
- Only issues carrying one of 33 \`triage:*\`, \`team:*\` or \`closed:*\` labels are included. Unlabelled community issues are out of scope.
- \`unclassified\` counts accepted issues with no team label and no merged fix PR to derive a component from. It is reported, not hidden.
- Fix lead time is computed only where a linked PR was actually **merged**. Linked-but-unmerged PRs are excluded.
`;
}
