import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';

describe('MissingPlanError', () => {
  it('constructs an Error with the fixed missing-plan classification and mapped exit code', () => {
    const error = new MissingPlanError('The generated plan artifact is missing.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('missing-plan');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['missing-plan']);
    expect(error.exitCode).toBe(4);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('ENOENT');
    const error = new MissingPlanError('The generated plan artifact is missing.', { path: '/tests/login.ambercast.plan.json' }, { cause });

    expect(error.message).toBe('The generated plan artifact is missing.');
    expect(error.details).toEqual({ path: '/tests/login.ambercast.plan.json' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new MissingPlanError('The generated plan artifact is missing.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
