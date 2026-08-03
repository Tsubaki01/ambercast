import { createHash } from 'node:crypto';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticDigest = createHash('sha256').update('synthetic').digest('hex');
