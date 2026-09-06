import { segmentOf, componentOf } from './classify.js';
import { SHOULD_NOT_HAVE_BEEN_FILED } from './labels.js';
import { leadTimes, median, p90 } from './metrics.js';

const DAY_MS = 86_400_000;

const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
const summarise = xs => ({ median: median(xs), p90: p90(xs), n: xs.length });

// ---------------------------------------------------------------------------
// TWO DENOMINATORS, DELIBERATELY. DO NOT "SIMPLIFY" THIS INTO ONE.
// ---------------------------------------------------------------------------
//
// The store keeps full history. This rollup reports over two different
// populations, and which measure gets which population is load-bearing:
//
//   WINDOWED by createdAt >= now - windowDays:
//     segments, rejectionReasons, components, componentCoverage,
//     triageStates, triagedIssues, byMonth, headline.
//     These describe INTAKE. "What is arriving, and what do we do with it"
//     is a question about the recent past; answering it over five years of
//     history buries a change in triage practice under the back catalogue.
//
//   NOT WINDOWED — all history, always:
//     leadTimes.close, leadTimes.fix, leadTimes.pr.
//     Windowing a duration by the date the issue was CREATED truncates the
//     distribution: a slow issue created inside the window has not finished
//     yet, and a slow issue that did finish was created before it. Only the
//     fast half survives, so the median collapses.
//
//     Measured on the real 5,464-record store: median fix lead time is
//     25.3 days over all history, but 12.7 days if the population is windowed
//     by creation date. That is a 2x UNDERSTATEMENT, and it is pure
//     truncation bias, not a real improvement. The tail is the whole story of
//     a lead-time distribution; a window amputates it.
//
// `total` therefore stays the FULL population while `window.population` gives
// the windowed one, so every table in the report can print the denominator it
// was actually computed over. See tests/rollup.test.js, "lead times cover all
// history, never the window".

export function rollup(issues, { windowDays = 180, now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const sinceMs = nowMs - windowDays * DAY_MS;

  const segments = { accepted: 0, rejected: 0 };
  const rejectionReasons = {}, components = {}, triageStates = {}, byMonth = {};
  const close = [], fix = [], pr = [];
  let windowPopulation = 0;
  let shouldNotHaveBeenFiled = 0, shouldNotHaveBeenFiledAllTime = 0;
  let triagedIssues = 0;

  for (const issue of issues) {
    // --- All history: lead times and the all-time headline ------------------
    const lt = leadTimes(issue);
    if (lt.closeDays != null) close.push(lt.closeDays);
    if (lt.fixDays != null) fix.push(lt.fixDays);
    if (lt.prDays != null) pr.push(lt.prDays);

    const names = (issue.labels?.nodes ?? []).map(l => l.name);
    // Counted once per issue, however many of the three reasons it carries.
    const neverShouldHaveBeenFiled = names.some(n => SHOULD_NOT_HAVE_BEEN_FILED.includes(n));
    if (neverShouldHaveBeenFiled) shouldNotHaveBeenFiledAllTime += 1;

    // --- The window: everything below describes intake ----------------------
    // A record with no parsable createdAt cannot be placed in time, so it
    // counts in `total` and in the lead times but never in the window.
    if (!(Date.parse(issue.createdAt) >= sinceMs)) continue;
    windowPopulation += 1;

    const segment = segmentOf(issue);
    segments[segment] += 1;

    // triageStates counts LABELS; triagedIssues counts ISSUES. They are not
    // interchangeable and summing the first does NOT give the second: on the
    // real store 1,546 triage:* labels are spread across 1,309 issues, because
    // 237 issues carry more than one. Deriving the funnel denominator by
    // summing triageStates published "1546 carry a triage label ... the other
    // 3918 carry none" against a truth of 1,309 and 4,155. Use triagedIssues
    // for any per-issue denominator.
    let carriesTriageLabel = false;
    for (const n of names) {
      if (n.startsWith('closed:')) bump(rejectionReasons, n);
      if (n.startsWith('triage:')) { bump(triageStates, n); carriesTriageLabel = true; }
    }
    if (carriesTriageLabel) triagedIssues += 1;

    if (neverShouldHaveBeenFiled) shouldNotHaveBeenFiled += 1;

    if (segment === 'accepted') bump(components, componentOf(issue));

    const month = (issue.createdAt ?? '').slice(0, 7);
    if (month) {
      byMonth[month] ??= { accepted: 0, rejected: 0 };
      byMonth[month][segment] += 1;
    }
  }

  const classified = segments.accepted - (components.unclassified ?? 0);

  return {
    total: issues.length,
    window: {
      since: new Date(sinceMs).toISOString(),
      days: windowDays,
      population: windowPopulation,
    },
    segments,
    headline: {
      shouldNotHaveBeenFiled,
      shareOfPopulation: windowPopulation === 0 ? 0 : shouldNotHaveBeenFiled / windowPopulation,
      allTime: {
        shouldNotHaveBeenFiled: shouldNotHaveBeenFiledAllTime,
        shareOfPopulation: issues.length === 0 ? 0 : shouldNotHaveBeenFiledAllTime / issues.length,
      },
    },
    rejectionReasons,
    components,
    componentCoverage: segments.accepted === 0 ? 0 : classified / segments.accepted,
    triageStates,
    triagedIssues,
    leadTimes: { close: summarise(close), fix: summarise(fix), pr: summarise(pr) },
    byMonth,
  };
}
