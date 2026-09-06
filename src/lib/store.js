export function parseStore(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const issue = JSON.parse(trimmed);
    map.set(issue.number, issue);
  }
  return map;
}

export function serialiseStore(map) {
  return [...map.values()]
    .sort((a, b) => a.number - b.number)
    .map(i => JSON.stringify(i))
    .join('\n') + '\n';
}

export function upsert(map, issues) {
  for (const issue of issues) map.set(issue.number, issue);
  return map;
}

export function watermarkOf(map) {
  let max = null;
  for (const issue of map.values()) {
    if (issue.updatedAt && (max === null || issue.updatedAt > max)) max = issue.updatedAt;
  }
  return max;
}
