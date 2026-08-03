import type { SyntheticPort } from '../ports/synthetic-port.js';

/** Synthetic dependency-cruiser fixture; not a product module. */
export function acceptsSyntheticPort(_port: SyntheticPort): string {
  return 'synthetic-config';
}
