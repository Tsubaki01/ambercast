/*
 * Reads environment facts at the designated real system-adapter boundary.
 *
 * Application policy receives `EnvironmentInfo` instead of observing
 * `process.env` directly, keeping deterministic consumers independent of a
 * process-global mutable value. This adapter path is the deliberate ESLint
 * exemption for that direct environment access.
 */

import type { EnvironmentInfo } from '#ports/system.js';

/**
 * Creates environment information backed by the current process.
 *
 * @returns Environment information that evaluates the process CI marker.
 *
 * @remarks
 * `isCI()` treats `CI` as active exactly when it
 * is defined, nonempty, and not the literal lowercase string `'false'`.
 * Consequently, `undefined`, `''`, and `'false'` are inactive, while
 * `'FALSE'`, `'0'`, whitespace-only values, and other nonempty strings are
 * active. This deliberately avoids boolean parsing or normalization: the
 * precise rule is the deployment-policy contract rather than an incidental
 * environment-variable convention.
 */
export function createProcessEnvironmentInfo(): EnvironmentInfo {
  return {
    isCI(): boolean {
      const ci = process.env.CI;
      return ci !== undefined && ci !== '' && ci !== 'false';
    },
  };
}
