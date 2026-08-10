import { describe, expect, it } from 'vitest';
import { ERROR_EXIT_CODES, type ErrorExitCode } from '../../../src/core/errors/exit-codes.js';
import type { ErrorKind } from '../../../src/core/errors/types.js';
import { ReportError, ReportErrorCode } from '../../../src/report/schema.js';

interface SchemaUnderTest {
  safeParse(value: unknown): { success: boolean };
}

type ReportErrorKind = 'usage' | 'environment';

interface ErrorCodeCorrespondence {
  readonly errorKind: ErrorKind;
  readonly reportCode: string;
  readonly exitCode: ErrorExitCode;
  readonly reportKind: ReportErrorKind;
}

const ERROR_CODE_CORRESPONDENCE = [
  { errorKind: 'config-invalid', reportCode: 'CONFIG_INVALID', exitCode: 2, reportKind: 'usage' },
  { errorKind: 'secret-unresolved', reportCode: 'SECRET_UNRESOLVED', exitCode: 2, reportKind: 'usage' },
  { errorKind: 'target-unresolved', reportCode: 'TARGET_UNRESOLVED', exitCode: 2, reportKind: 'usage' },
  { errorKind: 'secret-literal-rejected', reportCode: 'SECRET_LITERAL_REJECTED', exitCode: 2, reportKind: 'usage' },
  { errorKind: 'secret-ref-undeclared', reportCode: 'SECRET_REF_UNDECLARED', exitCode: 2, reportKind: 'usage' },
  { errorKind: 'missing-plan', reportCode: 'MISSING_PLAN', exitCode: 4, reportKind: 'usage' },
  { errorKind: 'stale-ir', reportCode: 'STALE_PLAN', exitCode: 4, reportKind: 'usage' },
  { errorKind: 'integrity-violation', reportCode: 'INTEGRITY_VIOLATION', exitCode: 4, reportKind: 'usage' },
  { errorKind: 'browser-launch-failed', reportCode: 'BROWSER_LAUNCH_FAILED', exitCode: 3, reportKind: 'environment' },
  { errorKind: 'ai-executor-unavailable', reportCode: 'AI_EXECUTOR_UNAVAILABLE', exitCode: 3, reportKind: 'environment' },
  { errorKind: 'ai-response-invalid', reportCode: 'AI_RESPONSE_INVALID', exitCode: 3, reportKind: 'environment' },
  { errorKind: 'fs-io-error', reportCode: 'FS_IO_ERROR', exitCode: 3, reportKind: 'environment' },
  { errorKind: 'unexpected-crash', reportCode: 'UNEXPECTED_CRASH', exitCode: 3, reportKind: 'environment' },
] as const satisfies readonly ErrorCodeCorrespondence[];

const REPORTABLE_ERROR_KINDS = [
  'config-invalid',
  'secret-unresolved',
  'target-unresolved',
  'secret-literal-rejected',
  'secret-ref-undeclared',
  'missing-plan',
  'stale-ir',
  'integrity-violation',
  'browser-launch-failed',
  'ai-executor-unavailable',
  'ai-response-invalid',
  'fs-io-error',
  'unexpected-crash',
] as const satisfies readonly ErrorKind[];

function expectAccepted(schema: SchemaUnderTest, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

describe('ErrorKind and ReportErrorCode correspondence', () => {
  it.each(ERROR_CODE_CORRESPONDENCE)('maps $errorKind to $reportCode with its documented exit code', ({ errorKind, exitCode }) => {
    expect(ERROR_EXIT_CODES[errorKind]).toBe(exitCode);
  });

  it('keeps assertion-failed and no-tests-found out of the correspondence table', () => {
    const mappedKinds = ERROR_CODE_CORRESPONDENCE.map(({ errorKind }) => errorKind);

    expect(mappedKinds).not.toContain('assertion-failed');
    expect(mappedKinds).not.toContain('no-tests-found');
  });

  it('covers every ReportErrorCode and reportable ErrorKind exactly once', () => {
    const mappedCodes = ERROR_CODE_CORRESPONDENCE.map(({ reportCode }) => reportCode);
    const mappedKinds = ERROR_CODE_CORRESPONDENCE.map(({ errorKind }) => errorKind);

    expect(new Set(mappedCodes).size).toBe(ERROR_CODE_CORRESPONDENCE.length);
    expect(new Set(mappedCodes)).toStrictEqual(new Set(ReportErrorCode.options));
    expect(new Set(mappedKinds).size).toBe(REPORTABLE_ERROR_KINDS.length);
    expect(new Set(mappedKinds)).toStrictEqual(new Set(REPORTABLE_ERROR_KINDS));
  });

  it.each(ERROR_CODE_CORRESPONDENCE)('accepts $reportCode through both ReportError scopes', ({ reportCode, reportKind }) => {
    expectAccepted(ReportError, {
      scope: 'run',
      kind: reportKind,
      code: reportCode,
      message: 'The command encountered a classified error.',
    });
    expectAccepted(ReportError, {
      scope: 'case',
      kind: reportKind,
      code: reportCode,
      message: 'The test case encountered a classified error.',
      caseId: 'login-succeeds',
    });
  });
});
