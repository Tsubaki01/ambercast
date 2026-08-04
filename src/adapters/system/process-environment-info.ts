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
 * @returns Environment information that will evaluate the process CI marker.
 *
 * @remarks
 * The eventual `isCI()` operation will treat `CI` as active exactly when it
 * is defined, nonempty, and not the literal lowercase string `'false'`.
 * Consequently, `undefined`, `''`, and `'false'` will be inactive, while
 * `'FALSE'`, `'0'`, whitespace-only values, and other nonempty strings will
 * be active. This deliberately avoids boolean parsing or normalization: the
 * precise rule is the deployment-policy contract rather than an incidental
 * environment-variable convention.
 */
export function createProcessEnvironmentInfo(): EnvironmentInfo {
  return {
    /**
     * The eventual operation will evaluate the current CI value with the
     * exact case-sensitive policy documented for this adapter.
     */
    isCI(): boolean {
      throw new Error('not implemented');
    },
  };
}
