import { describe, expect, it } from 'vitest';
import { summarizeReport, type ReportSummaryInput } from '#report/summarize.js';

const EMPTY = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };

function summary(command: string, statuses: readonly string[], errors: readonly unknown[] = []) {
  return summarizeReport({
    command,
    results: statuses.map((status, index) => {
      const identity = { id: `case-${index}`, file: `case-${index}.test.md`, status };
      if (command === 'check' && status === 'listed') return identity;
      if (command === 'check' && status === 'invalid-artifact-name') {
        return { ...identity, reason: 'completed', artifactFile: `case-${index}.ambercast.plan.json` };
      }
      return {
        ...identity,
        planFile: `case-${index}.ambercast.plan.json`,
        dryRun: false,
        durationMs: 1,
        steps: [],
        explanation: 'completed',
        reason: 'completed',
        concerns: [],
      };
    }),
    errors,
  } as unknown as ReportSummaryInput);
}

describe('summarizeReport', () => {
  it.each([
    ['generate', 'generated', 'passed'],
    ['generate', 'would-generate', 'passed'],
    ['generate', 'skipped-fresh', 'passed'],
    ['generate', 'failed', 'failed'],
    ['generate', 'listed', 'skipped'],
    ['generate', 'skipped', 'skipped'],
    ['run', 'passed', 'passed'],
    ['run', 'failed', 'failed'],
    ['run', 'error', 'errored'],
    ['run', 'listed', 'skipped'],
    ['run', 'skipped', 'skipped'],
    ['check', 'fresh', 'passed'],
    ['check', 'fresh-without-grounding', 'passed'],
    ['check', 'stale', 'failed'],
    ['check', 'missing-plan', 'failed'],
    ['check', 'missing-grounding', 'failed'],
    ['check', 'stale-grounding', 'failed'],
    ['check', 'invalid-grounding', 'failed'],
    ['check', 'orphaned-plan', 'failed'],
    ['check', 'orphaned-grounding', 'failed'],
    ['check', 'invalid-artifact-name', 'failed'],
    ['check', 'listed', 'skipped'],
    ['check', 'skipped', 'skipped'],
    ['heal', 'healed', 'passed'],
    ['heal', 'no-changes-needed', 'passed'],
    ['heal', 'partially-healed', 'failed'],
    ['heal', 'unresolved', 'failed'],
    ['heal', 'skipped', 'skipped'],
    ['review', 'sufficient', 'passed'],
    ['review', 'insufficient', 'failed'],
    ['review', 'skipped', 'skipped'],
  ] as const)('classifies %s/%s as %s', (command, status, classification) => {
    expect(summary(command, [status])).toEqual({
      total: 1,
      passed: Number(classification === 'passed'),
      failed: Number(classification === 'failed'),
      errored: Number(classification === 'errored'),
      skipped: Number(classification === 'skipped'),
    });
  });

  it('deduplicates every valid run classification pair and promotes it monotonically in forward order', () => {
    const classifications = ['passed', 'failed', 'skipped', 'errored'] as const;
    const statusFor = { passed: 'passed', failed: 'failed', skipped: 'listed', errored: 'error' } as const;

    for (const first of classifications) {
      for (const second of classifications) {
        const rows = [statusFor[first], statusFor[second]].map((status) => ({
          id: 'same', file: 'same.test.md', status,
        }));
        const input = { command: 'run', results: rows, errors: [] } as unknown as ReportSummaryInput;
        const expected = classifications.indexOf(first) > classifications.indexOf(second) ? first : second;

        expect(summarizeReport(input)).toEqual({
          total: 1,
          passed: Number(expected === 'passed'),
          failed: Number(expected === 'failed'),
          errored: Number(expected === 'errored'),
          skipped: Number(expected === 'skipped'),
        });
      }
    }
  });

  it('deduplicates every valid run classification pair and promotes it monotonically in reverse order', () => {
    const classifications = ['passed', 'failed', 'skipped', 'errored'] as const;
    const statusFor = { passed: 'passed', failed: 'failed', skipped: 'listed', errored: 'error' } as const;

    for (const first of classifications) {
      for (const second of classifications) {
        const rows = [statusFor[second], statusFor[first]].map((status) => ({
          id: 'same', file: 'same.test.md', status,
        }));
        const expected = classifications.indexOf(first) > classifications.indexOf(second) ? first : second;

        expect(summarizeReport({ command: 'run', results: rows, errors: [] } as unknown as ReportSummaryInput)).toEqual({
          total: 1,
          passed: Number(expected === 'passed'),
          failed: Number(expected === 'failed'),
          errored: Number(expected === 'errored'),
          skipped: Number(expected === 'skipped'),
        });
      }
    }
  });

  it('counts case errors without results, ignores run errors, and leaves a no-test report empty', () => {
    expect(summarizeReport({
      command: 'check', results: [], errors: [
        { scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'case', caseId: 'same' },
        { scope: 'run', kind: 'environment', code: 'INTERRUPTED', message: 'run' },
      ],
    } as unknown as ReportSummaryInput)).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, skipped: 0 });
    expect(summary('run', [])).toEqual(EMPTY);
  });
});
