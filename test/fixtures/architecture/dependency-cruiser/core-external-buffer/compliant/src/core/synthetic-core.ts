import { Buffer } from 'node:buffer';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticBufferLength = Buffer.from('synthetic').length;
