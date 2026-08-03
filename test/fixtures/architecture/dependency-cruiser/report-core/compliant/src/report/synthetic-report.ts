import type { SyntheticCore } from '../core/synthetic-core.js';

/** Synthetic dependency-cruiser fixture; not a product module. */
export function acceptsSyntheticCore(_core: SyntheticCore): string {
  return 'synthetic-report';
}
