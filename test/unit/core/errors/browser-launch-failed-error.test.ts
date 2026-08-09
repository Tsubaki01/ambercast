import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES } from '#core/errors/exit-codes.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';

describe('BrowserLaunchFailedError', () => {
  it('constructs an Error with the fixed browser-launch-failed classification and mapped exit code', () => {
    const error = new BrowserLaunchFailedError('Chromium could not launch.');

    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('browser-launch-failed');
    expect(error.exitCode).toBe(ERROR_EXIT_CODES['browser-launch-failed']);
    expect(error.exitCode).toBe(3);
  });

  it('retains message, details, and cause', () => {
    const cause = new Error('browser executable not found');
    const error = new BrowserLaunchFailedError('Chromium could not launch.', { target: 'staging' }, { cause });

    expect(error.message).toBe('Chromium could not launch.');
    expect(error.details).toEqual({ target: 'staging' });
    expect(error.cause).toBe(cause);
  });

  it('allows optional details and cause to be omitted', () => {
    const error = new BrowserLaunchFailedError('Chromium could not launch.');

    expect(error.details).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });
});
