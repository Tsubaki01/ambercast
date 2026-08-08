import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';

describe('TargetUnresolvedError', () => {
  it('constructs an Error with the fixed target-unresolved classification and mapped exit code', () => {
    const error = new TargetUnresolvedError('The requested target is not configured.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('target-unresolved');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['target-unresolved']);
    expect(error.exitCode).toBe(2);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('target lookup failed');
    const error = new TargetUnresolvedError('The requested target is not configured.', { target: 'staging' }, { cause });

    expect(error.details).toEqual({ target: 'staging' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new TargetUnresolvedError('No default target is configured.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
