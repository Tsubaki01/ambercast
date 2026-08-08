import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { FsIoError } from '#core/errors/fs-io-error.js';

describe('FsIoError', () => {
  it('constructs an Error with the fixed fs-io-error classification and mapped exit code', () => {
    const error = new FsIoError('Could not write the plan.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('fs-io-error');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['fs-io-error']);
    expect(error.exitCode).toBe(3);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('disk full');
    const error = new FsIoError('Could not write the plan.', { path: '/tests/login.ambercast.plan.json' }, { cause });

    expect(error.message).toBe('Could not write the plan.');
    expect(error.details).toEqual({ path: '/tests/login.ambercast.plan.json' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new FsIoError('Could not read the prompt.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
