import { describe, expect, it } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { CheckResult, ReportEnvelope } from '#report/schema.js';
import { buildCheckReport, type CheckReportInput } from '#usecases/check-report.js';

const BASE = {
  startedAt: '2026-08-17T00:00:00Z',
  durationMs: 42,
  options: { allowEmpty: false, list: false },
} as const;

function result(status: CheckResult['status'], name = status): CheckResult {
  return {
    id: `${name}.test.md`,
    file: `${name}.test.md`,
    planFile: `${name}.ambercast.plan.json`,
    status,
    reason: `${status} fixture`,
  };
}

function report(input: Omit<CheckReportInput, keyof typeof BASE>): ReturnType<typeof buildCheckReport> {
  return buildCheckReport({ ...BASE, ...input } as CheckReportInput);
}

describe('buildCheckReport', () => {
  it.each([
    ['all fresh', [result('fresh')], { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }],
    ['all non-fresh', [result('stale'), result('missing-plan')], { total: 2, passed: 0, failed: 2, errored: 0, skipped: 0 }],
    [
      'mixed freshness states',
      [result('fresh'), result('stale'), result('orphaned-plan'), result('orphaned-grounding')],
      { total: 4, passed: 1, failed: 3, errored: 0, skipped: 0 },
    ],
  ] as const)('uses the check summary formula for %s', (_name, results, summary) => {
    const output = report({ outcome: { noTestsFound: false, results, errors: [] } });

    expect(output.envelope.summary).toEqual(summary);
  });

  it('round-trips complete check results through the full report-envelope schema', () => {
    const results = [
      result('fresh'),
      result('stale'),
      result('missing-plan'),
      result('orphaned-plan'),
      result('orphaned-grounding'),
    ];
    const output = report({ outcome: { noTestsFound: false, results, errors: [] } });

    expect(ReportEnvelope.parse(output.envelope)).toEqual({
      schemaVersion: '1.0',
      command: 'check',
      startedAt: BASE.startedAt,
      durationMs: BASE.durationMs,
      summary: { total: 5, passed: 1, failed: 4, errored: 0, skipped: 0 },
      errors: [],
      results,
    });
  });

  it('maps case-scoped filesystem errors using their file as the case identity', () => {
    const error = new FsIoError('could not read plan');
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [result('fresh')],
        errors: [{ file: 'broken.test.md', error }],
      },
    });

    expect(output.envelope.errors).toEqual([{
      scope: 'case',
      kind: 'environment',
      code: 'FS_IO_ERROR',
      caseId: 'broken.test.md',
      message: error.message,
    }]);
    expect(output.envelope.summary.errored).toBe(0);
    expect(output.envelope.summary.total).toBe(output.envelope.results.length);
  });

  it('keeps an errors-only outcome summary bound exclusively to result rows', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [],
        errors: [{ file: 'broken.test.md', error: new FsIoError('could not read plan') }],
      },
    });

    expect(output.envelope.errors).toEqual([expect.objectContaining({
      scope: 'case',
      code: 'FS_IO_ERROR',
      caseId: 'broken.test.md',
    })]);
    expect(output.envelope.summary.errored).toBe(0);
    expect(output.envelope.summary.total).toBe(output.envelope.results.length);
  });

  it('maps a top-level target error to a run-scoped empty report and exit 2', () => {
    const error = new TargetUnresolvedError('target does not exist');
    const output = report({ error });

    expect(output.exitCode).toBe(2);
    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toEqual([{
      scope: 'run',
      kind: 'usage',
      code: 'TARGET_UNRESOLVED',
      message: error.message,
    }]);
  });

  it.each([
    ['all fresh', 0, { noTestsFound: false, results: [result('fresh')], errors: [] }, BASE.options],
    ['a non-fresh result', 4, { noTestsFound: false, results: [result('stale')], errors: [] }, BASE.options],
    ['a disallowed genuine zero match', 5, { noTestsFound: true, results: [], errors: [] }, BASE.options],
    ['an allowed genuine zero match', 0, { noTestsFound: true, results: [], errors: [] }, { allowEmpty: true, list: false }],
    ['a listed genuine zero match', 0, { noTestsFound: true, results: [], errors: [] }, { allowEmpty: false, list: true }],
  ] as const)('%s selects exit %i', (_name, exitCode, outcome, options) => {
    const output = buildCheckReport({ ...BASE, options, outcome });

    expect(output.exitCode).toBe(exitCode);
  });

  it('makes the non-fresh and zero-results candidates mutually exclusive by outcome construction', () => {
    const nonFreshOutcome = { noTestsFound: false, results: [result('stale')], errors: [] };
    const zeroMatchOutcome = { noTestsFound: true, results: [], errors: [] };

    expect(nonFreshOutcome.results).not.toHaveLength(0);
    expect(zeroMatchOutcome.results).toHaveLength(0);
    expect(buildCheckReport({ ...BASE, outcome: nonFreshOutcome }).exitCode).toBe(4);
    expect(buildCheckReport({ ...BASE, outcome: zeroMatchOutcome }).exitCode).toBe(5);
  });

  it('lets a case-scoped filesystem error outrank two non-fresh exit-4 candidates', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [result('stale'), result('missing-plan')],
        errors: [{ file: 'broken.test.md', error: new FsIoError('read failed') }],
      },
    });

    expect(output.exitCode).toBe(3);
  });

  it('lets a case-scoped filesystem error outrank a simultaneously applicable zero-match exit-5 candidate', () => {
    const output = report({
      outcome: {
        noTestsFound: true,
        results: [],
        errors: [{ file: 'broken.test.md', error: new FsIoError('read failed') }],
      },
    });

    expect(output.exitCode).toBe(3);
  });
});
