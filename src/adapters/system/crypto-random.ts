/*
 * Supplies process randomness at the designated nondeterministic
 * system-adapter boundary.
 *
 * Keeping direct global randomness here lets deterministic application code
 * depend on `RandomSource` and use fixed substitutes. This path is the
 * intentional ESLint exemption for `Math.random()` and the real UUID source.
 */

import { randomUUID } from 'node:crypto';
import type { RandomSource } from '#ports/system.js';

/**
 * Creates a random source backed by Node and the host runtime.
 *
 * @returns A random source that generates caller-owned UUIDs and unit
 * interval fractional values.
 *
 * @remarks
 * The UUID operation uses `randomUUID()` from `node:crypto` so
 * identifier generation does not rely on a hand-rolled format. The fractional
 * operation delegates to `Math.random()`, whose unit-interval contract
 * already matches `RandomSource.float()`; both direct sources are allowed only
 * at this system-adapter boundary.
 */
export function createCryptoRandom(): RandomSource {
  return {
    uuid(): string {
      return randomUUID();
    },
    float(): number {
      return Math.random();
    },
  };
}
