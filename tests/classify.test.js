import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentOf, componentOf, packageOf } from '../src/lib/classify.js';

const byNumber = new Map(
  readFileSync('tests/fixtures/issues.sample.ndjson', 'utf8')
    .trim().split('\n').map(JSON.parse).map(i => [i.number, i])
);

test('segments split on the presence of a closed:* reason', () => {
  assert.equal(segmentOf(byNumber.get(16861)), 'rejected');
  assert.equal(segmentOf(byNumber.get(16971)), 'rejected');
  assert.equal(segmentOf(byNumber.get(16038)), 'accepted');
  assert.equal(segmentOf(byNumber.get(21305)), 'accepted');
});

test('team label wins and is stripped of its prefix', () => {
  assert.equal(componentOf(byNumber.get(16038)), 'nodes');
  assert.equal(componentOf(byNumber.get(16207)), 'payday');
});

test('rejected issues have no component at all', () => {
  assert.equal(componentOf(byNumber.get(16861)), null);
  assert.equal(componentOf(byNumber.get(16971)), null);
});

test('accepted issues with no signal are explicitly unclassified', () => {
  assert.equal(componentOf(byNumber.get(21305)), 'unclassified');
  assert.equal(componentOf(byNumber.get(21298)), 'unclassified');
});

// REGRESSION: a two-segment split collapses ~40 packages into `packages/@n8n`,
// which would rank second-largest in the report and does not exist.
test('scoped packages keep three path segments', () => {
  assert.equal(componentOf(byNumber.get(17688)), 'packages/@n8n/nodes-langchain');
  assert.equal(componentOf(byNumber.get(22016)), 'packages/@n8n/db');
  assert.equal(packageOf(['packages/@n8n/db/src/x.ts']), 'packages/@n8n/db');
});

test('unscoped packages keep two path segments', () => {
  assert.equal(componentOf(byNumber.get(22153)), 'packages/nodes-base');
  assert.equal(componentOf(byNumber.get(22122)), 'packages/nodes-base');
  assert.equal(packageOf(['packages/cli/src/x.ts']), 'packages/cli');
});

test('the dominant package wins, not the first seen', () => {
  assert.equal(
    packageOf(['packages/cli/a.ts', 'packages/core/b.ts', 'packages/core/c.ts']),
    'packages/core'
  );
});

test('non-package paths are ignored', () => {
  assert.equal(packageOf(['README.md', '.github/workflows/ci.yml']), null);
});

// SYNTHETIC FIXTURES 900001/900002. These exist because no REAL fixture reaches
// the merged-PR branch of componentOf with an unmerged PR in play: #16207 has an
// unmerged PR but a team: label short-circuits first, and #16971 is rejected.
// Without these, deleting the `pr.mergedAt != null` filter at classify.js:39
// leaves the whole suite green.
test('an unmerged PR is not evidence of a component', () => {
  assert.equal(componentOf(byNumber.get(900001)), 'unclassified');
});

test('a merged PR outranks an unmerged PR that touches more files', () => {
  // #900002 links an unmerged PR touching 2 files in packages/cli and a merged
  // PR touching 1 file in packages/nodes-base. Counting the unmerged PR would
  // return 'packages/cli'.
  assert.equal(componentOf(byNumber.get(900002)), 'packages/nodes-base');
});
