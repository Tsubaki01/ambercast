import { describe, expect, it } from 'vitest';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import { SecretUnresolvedError } from '#core/errors/secret-unresolved-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { AmbercastError } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import type { RunResult } from '#report/schema.js';
import { buildRunReport, type RunReportInput } from '#usecases/run-report.js';
import type { RunCaseOutcome } from '#usecases/run.js';

const BASE = {
  startedAt: '2026-08-08T00:00:00Z',
  durationMs: 42,
} as const;

function report(input: Omit<RunReportInput, keyof typeof BASE>): ReturnType<typeof buildRunReport> {
  return buildRunReport({ ...BASE, ...input } as RunReportInput);
}

function caseOutcome(
  status: RunResult['status'],
  id: string,
  error?: AmbercastError,
): RunCaseOutcome {
  return {
    result: {
      id,
      file: id,
      planFile: `${id}.ambercast.plan.json`,
      status,
      durationMs: 7,
      steps: [],
      explanation: `The ${id} case ${status}.`,
    },
    ...(error === undefined ? {} : { error }),
  };
}

const REPORTABLE_CASE_ERROR_MAPPINGS = [
  ['config-invalid', new ConfigInvalidError('configuration is invalid'), 'CONFIG_INVALID', 'usage', 2],
  ['secret-unresolved', new SecretUnresolvedError('secret is unavailable'), 'SECRET_UNRESOLVED', 'usage', 2],
  ['target-unresolved', new TargetUnresolvedError('target is unavailable'), 'TARGET_UNRESOLVED', 'usage', 2],
  ['secret-literal-rejected', new SecretLiteralRejectedError('literal secret is forbidden'), 'SECRET_LITERAL_REJECTED', 'usage', 2],
  ['missing-plan', new MissingPlanError('plan is missing'), 'MISSING_PLAN', 'usage', 4],
  ['stale-ir', new StaleIrError('plan is stale'), 'STALE_PLAN', 'usage', 4],
  ['integrity-violation', new IntegrityViolationError('plan integrity failed'), 'INTEGRITY_VIOLATION', 'usage', 4],
  ['browser-launch-failed', new BrowserLaunchFailedError('browser did not launch'), 'BROWSER_LAUNCH_FAILED', 'environment', 3],
  ['ai-executor-unavailable', new AiExecutorUnavailableError('AI executor is unavailable'), 'AI_EXECUTOR_UNAVAILABLE', 'environment', 3],
  ['ai-response-invalid', new AiResponseInvalidError('AI response is invalid'), 'AI_RESPONSE_INVALID', 'environment', 3],
  ['fs-io-error', new FsIoError('filesystem failed'), 'FS_IO_ERROR', 'environment', 3],
  ['unexpected-crash', new UnexpectedCrashError('process crashed'), 'UNEXPECTED_CRASH', 'environment', 3],
] as const;

const PRIORITY_PAIRS = [
  ['usage error over an exit-4 artifact error', [
    caseOutcome('error', 'usage.test.md', new SecretUnresolvedError('secret is unavailable')),
    caseOutcome('error', 'artifact.test.md', new MissingPlanError('plan is missing')),
  ], 2],
  ['usage error over an environment error', [
    caseOutcome('error', 'usage.test.md', new TargetUnresolvedError('target is unavailable')),
    caseOutcome('error', 'environment.test.md', new BrowserLaunchFailedError('browser did not launch')),
  ], 2],
  ['usage error over a case-abort stopgap', [
    caseOutcome('error', 'usage.test.md', new SecretLiteralRejectedError('literal secret is forbidden')),
    caseOutcome('error', 'stopgap.test.md'),
  ], 2],
  ['usage error over a failed assertion', [
    caseOutcome('error', 'usage.test.md', new ConfigInvalidError('configuration is invalid')),
    caseOutcome('failed', 'assertion.test.md'),
  ], 2],
  ['an exit-4 artifact error over an environment error', [
    caseOutcome('error', 'artifact.test.md', new StaleIrError('plan is stale')),
    caseOutcome('error', 'environment.test.md', new FsIoError('filesystem failed')),
  ], 4],
  ['an exit-4 artifact error over a case-abort stopgap', [
    caseOutcome('error', 'artifact.test.md', new IntegrityViolationError('plan integrity failed')),
    caseOutcome('error', 'stopgap.test.md'),
  ], 4],
  ['an exit-4 artifact error over a failed assertion', [
    caseOutcome('error', 'artifact.test.md', new MissingPlanError('plan is missing')),
    caseOutcome('failed', 'assertion.test.md'),
  ], 4],
  ['an environment error and a case-abort stopgap in the same exit-3 bucket', [
    caseOutcome('error', 'environment.test.md', new AiResponseInvalidError('AI response is invalid')),
    caseOutcome('error', 'stopgap.test.md'),
  ], 3],
  ['an environment error over a failed assertion', [
    caseOutcome('error', 'environment.test.md', new AiExecutorUnavailableError('AI executor is unavailable')),
    caseOutcome('failed', 'assertion.test.md'),
  ], 3],
  ['a case-abort stopgap over a failed assertion', [
    caseOutcome('error', 'stopgap.test.md'),
    caseOutcome('failed', 'assertion.test.md'),
  ], 3],
] as const;

