import { ALL_FILTER_LABELS } from './labels.js';

export const ISSUES_QUERY = `
query($cursor: String, $labels: [String!]!, $since: DateTime) {
  rateLimit { cost remaining }
  repository(owner: "n8n-io", name: "n8n") {
    issues(first: 100, after: $cursor, labels: $labels,
           filterBy: {since: $since},
           orderBy: {field: UPDATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state createdAt updatedAt closedAt
        author { login }
        labels(first: 30) { nodes { name } }
        reactions { totalCount }
        comments { totalCount }
        closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
          nodes { number createdAt mergedAt
                  files(first: 100) { nodes { path } } }
        }
      }
    }
  }
}`;

export async function fetchPage({ token, cursor = null, since = null }) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'skomp-n8n-triage-analytics',
    },
    body: JSON.stringify({
      query: ISSUES_QUERY,
      variables: { cursor, since, labels: ALL_FILTER_LABELS },
    }),
  });

  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.errors) throw new Error(`GitHub GraphQL: ${body.errors.map(e => e.message).join('; ')}`);

  const conn = body.data.repository.issues;
  return {
    nodes: conn.nodes,
    endCursor: conn.pageInfo.endCursor,
    hasNextPage: conn.pageInfo.hasNextPage,
    cost: body.data.rateLimit.cost,
    remaining: body.data.rateLimit.remaining,
  };
}

export async function fetchAll({ token, since = null, onPage = null }) {
  const issues = [];
  let cursor = null, pages = 0, points = 0;

  for (;;) {
    const page = await fetchPage({ token, cursor, since });
    issues.push(...page.nodes);
    pages += 1;
    points += page.cost;
    if (onPage) onPage({ pages, points, received: issues.length, remaining: page.remaining });
    if (!page.hasNextPage) break;
    cursor = page.endCursor;
  }

  return { issues, pages, points };
}
