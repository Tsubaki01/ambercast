import type { ErrorKind, ExitCode } from './types.js';

/**
 * Defines the total mapping from classified failures to non-success process
 * statuses. The table is total so adding an error classification cannot create
 * an unhandled process outcome.
 */

/**
 * A non-success exit status that an {@link AmbercastError} can produce.
 *
 * Excluding the successful status makes it impossible to assign a thrown,
 * classified error a clean process outcome.
 */
export type ErrorExitCode = Exclude<ExitCode, 0>;

/**
 * Associates every {@link ErrorKind} with its process exit status.
 *
 * @remarks
 * The contract assigns `assertion-failed` to exit code `1`, which identifies
 * a test assertion failure. It assigns `config-invalid`, `secret-unresolved`,
 * `target-unresolved`, and `secrets-literal-rejected` to exit code `2` because
 * each is a usage error that a caller can correct in its inputs or setup.
 *
 * It assigns `browser-launch-failed`, `ai-executor-unavailable`,
 * `fs-io-error`, and `unexpected-crash` to exit code `3`, grouping failures
 * caused by the execution environment. It assigns `missing-plan`, `stale-ir`,
 * and `integrity-violation` to exit code `4`, because each means the plan or
 * grounding artifact is untrustworthy. Finally, `no-tests-found` maps to exit
 * code `5` so a zero-match invocation remains distinguishable from an
 * assertion failure or an invalid invocation.
 */
export const ERROR_EXIT_CODES = {
  'assertion-failed': 1,
  'config-invalid': 2,
  'secret-unresolved': 2,
  'target-unresolved': 2,
  'secrets-literal-rejected': 2,
  'missing-plan': 4,
  'stale-ir': 4,
  'integrity-violation': 4,
  'browser-launch-failed': 3,
  'ai-executor-unavailable': 3,
  'fs-io-error': 3,
  'unexpected-crash': 3,
  // Zero-match runs are structural report outcomes, but this kind stays mapped
  // so process-status selection remains exhaustive.
  'no-tests-found': 5,
} as const satisfies Record<ErrorKind, ErrorExitCode>;
