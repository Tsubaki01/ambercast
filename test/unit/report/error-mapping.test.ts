import { describe, expect, it } from 'vitest';
import { AmbercastError, type ErrorKind } from '#core/errors/types.js';
import * as errorMapping from '#report/error-mapping.js';

const EXPECTED_REPORT_ERROR_DETAILS = {
  'config-invalid': { kind: 'usage', code: 'CONFIG_INVALID' },
  'secret-unresolved': { kind: 'usage', code: 'SECRET_UNRESOLVED' },
  'target-unresolved': { kind: 'usage', code: 'TARGET_UNRESOLVED' },
  'secret-literal-rejected': { kind: 'usage', code: 'SECRET_LITERAL_REJECTED' },
  'missing-plan': { kind: 'usage', code: 'MISSING_PLAN' },
  'stale-ir': { kind: 'usage', code: 'STALE_PLAN' },
  'integrity-violation': { kind: 'usage', code: 'INTEGRITY_VIOLATION' },
  'browser-launch-failed': { kind: 'environment', code: 'BROWSER_LAUNCH_FAILED' },
  'ai-executor-unavailable': { kind: 'environment', code: 'AI_EXECUTOR_UNAVAILABLE' },
  'ai-response-invalid': { kind: 'environment', code: 'AI_RESPONSE_INVALID' },
  'fs-io-error': { kind: 'environment', code: 'FS_IO_ERROR' },
  'unexpected-crash': { kind: 'environment', code: 'UNEXPECTED_CRASH' },
} as const;

type ReportableErrorKind = keyof typeof EXPECTED_REPORT_ERROR_DETAILS;

const REPORTABLE_ERROR_DETAILS = Object.entries(EXPECTED_REPORT_ERROR_DETAILS) as ReadonlyArray<readonly [
  ReportableErrorKind,
  (typeof EXPECTED_REPORT_ERROR_DETAILS)[ReportableErrorKind],
]>;

class ClassifiedError extends AmbercastError {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

describe('REPORT_ERROR_DETAILS', () => {
  it('exports the complete stable ErrorKind-to-report-kind-and-code mapping', () => {
    expect(errorMapping.REPORT_ERROR_DETAILS).toEqual(EXPECTED_REPORT_ERROR_DETAILS);
  });
});

describe('reportError', () => {
  it.each(REPORTABLE_ERROR_DETAILS)('serializes a %s classified error at case scope', (kind, details) => {
    const error = new ClassifiedError(kind, `The ${kind} failure occurred.`);

    expect(errorMapping.reportError(error, { scope: 'case', caseId: 'login-succeeds' })).toEqual({
      scope: 'case',
      ...details,
      caseId: 'login-succeeds',
      message: error.message,
    });
  });

  it('serializes a classified error at run scope without a case identifier', () => {
    const error = new ClassifiedError('browser-launch-failed', 'Chromium could not launch.');

    expect(errorMapping.reportError(error, { scope: 'run' })).toEqual({
      scope: 'run',
      kind: 'environment',
      code: 'BROWSER_LAUNCH_FAILED',
      message: 'Chromium could not launch.',
    });
  });

  it('throws when an unmapped and unreportable assertion-failed error is serialized', () => {
    const error = new ClassifiedError('assertion-failed', 'The assertion did not hold.');

    expect(() => errorMapping.reportError(error, { scope: 'run' }))
      .toThrow('Error kind assertion-failed cannot be serialized as a report error.');
  });
});
