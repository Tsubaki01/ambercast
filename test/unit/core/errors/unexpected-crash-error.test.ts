import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';

describe('UnexpectedCrashError', () => {
  it('constructs an Error with the fixed unexpected-crash classification and mapped exit code', () => {
    const error = new UnexpectedCrashError('The generate command crashed unexpectedly.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('unexpected-crash');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['unexpected-crash']);
    expect(error.exitCode).toBe(3);
  });

  it('retains its message, details, and Error-constructor cause', () => {
    const cause = new Error('unexpected failure');
    const details = { command: 'generate', signal: 'SIGTERM' };
    const error = new UnexpectedCrashError('The generate command crashed unexpectedly.', details, { cause });

    expect(error.message).toBe('The generate command crashed unexpectedly.');
    expect(error.details).toEqual(details);
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new UnexpectedCrashError('The generate command crashed unexpectedly.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
