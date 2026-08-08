import type { ErrorKind, ExitCode } from './types.js';

/*
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
 * The groups distinguish assertion outcomes, caller-correctable usage,
 * execution-environment failures, and untrustworthy plan or grounding
 * artifacts. The zero-match outcome remains distinct so an empty invocation
 * cannot be mistaken for an assertion failure or invalid input.
 */
export const ERROR_EXIT_CODES = {
  'assertion-failed': 1,
  'config-invalid': 2,
  'secret-unresolved': 2,
  'target-unresolved': 2,
  'secret-literal-rejected': 2,
  'missing-plan': 4,
  'stale-ir': 4,
  'integrity-violation': 4,
  'browser-launch-failed': 3,
  'ai-executor-unavailable': 3,
  'ai-response-invalid': 3,
  'fs-io-error': 3,
  'unexpected-crash': 3,
  // Zero-match runs are structural report outcomes, but this kind stays mapped
  // so process-status selection remains exhaustive.
  'no-tests-found': 5,
} as const satisfies Record<ErrorKind, ErrorExitCode>;
