import { describe, expect, expectTypeOf, it } from 'vitest';
import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import {
  AiExecutorUnavailableError,
  type AiProviderAvailabilityAttempt,
  type AiProviderName,
} from '#core/errors/ai-executor-unavailable-error.js';

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

    expect(error.message).toBe('The provider executable is unavailable.');
    expect(error.details).toEqual({ provider: 'codex' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new AiExecutorUnavailableError('The provider cannot serve this request.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('publishes the canonical provider vocabulary used by availability attempts and factories', () => {
    expectTypeOf<AiProviderName>().toEqualTypeOf<'claude' | 'codex'>();
    expectTypeOf<AiProviderAvailabilityAttempt['provider']>().toEqualTypeOf<AiProviderName>();
    expectTypeOf<keyof typeof AI_EXECUTOR_FACTORIES>().toEqualTypeOf<AiProviderName>();
  });
});
