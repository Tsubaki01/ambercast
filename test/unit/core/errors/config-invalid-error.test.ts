import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';

describe('ConfigInvalidError', () => {
  it('constructs an Error with the fixed config-invalid classification and mapped exit code', () => {
    const error = new ConfigInvalidError('Configuration is invalid.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('config-invalid');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['config-invalid']);
    expect(error.exitCode).toBe(2);
  });

  it('retains its message, details, and Error-constructor cause', () => {
    const cause = new Error('The configuration file was malformed.');
    const details = { path: 'ambercast.config.json', field: 'viewer.port' };
    const error = new ConfigInvalidError('Configuration is invalid.', details, { cause });

    expect(error.message).toBe('Configuration is invalid.');
    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new ConfigInvalidError('Configuration is invalid.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
