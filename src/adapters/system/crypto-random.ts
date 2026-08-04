/*
 * Supplies process randomness at the designated nondeterministic
 * system-adapter boundary.
 *
 * Keeping direct global randomness here lets deterministic application code
 * depend on `RandomSource` and use fixed substitutes. This path is the
 * intentional ESLint exemption for `Math.random()` and the real UUID source.
 */

import type { RandomSource } from '#ports/system.js';

/**
 * Creates a random source backed by Node and the host runtime.
 *
 * @returns A random source that will generate caller-owned UUIDs and unit
 * interval fractional values.
 *
 * @remarks
 * The eventual UUID operation will use `randomUUID()` from `node:crypto` so
 * identifier generation does not rely on a hand-rolled format. The fractional
 * operation will delegate to `Math.random()`, whose unit-interval contract
 * already matches `RandomSource.float()`; both direct sources are allowed only
 * at this system-adapter boundary.
 */
export function createCryptoRandom(): RandomSource {
  return {
    /**
     * The eventual operation will obtain a UUID from Node's cryptographic UUID
     * facility instead of assembling one from application-level random bytes.
     */
    uuid(): string {
      throw new Error('not implemented');
    },
    /**
     * The eventual operation will delegate to the runtime generator that
     * already produces values in the port's half-open unit interval.
     */
    float(): number {
      throw new Error('not implemented');
    },
  };
}
