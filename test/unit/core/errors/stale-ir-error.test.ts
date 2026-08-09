import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';

describe('StaleIrError', () => {
  it('constructs an Error with the fixed stale-ir classification and mapped exit code', () => {
    const error = new StaleIrError('The generated plan no longer matches its prompt inputs.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('stale-ir');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['stale-ir']);
    expect(error.exitCode).toBe(4);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('inputs digest mismatch');
    const error = new StaleIrError('The generated plan no longer matches its prompt inputs.', { path: '/tests/login.ambercast.plan.json' }, { cause });

    expect(error.message).toBe('The generated plan no longer matches its prompt inputs.');
    expect(error.details).toEqual({ path: '/tests/login.ambercast.plan.json' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new StaleIrError('The generated plan no longer matches its prompt inputs.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
