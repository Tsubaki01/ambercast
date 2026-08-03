// @ts-expect-error -- this synthetic fixture deliberately names an unlisted external package.
import leftPad from 'left-pad';

/** Synthetic dependency-cruiser fixture; not a product module. */
export const syntheticPaddedValue = leftPad('synthetic', 12);
