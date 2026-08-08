import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';

describe('AiResponseInvalidError', () => {
  it('constructs an Error with the fixed ai-response-invalid classification and mapped exit code', () => {
    const error = new AiResponseInvalidError('The provider returned invalid JSON.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('ai-response-invalid');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['ai-response-invalid']);
    expect(error.exitCode).toBe(3);
  });

  it('retains raw response validation details and cause', () => {
    const cause = new SyntaxError('Unexpected end of JSON input');
    const details = { raw: '{', issues: [{ path: '', message: cause.message }] };
    const error = new AiResponseInvalidError('The provider returned invalid JSON.', details, { cause });

    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new AiResponseInvalidError('The response did not satisfy its schema.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
