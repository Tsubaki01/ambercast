import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '../../../../src/core/errors/exit-codes.js';
import { AmbercastError, type ErrorKind } from '../../../../src/core/errors/types.js';

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
    for (const kind of ['assertion-failed', 'stale-ir', 'no-tests-found'] as const) {
      const error = new TestAmbercastError(kind, 'The operation failed.');

      expect(error.exitCode).toBe(ERROR_EXIT_CODES[kind]);
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
