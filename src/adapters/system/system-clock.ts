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
 * @returns A clock that will provide wall-clock instants and monotonic
 * duration readings.
 *
 * @remarks
 * The eventual `now()` implementation will create a fresh `Date` because the
 * port exposes a wall-clock instant. Its `monotonicMs()` implementation will
 * instead use `performance.now()`, not `Date.now()`: duration comparisons
 * require a non-wall-clock, non-decreasing reading that wall-clock adjustment
 * can violate.
 */
export function createSystemClock(): Clock {
  return {
    /**
     * The eventual operation will construct a fresh wall-clock instant for
     * each call rather than share a stale timestamp.
     */
    now(): Date {
      throw new Error('not implemented');
    },
    /**
     * The eventual operation will draw from the runtime's monotonic
     * performance clock so elapsed-time comparisons ignore wall-clock shifts.
     */
    monotonicMs(): number {
      throw new Error('not implemented');
    },
  };
}
