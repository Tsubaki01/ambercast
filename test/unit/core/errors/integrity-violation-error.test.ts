import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';

describe('IntegrityViolationError', () => {
  it('constructs an Error with the fixed integrity-violation classification and mapped exit code', () => {
    const error = new IntegrityViolationError('The plan artifact is not canonical.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('integrity-violation');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['integrity-violation']);
    expect(error.exitCode).toBe(4);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('unexpected key order');
    const error = new IntegrityViolationError('The plan artifact is not canonical.', { path: '/tests/login.ambercast.plan.json' }, { cause });

    expect(error.message).toBe('The plan artifact is not canonical.');
    expect(error.details).toEqual({ path: '/tests/login.ambercast.plan.json' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new IntegrityViolationError('The plan artifact is not canonical.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
