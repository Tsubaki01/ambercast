import type { RandomSource } from '../../src/ports/system.js';

/**
 * Creates a repeatable entropy source for deterministic test scenarios.
 *
 * The factory intentionally does not validate its fixtures: callers use it to
 * arrange the exact values a test needs, while the port contract verifies the
 * valid values supplied where randomness is consumed.
 *
 * @param uuid - Stable UUID value returned for every request.
 * @param float - Stable unit-interval value returned for every request.
 * @returns A random source isolated from every other factory invocation.
 */
export function createFixedRandom(uuid: string, float: number): RandomSource {
  return {
    uuid(): string {
      return uuid;
    },
    float(): number {
      return float;
    },
  };
}
