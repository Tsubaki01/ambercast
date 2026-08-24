import { describe, expect, it } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { AmbercastError } from '#core/errors/types.js';
import { CheckResult, ReportEnvelope } from '#report/schema.js';
import { buildCheckReport, type CheckReportInput } from '#usecases/check-report.js';
import type { CheckOutcome } from '#usecases/check.js';

const BASE = {
  startedAt: '2026-08-17T00:00:00Z',
  durationMs: 42,
  options: { allowEmpty: false, list: false },
} as const;

function result(status: CheckResult['status'], name = status): CheckResult {
  if (status === 'listed') {
    return { id: `${name}.test.md`, file: `${name}.test.md`, status };
  }
  if (status === 'invalid-artifact-name') {
    return {
      id: `${name}.ambercast.plan.json`,
      file: `${name}.ambercast.plan.json`,
      status,
      reason: `${status} fixture`,
      artifactFile: `${name}.ambercast.plan.json`,
    };
  }
  return {
    id: `${name}.test.md`,
    file: `${name}.test.md`,
    planFile: `${name}.ambercast.plan.json`,
    status,
    reason: `${status} fixture`,
  };
}

function report(input: {
  readonly outcome?: Omit<CheckOutcome, 'interrupted'> & { readonly interrupted?: boolean };
  readonly error?: AmbercastError;
  readonly options?: CheckReportInput['options'];
}): ReturnType<typeof buildCheckReport> {
  const outcome = 'outcome' in input && input.outcome !== undefined
    ? { ...input.outcome, interrupted: input.outcome.interrupted ?? false }
    : undefined;
  return buildCheckReport({ ...BASE, ...input, ...(outcome === undefined ? {} : { outcome }) } as CheckReportInput);
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

  it('returns exit 0 for listed-only discovery results', () => {
    const output = report({
      options: { allowEmpty: false, list: true },
      outcome: { noTestsFound: false, results: [result('listed')], errors: [] },
    });

    expect(output.exitCode).toBe(0);
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
      schemaVersion: '2.0',
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
    expect(output.envelope.summary.errored).toBe(1);
    expect(output.envelope.summary.total).toBe(2);
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
    expect(output.envelope.summary.errored).toBe(1);
    expect(output.envelope.summary.total).toBe(1);
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
    ['a defensively-suppressed zero match under list (not producible by check() itself)', 0, { noTestsFound: true, results: [], errors: [] }, { allowEmpty: false, list: true }],
  ] as const)('%s selects exit %i', (_name, exitCode, outcome, options) => {
    const output = buildCheckReport({ ...BASE, options, outcome: { ...outcome, interrupted: false } });

    expect(output.exitCode).toBe(exitCode);
  });

  it('makes the non-fresh and zero-results candidates mutually exclusive by outcome construction', () => {
    const nonFreshOutcome = { noTestsFound: false, results: [result('stale')], errors: [], interrupted: false };
    const zeroMatchOutcome = { noTestsFound: true, results: [], errors: [], interrupted: false };

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

describe('buildCheckReport v2 interruption accounting', () => {
  it('retains failed evidence for exit 4 while summary promotion and interruption select exit 3', () => {
    const output = report({ outcome: {
      noTestsFound: false, interrupted: true,
      results: [result('orphaned-grounding'), { id: 'orphaned-grounding.test.md', file: 'orphaned-grounding.test.md', status: 'skipped' }], errors: [],
    } } as unknown as Omit<CheckReportInput, keyof typeof BASE>);

    expect(output.exitCode).toBe(3);
    expect(output.envelope.schemaVersion).toBe('2.0');
    expect(output.envelope.summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 });
    expect(output.envelope.errors).toContainEqual(expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' }));
  });

  const exitOneError = new FsIoError('assertion-like candidate');
  Object.defineProperty(exitOneError, 'exitCode', { value: 1 });

  it.each([
    ['usage 2', { errors: [{ file: 'usage.test.md', error: new TargetUnresolvedError('usage') }], results: [], noTestsFound: false }, 2],
    ['integrity 4', { errors: [], results: [result('stale')], noTestsFound: false }, 3],
    ['assertion-like 1', { errors: [{ file: 'assertion.test.md', error: exitOneError }], results: [], noTestsFound: false }, 3],
    ['zero match 5', { errors: [], results: [], noTestsFound: true }, 3],
    ['success 0', { errors: [], results: [], noTestsFound: false }, 3],
  ] as const)('emits one run interruption error and pins 2/4/1/5/0 priority against %s', (_name, partialOutcome, expectedExitCode) => {
    const output = report({ outcome: { ...partialOutcome, interrupted: true } } as unknown as Omit<CheckReportInput, keyof typeof BASE>);
    const interruptions = (output.envelope.errors as readonly { readonly code: string }[]).filter((entry) => entry.code === 'INTERRUPTED');

    expect(interruptions).toEqual([expect.objectContaining({ scope: 'run', kind: 'environment', code: 'INTERRUPTED' })]);
    expect(interruptions[0]).not.toHaveProperty('caseId');
    expect(output.exitCode).toBe(expectedExitCode);
  });

  it('counts a case-error-only identity as one errored case', () => {
    const output = report({ outcome: {
      noTestsFound: false, results: [], errors: [{ file: 'broken.test.md', error: new FsIoError('broken') }],
    } });
    expect(output.envelope.summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, skipped: 0 });
  });

  it('keeps a command-error envelope all-zero', () => {
    expect(report({ error: new TargetUnresolvedError('invalid command') }).envelope.summary)
      .toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
  });
});
