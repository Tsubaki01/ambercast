import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { SecretUnresolvedError } from '#core/errors/secret-unresolved-error.js';

describe('SecretUnresolvedError', () => {
  it('constructs an Error with the fixed secret-unresolved classification and mapped exit code', () => {
    const error = new SecretUnresolvedError('The requested secret could not be resolved.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('secret-unresolved');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['secret-unresolved']);
    expect(error.exitCode).toBe(2);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('environment variable is unset');
    const error = new SecretUnresolvedError('The requested secret could not be resolved.', { ref: '{{secrets.auth.password}}' }, { cause });

    expect(error.message).toBe('The requested secret could not be resolved.');
    expect(error.details).toEqual({ ref: '{{secrets.auth.password}}' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new SecretUnresolvedError('The requested secret could not be resolved.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
