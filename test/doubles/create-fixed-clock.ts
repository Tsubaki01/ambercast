import type { Clock } from '../../src/ports/system.js';

/**
 * Creates a stable clock for scenarios that must not observe host time.
 *
 * The supplied instant is stored as milliseconds and copied on every read so
 * a test cannot mutate one returned `Date` and change later observations.
 *
 * @param now - Wall-clock instant supplied by the scenario.
 * @param monotonicMs - Stable elapsed-time reading supplied by the scenario.
 * @returns A clock with independently repeatable values.
 */
export function createFixedClock(now: Date, monotonicMs: number): Clock {
  const timestamp = now.getTime();

  return {
    now(): Date {
      return new Date(timestamp);
    },
    monotonicMs(): number {
      return monotonicMs;
    },
  };
}
