import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES, type ErrorExitCode } from '../../../../src/core/errors/exit-codes.js';
import { AmbercastError, type ErrorKind } from '../../../../src/core/errors/types.js';

const EXIT_CODE_GROUP_REPRESENTATIVES = [
  ['assertion-failed', 1],
  ['config-invalid', 2],
  ['browser-launch-failed', 3],
  ['stale-ir', 4],
  ['no-tests-found', 5],
] as const satisfies readonly (readonly [ErrorKind, ErrorExitCode])[];

class TestAmbercastError extends AmbercastError {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, details, options);
  }
}

describe('AmbercastError', () => {
  it('dispatches its exit code through ERROR_EXIT_CODES', () => {
    for (const [kind, expectedExitCode] of EXIT_CODE_GROUP_REPRESENTATIVES) {
      const error = new TestAmbercastError(kind, 'The operation failed.');

      expect(error.exitCode).toBe(ERROR_EXIT_CODES[kind]);
      expect(error.exitCode).toBe(expectedExitCode);
    }
  });

  it('keeps the exit-code table in ErrorExitCode non-success value space', () => {
    const errorExitCodes: readonly ErrorExitCode[] = Object.values(ERROR_EXIT_CODES);

    for (const exitCode of errorExitCodes) {
      expect([1, 2, 3, 4, 5]).toContain(exitCode);
      expect(exitCode).not.toBe(0);
    }
  });

  it('never exposes a success exit code from an AmbercastError instance', () => {
    for (const kind of Object.keys(ERROR_EXIT_CODES) as ErrorKind[]) {
      const error = new TestAmbercastError(kind, 'The operation failed.');

      expect(error.exitCode).not.toBe(0);
    }
  });

  it('retains its message, details, and Error-constructor cause', () => {
    const cause = new Error('The browser process exited unexpectedly.');
    const details = { browser: 'chromium', attempt: 2 };
    const error = new TestAmbercastError('browser-launch-failed', 'Could not launch the browser.', details, { cause });

    expect(error.message).toBe('Could not launch the browser.');
    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it('allows details to be omitted', () => {
    const error = new TestAmbercastError('config-invalid', 'Configuration is invalid.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('allows Error options to be omitted when details are present', () => {
    const details = { file: 'ambercast.config.ts' };
    const error = new TestAmbercastError('config-invalid', 'Configuration is invalid.', details);

    expect(error.details).toBe(details);
    expect(error.cause).toBeUndefined();
  });

  it('remains an Error instance', () => {
    const error = new TestAmbercastError('fs-io-error', 'Could not read the plan.');

    expect(error).toBeInstanceOf(Error);
  });
});
