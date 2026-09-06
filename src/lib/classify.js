import { ADHOC_COMPONENT_LABELS } from './labels.js';

const namesOf = issue => (issue.labels?.nodes ?? []).map(l => l.name);

export function segmentOf(issue) {
  return namesOf(issue).some(n => n.startsWith('closed:')) ? 'rejected' : 'accepted';
}

export function packageOf(paths) {
  const counts = new Map();
  for (const path of paths) {
    if (!path.startsWith('packages/')) continue;
    const seg = path.split('/');
    // Scoped packages need three segments: packages/@n8n/db, not packages/@n8n.
    const depth = seg[1]?.startsWith('@') ? 3 : 2;
    if (seg.length < depth) continue;
    const key = seg.slice(0, depth).join('/');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export function componentOf(issue) {
  if (segmentOf(issue) === 'rejected') return null;

  const names = namesOf(issue);

  const team = names.find(n => n.startsWith('team:'));
  if (team) return team.slice('team:'.length);

  if (names.some(n => n.startsWith('node/'))) return 'nodes';

  const adhoc = names.find(n => ADHOC_COMPONENT_LABELS.includes(n));
  if (adhoc) return adhoc;

  // Only MERGED pull requests are evidence of where the fix landed.
  const paths = (issue.closedByPullRequestsReferences?.nodes ?? [])
    .filter(pr => pr.mergedAt != null)
    .flatMap(pr => (pr.files?.nodes ?? []).map(f => f.path));

  return packageOf(paths) ?? 'unclassified';
}