describe('buildRunReport', () => {
  it.each(REPORTABLE_CASE_ERROR_MAPPINGS)(
    'serializes a case-scoped %s error',
    (_errorKind, error, code, kind, exitCode) => {
      const outcome = caseOutcome('error', 'login.test.md', error);
      const output = report({ outcome: { noTestsFound: false, results: [outcome] } });

      expect(output.exitCode).toBe(exitCode);
      expect(output.envelope.results).toEqual([outcome.result]);
      expect(output.envelope.errors).toEqual([{
        scope: 'case',
        kind,
        code,
        caseId: 'login.test.md',
        message: error.message,
      }]);
    },
  );

  it.each(PRIORITY_PAIRS)(
    'selects the declared priority for %s regardless of result order',
    (description, results, exitCode) => {
      const output = report({ outcome: { noTestsFound: false, results } });
      const reversedOutput = report({ outcome: { noTestsFound: false, results: [...results].reverse() } });

      expect(output.exitCode, description).toBe(exitCode);
      expect(reversedOutput.exitCode, description).toBe(exitCode);
    },
  );

  it('selects exit 3 for a batch containing only case-abort stopgaps with no errors entries', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          caseOutcome('error', 'grounding-miss.test.md'),
          caseOutcome('error', 'unsupported-reference.test.md'),
          caseOutcome('error', 'browser-session-stopgap.test.md'),
        ],
      },
    });

    expect(output.exitCode).toBe(3);
    expect(output.envelope.errors).toEqual([]);
    expect(output.envelope.results.map((result) => result.status)).toEqual(['error', 'error', 'error']);
  });

  it('short-circuits a top-level classified error with its own exit code and a run-scoped error', () => {
    const output = buildRunReport({
      ...BASE,
      error: new ConfigInvalidError('configuration could not load'),
      outcome: {
        noTestsFound: false,
        results: [caseOutcome('error', 'environment.test.md', new BrowserLaunchFailedError('would otherwise select exit 3'))],
      },
    } as unknown as RunReportInput);

    expect(output.exitCode).toBe(2);
    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toEqual([{
      scope: 'run',
      kind: 'usage',
      code: 'CONFIG_INVALID',
      message: 'configuration could not load',
    }]);
  });

  it('selects exit 0 for an all-pass batch', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          caseOutcome('passed', 'login.test.md'),
          caseOutcome('passed', 'checkout.test.md'),
        ],
      },
    });

    expect(output.exitCode).toBe(0);
    expect(output.envelope.errors).toEqual([]);
  });

  it('selects exit 5 for a no-tests-found outcome without another condition', () => {
    const output = report({ outcome: { noTestsFound: true, results: [] } });

    expect(output.exitCode).toBe(5);
    expect(output.envelope.summary).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
    expect(output.envelope.errors).toEqual([]);
  });

  it('counts every run status in the summary, including non-zero errored cases', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          caseOutcome('passed', 'passed.test.md'),
          caseOutcome('failed', 'failed.test.md'),
          caseOutcome('error', 'errored.test.md', new BrowserLaunchFailedError('browser did not launch')),
          caseOutcome('skipped', 'skipped.test.md'),
        ],
      },
    });

    expect(output.envelope.summary).toEqual({ total: 4, passed: 1, failed: 1, errored: 1, skipped: 1 });
    expect(output.envelope.results.map((result) => result.status)).toEqual(['passed', 'failed', 'error', 'skipped']);
  });
});
