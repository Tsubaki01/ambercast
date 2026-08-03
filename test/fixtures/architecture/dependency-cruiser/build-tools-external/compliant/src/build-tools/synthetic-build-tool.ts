import { readFile } from 'node:fs/promises';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticBuildToolValue = readFile;
