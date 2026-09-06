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
