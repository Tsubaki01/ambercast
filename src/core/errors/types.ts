export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export type ErrorKind =
  | 'assertion-failed'
  | 'config-invalid'
  | 'secret-unresolved'
  | 'target-unresolved'
  | 'secrets-literal-rejected'
  | 'missing-plan'
  | 'stale-ir'
  | 'integrity-violation'
  | 'browser-launch-failed'
  | 'ai-executor-unavailable'
  | 'fs-io-error'
  | 'unexpected-crash'
  | 'no-tests-found';

export abstract class AmbercastError extends Error {
  abstract readonly kind: ErrorKind;

  get exitCode(): ExitCode {
    throw new Error('not implemented');
  }

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
