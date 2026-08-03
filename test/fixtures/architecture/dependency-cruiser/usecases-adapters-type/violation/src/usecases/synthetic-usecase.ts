import type { SyntheticAdapter } from '../adapters/synthetic-adapter.js';

/** Synthetic dependency-cruiser fixture; not a product module. */
export function acceptsSyntheticAdapter(_adapter: SyntheticAdapter): string {
  return 'synthetic-usecase';
}
