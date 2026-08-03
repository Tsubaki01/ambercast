import type { ErrorKind, ExitCode } from './types.js';

export type ErrorExitCode = Exclude<ExitCode, 0>;

export const ERROR_EXIT_CODES = {
  'assertion-failed': 1,
  'config-invalid': 1,
  'secret-unresolved': 1,
  'target-unresolved': 1,
  'secrets-literal-rejected': 1,
  'missing-plan': 1,
  'stale-ir': 1,
  'integrity-violation': 1,
  'browser-launch-failed': 1,
  'ai-executor-unavailable': 1,
  'fs-io-error': 1,
  'unexpected-crash': 1,
  'no-tests-found': 1,
} as const satisfies Record<ErrorKind, ErrorExitCode>;
