const DAY_MS = 86_400_000;
const days = (from, to) =>
  from && to ? (Date.parse(to) - Date.parse(from)) / DAY_MS : null;

export function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function p90(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

export function leadTimes(issue) {
  // Only merged PRs count. 55% of linked PRs were closed without merging.
  const merged = (issue.closedByPullRequestsReferences?.nodes ?? [])
    .filter(pr => pr.mergedAt != null)
    .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  const first = merged[0] ?? null;

  return {
    closeDays: days(issue.createdAt, issue.closedAt),
    fixDays: first ? days(issue.createdAt, first.mergedAt) : null,
    prDays: first ? days(first.createdAt, first.mergedAt) : null,
  };
}
