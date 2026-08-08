import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';

describe('SecretLiteralRejectedError', () => {
  it('constructs an Error with the fixed secret-literal-rejected classification and mapped exit code', () => {
    const error = new SecretLiteralRejectedError('The generated plan contains a literal secret.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('secret-literal-rejected');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['secret-literal-rejected']);
    expect(error.exitCode).toBe(2);
  });

  it('retains safe detector details and cause', () => {
    const cause = new Error('detector matched');
    const details = { detector: 'credential-prefix-sk', path: 'generatorMeta.credentials[0]' };
    const error = new SecretLiteralRejectedError('The generated plan contains a literal secret.', details, { cause });

    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new SecretLiteralRejectedError('The generated plan contains a literal secret.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
