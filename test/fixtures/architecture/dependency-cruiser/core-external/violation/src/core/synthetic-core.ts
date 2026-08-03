import { readFileSync } from 'node:fs';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticReadFile = readFileSync;
