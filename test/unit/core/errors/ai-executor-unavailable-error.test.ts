import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';

describe('AiExecutorUnavailableError', () => {
  it('constructs an Error with the fixed ai-executor-unavailable classification and mapped exit code', () => {
    const error = new AiExecutorUnavailableError('The provider executable is unavailable.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('ai-executor-unavailable');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['ai-executor-unavailable']);
    expect(error.exitCode).toBe(3);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('ENOENT');
    const error = new AiExecutorUnavailableError('The provider executable is unavailable.', { provider: 'codex' }, { cause });

    expect(error.details).toEqual({ provider: 'codex' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new AiExecutorUnavailableError('The provider cannot serve this request.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
