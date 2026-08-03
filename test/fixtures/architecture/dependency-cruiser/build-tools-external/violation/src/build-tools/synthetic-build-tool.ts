import { createHash } from 'node:crypto';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticBuildToolValue = createHash('sha256').digest('hex');
