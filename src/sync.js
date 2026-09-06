import { fetchAll } from './lib/github.js';
import { upsert, watermarkOf } from './lib/store.js';

const OVERLAP_MS = 5 * 60 * 1000;

// Deliberately re-fetch a 5-minute overlap. Duplicates are cheap because
// upsert is keyed on issue number; a gap is silent and permanent.
export function overlapWindow(watermark) {
  if (!watermark) return null;
  return new Date(Date.parse(watermark) - OVERLAP_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function syncSince(store, { token }) {
  const since = overlapWindow(watermarkOf(store));
  const { issues } = await fetchAll({ token, since });
  upsert(store, issues);
  return { store, fetched: issues.length, watermark: watermarkOf(store) };
}
