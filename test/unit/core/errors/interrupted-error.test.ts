import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { InterruptedError } from '#core/errors/interrupted-error.js';
import { AmbercastError } from '#core/errors/types.js';

describe('InterruptedError', () => {
  it('is the fixed run-level interruption diagnostic mapped through the central exit table', () => {
    const error = new InterruptedError();

    expect(error).toBeInstanceOf(AmbercastError);
    expect(error.message).toBe('The command was interrupted before all discovered cases reached a terminal state.');
    expect(error.kind).toBe('interrupted');
    expect((ERROR_EXIT_CODES as Record<string, number>).interrupted).toBe(3);
    expect(error.exitCode).toBe(3);
  });

  it('does not accept caller-controlled message or details arguments', () => {
    expect(InterruptedError.length).toBe(0);
  });
});
