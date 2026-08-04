/*
 * Supplies host time at the designated nondeterministic system-adapter
 * boundary.
 *
 * Production code outside `src/adapters/system/**` must not construct a
 * zero-argument `Date` or access nondeterministic globals directly. This file
 * is the intentional ESLint exemption, allowing runtime composition to choose
 * real time while deterministic code receives the `Clock` port instead.
 */

import type { Clock } from '#ports/system.js';

/**
 * Creates a clock backed by the current host runtime.
 *
 * @returns A clock that provides wall-clock instants and monotonic
 * duration readings.
 *
 * @remarks
 * `now()` creates a fresh `Date` because the port exposes a wall-clock
 * instant. `monotonicMs()` instead uses `performance.now()`, not `Date.now()`:
 * duration comparisons
 * require a non-wall-clock, non-decreasing reading that wall-clock adjustment
 * can violate.
 */
export function createSystemClock(): Clock {
  return {
    now(): Date {
      return new Date();
    },
    monotonicMs(): number {
      return performance.now();
    },
  };
}
