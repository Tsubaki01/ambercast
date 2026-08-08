import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES, type ErrorExitCode } from '../../../../src/core/errors/exit-codes.js';
import type { ErrorKind } from '../../../../src/core/errors/types.js';

const ALL_ERROR_KINDS = [
  'assertion-failed',
  'config-invalid',
  'secret-unresolved',
  'target-unresolved',
  'secret-literal-rejected',
  'missing-plan',
  'stale-ir',
  'integrity-violation',
  'browser-launch-failed',
  'ai-executor-unavailable',
  'ai-response-invalid',
  'fs-io-error',
  'unexpected-crash',
  'no-tests-found',
] as const satisfies readonly ErrorKind[];

function assertNever(value: never): never {
  throw new Error(`Unexpected error kind: ${value}`);
}

/**
 * Deliberately independent from the production table so a future weakening of
 * its `satisfies` clause cannot also weaken this exhaustiveness check.
 */
function exitCodeFor(kind: ErrorKind): ErrorExitCode {
  switch (kind) {
    case 'assertion-failed':
      return 1;
    case 'config-invalid':
    case 'secret-unresolved':
    case 'target-unresolved':
    case 'secret-literal-rejected':
      return 2;
    case 'browser-launch-failed':
    case 'ai-executor-unavailable':
    case 'ai-response-invalid':
    case 'fs-io-error':
    case 'unexpected-crash':
      return 3;
    case 'missing-plan':
    case 'stale-ir':
    case 'integrity-violation':
      return 4;
    case 'no-tests-found':
      return 5;
    default:
      return assertNever(kind);
  }
}

describe('ERROR_EXIT_CODES', () => {
  it('matches the independently authored exhaustive exit-code switch for every error kind', () => {
    for (const kind of ALL_ERROR_KINDS) {
      expect(ERROR_EXIT_CODES[kind]).toBe(exitCodeFor(kind));
    }

    expect(new Set(ALL_ERROR_KINDS)).toStrictEqual(new Set(Object.keys(ERROR_EXIT_CODES)));
  });

  it('contains only non-success exit statuses in the documented range', () => {
    for (const value of Object.values(ERROR_EXIT_CODES)) {
      expect([1, 2, 3, 4, 5]).toContain(value);
    }
  });
});
