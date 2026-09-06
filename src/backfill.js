import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchAll } from './lib/github.js';
import { serialiseStore, upsert } from './lib/store.js';

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is not set. Use a fine-grained PAT with Issues:read and Pull requests:read.');
  process.exit(1);
}

const out = process.argv[2] ?? 'data/issues.ndjson';

const { issues, pages, points } = await fetchAll({
  token,
  onPage: ({ pages, received, remaining }) =>
    process.stderr.write(`\rpage ${pages}  issues ${received}  rate-limit remaining ${remaining}   `),
});
process.stderr.write('\n');

const store = upsert(new Map(), issues);
mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(out, serialiseStore(store));

console.log(`wrote ${store.size} issues to ${out} (${pages} pages, ${points} rate-limit points)`);
if (store.size !== issues.length) {
  console.warn(`note: ${issues.length - store.size} duplicate issue numbers were collapsed`);
}
