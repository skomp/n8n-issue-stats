import { segmentOf, componentOf } from './classify.js';
import { SHOULD_NOT_HAVE_BEEN_FILED } from './labels.js';
import { leadTimes, median, p90 } from './metrics.js';

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
const summarise = xs => ({ median: median(xs), p90: p90(xs), n: xs.length });

export function rollup(issues) {
  const segments = { accepted: 0, rejected: 0 };
  const rejectionReasons = {}, components = {}, triageStates = {}, byMonth = {};
  const close = [], fix = [], pr = [];
  let shouldNotHaveBeenFiled = 0;

  for (const issue of issues) {
    const segment = segmentOf(issue);
    segments[segment] += 1;

    const names = (issue.labels?.nodes ?? []).map(l => l.name);
    for (const n of names) {
      if (n.startsWith('closed:')) bump(rejectionReasons, n);
      if (n.startsWith('triage:')) bump(triageStates, n);
    }

    // Counted once per issue, however many of the three reasons it carries.
    if (names.some(n => SHOULD_NOT_HAVE_BEEN_FILED.includes(n))) shouldNotHaveBeenFiled += 1;

    if (segment === 'accepted') bump(components, componentOf(issue));

    const month = (issue.createdAt ?? '').slice(0, 7);
    if (month) {
      byMonth[month] ??= { accepted: 0, rejected: 0 };
      byMonth[month][segment] += 1;
    }

    const lt = leadTimes(issue);
    if (lt.closeDays != null) close.push(lt.closeDays);
    if (lt.fixDays != null) fix.push(lt.fixDays);
    if (lt.prDays != null) pr.push(lt.prDays);
  }

  const classified = segments.accepted - (components.unclassified ?? 0);

  return {
    total: issues.length,
    segments,
    headline: {
      shouldNotHaveBeenFiled,
      shareOfPopulation: issues.length === 0 ? 0 : shouldNotHaveBeenFiled / issues.length,
    },
    rejectionReasons,
    components,
    componentCoverage: segments.accepted === 0 ? 0 : classified / segments.accepted,
    triageStates,
    leadTimes: { close: summarise(close), fix: summarise(fix), pr: summarise(pr) },
    byMonth,
  };
}
