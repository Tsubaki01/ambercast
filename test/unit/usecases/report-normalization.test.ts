import { describe, expect, it } from 'vitest';
import { normalizeReportEnvelope } from '#usecases/report-normalization.js';
import type { ReportEnvelope } from '#report/schema.js';

const ROOT = '/repo';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '2.0', command: 'check', startedAt: '2026-08-01T00:00:00Z', durationMs: 1,
    summary: { total: 2, passed: 0, failed: 2, errored: 0, skipped: 0 }, errors: [],
    results: [{
      id: '/repo/tests/a.test.md', file: '/repo/tests/a.test.md', planFile: '/repo/tests/a.ambercast.plan.json',
      groundingFile: '/repo/tests/a.ambercast.grounding.json', artifactFile: '/outside/a.json', status: 'orphaned-grounding',
      reason: 'No corresponding test file exists for this grounding artifact.',
    }],
    ...overrides,
  } as unknown as ReportEnvelope;
}

describe('normalizeReportEnvelope', () => {
  it.each([
    ['id', '/repo/tests/a.test.md', 'tests/a.test.md'],
    ['file', '/repo/tests/a.test.md', 'tests/a.test.md'],
    ['planFile', '/repo/tests/a.ambercast.plan.json', 'tests/a.ambercast.plan.json'],
    ['caseId', '/repo/tests/a.test.md', 'tests/a.test.md'],
    ['groundingFile', '/repo/tests/a.ambercast.grounding.json', 'tests/a.ambercast.grounding.json'],
    ['artifactFile', '/repo/tests/a.artifact.json', 'tests/a.artifact.json'],
  ] as const)('normalizes only the approved %s identity field inside project root', (field, absolute, relative) => {
    const input = envelope({
      results: [{ id: 'outside-id', file: 'outside-file', planFile: 'outside-plan', status: 'stale', reason: 'unchanged', [field]: absolute }],
      errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'unchanged', caseId: 'outside-case', [field]: absolute }],
    });

    const normalized = normalizeReportEnvelope(input, ROOT) as unknown as {
      results: readonly Record<string, unknown>[];
      errors: readonly Record<string, unknown>[];
    };
    const owner = field === 'caseId' ? normalized.errors[0] : normalized.results[0];

    expect(owner?.[field]).toBe(relative);
    expect(normalized.results[0]?.reason).toBe('unchanged');
    expect(normalized.errors[0]?.message).toBe('unchanged');
  });

  it('copies only the six identity fields and is immutable and idempotent', () => {
    const input = envelope({ errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: '/repo/message', caseId: '/repo/tests/a.test.md' }] });
    const normalized = normalizeReportEnvelope(input, ROOT);

    expect(normalized).not.toBe(input);
    expect(normalized.results[0]).toMatchObject({
      id: 'tests/a.test.md', file: 'tests/a.test.md', planFile: 'tests/a.ambercast.plan.json', groundingFile: 'tests/a.ambercast.grounding.json', artifactFile: '/outside/a.json',
      reason: 'No corresponding test file exists for this grounding artifact.',
    });
    expect(normalized.errors[0]).toMatchObject({ caseId: 'tests/a.test.md', message: '/repo/message' });
    expect(input.results[0]).toMatchObject({ id: '/repo/tests/a.test.md' });
    expect(normalizeReportEnvelope(normalized, ROOT)).toEqual(normalized);
  });

  it('leaves hints, step evidence, screenshots, and review concerns byte-identical', () => {
    const runInput = envelope({
      command: 'run',
      results: [{
        id: '/repo/tests/a.test.md', file: '/repo/tests/a.test.md', planFile: '/repo/tests/a.ambercast.plan.json',
        status: 'passed', durationMs: 42, explanation: 'The evidence is unchanged.',
        steps: [{
          id: 'assert-dashboard', type: 'assert', status: 'passed', screenshot: '/repo/screenshots/dashboard.png',
          observed: { note: 'Observed text /repo is evidence, not a path field.', accessibilitySnapshot: '- heading "Dashboard"' },
        }],
      }],
      errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'Read failed.', hint: 'Retry from /repo if the storage service recovers.', caseId: '/repo/tests/a.test.md' }],
    });
    const reviewInput = envelope({
      command: 'review',
      results: [{
        id: '/repo/tests/a.test.md', file: '/repo/tests/a.test.md', planFile: '/repo/tests/a.ambercast.plan.json',
        status: 'sufficient', concerns: [{ stepId: 'assert-dashboard', concern: 'The screenshot /repo needs no change.', suggestion: 'Keep the existing assertion.' }],
      }],
    });

    const normalizedRun = normalizeReportEnvelope(runInput, ROOT);
    const normalizedReview = normalizeReportEnvelope(reviewInput, ROOT);
    const runResult = runInput.results[0] as unknown as Record<string, unknown>;
    const normalizedRunResult = normalizedRun.results[0] as unknown as Record<string, unknown>;
    const reviewResult = reviewInput.results[0] as unknown as Record<string, unknown>;
    const normalizedReviewResult = normalizedReview.results[0] as unknown as Record<string, unknown>;

    expect(JSON.stringify(normalizedRunResult.steps)).toBe(JSON.stringify(runResult.steps));
    expect(JSON.stringify(normalizedRun.errors[0]?.hint)).toBe(JSON.stringify(runInput.errors[0]?.hint));
    expect(JSON.stringify(normalizedReviewResult.concerns)).toBe(JSON.stringify(reviewResult.concerns));
  });

  it('retains root-equal, blank, malformed, outside-root, and absent optional values unchanged', () => {
    const input = envelope({ results: [{
      id: '/repo', file: '', planFile: '  ', status: 'stale', reason: 'unchanged',
    }] });

    expect(normalizeReportEnvelope(input, ROOT).results[0]).toMatchObject({ id: '/repo', file: '', planFile: '  ' });
  });

  it.each(['generate', 'run', 'check', 'heal', 'review'] as const)(
    'normalizes every approved identity field across %s path-boundary inputs without rewriting unrelated text',
    (command) => {
      const fields = ['id', 'file', 'planFile', 'caseId', 'groundingFile', 'artifactFile'] as const;
      const pathCases = [
        ['inside', '/repo/tests/a.test.md', 'tests/a.test.md'],
        ['outside', '/outside/a.test.md', '/outside/a.test.md'],
        ['root-equal', '/repo', '/repo'],
        ['already-relative', 'tests/a.test.md', 'tests/a.test.md'],
        ['malformed', '\0not-a-path', '\0not-a-path'],
        ['blank', '  ', '  '],
      ] as const;

      for (const field of fields) {
        for (const [_name, value, expected] of pathCases) {
          const input = envelope({
            command,
            results: [{
              id: 'unchanged-id', file: 'unchanged-file', planFile: 'unchanged-plan',
              status: command === 'check' ? 'stale' : command === 'heal' ? 'unresolved' : command === 'review' ? 'insufficient' : 'failed',
              reason: 'reason /repo must not change', explanation: 'explanation /repo must not change',
              [field]: value,
            }],
            errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'message /repo must not change', caseId: 'unchanged-case', [field]: value }],
          });
          const normalized = normalizeReportEnvelope(input, ROOT) as unknown as {
            results: readonly Record<string, unknown>[]; errors: readonly Record<string, unknown>[];
          };
          const owner = field === 'caseId' ? normalized.errors[0] : normalized.results[0];

          expect(owner?.[field]).toBe(expected);
          expect(normalized.results[0]?.reason).toBe('reason /repo must not change');
          expect(normalized.errors[0]?.message).toBe('message /repo must not change');
        }

        const optionalAbsent = envelope({
          command,
          results: [{ id: 'case', file: 'case.test.md', planFile: 'case.plan.json', status: command === 'check' ? 'stale' : command === 'heal' ? 'unresolved' : command === 'review' ? 'insufficient' : 'failed' }],
          errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'unchanged', caseId: 'case' }],
        });
        const normalizedAbsent = normalizeReportEnvelope(optionalAbsent, ROOT) as unknown as {
          results: readonly Record<string, unknown>[]; errors: readonly Record<string, unknown>[];
        };
        const absentOwner = field === 'caseId' ? normalizedAbsent.errors[0] : normalizedAbsent.results[0];
        if (field === 'groundingFile' || field === 'artifactFile') {
          expect(absentOwner).not.toHaveProperty(field);
        }
      }
    },
  );

  it('recomputes promotion after normalization collapses identities', () => {
    const input = envelope({
      results: [
        { id: '/repo/tests/a.test.md', file: '/repo/tests/a.test.md', status: 'stale', reason: 'stale' },
        { id: 'tests/a.test.md', file: 'tests/a.test.md', status: 'skipped' },
      ],
      errors: [{ scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', message: 'failed', caseId: '/repo/tests/a.test.md' }],
    });

    expect(normalizeReportEnvelope(input, ROOT).summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, skipped: 0 });
  });

  it('collapses a normalized failed and skipped pair to one skipped identity without a case error', () => {
    const input = envelope({
      results: [
        { id: '/repo/tests/a.test.md', file: '/repo/tests/a.test.md', status: 'stale', reason: 'stale' },
        { id: 'tests/a.test.md', file: 'tests/a.test.md', status: 'skipped' },
      ],
    });

    expect(normalizeReportEnvelope(input, ROOT).summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 });
  });

  it('copies an empty run-error envelope and recomputes its stale summary', () => {
    const input = envelope({
      results: [],
      errors: [{ scope: 'run', kind: 'environment', code: 'INTERRUPTED', message: 'stopped' }],
      summary: { total: 9, passed: 2, failed: 3, errored: 4, skipped: 0 },
    });

    const normalized = normalizeReportEnvelope(input, ROOT);

    expect(normalized).not.toBe(input);
    expect(normalized.errors).not.toBe(input.errors);
    expect(normalized.summary).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
  });

  it.each([
    ['in-root', '/repo/tests/deleted.ambercast.grounding.json', 'tests/deleted.ambercast.grounding.json'],
    ['outside-root', '/outside/deleted.ambercast.grounding.json', '/outside/deleted.ambercast.grounding.json'],
  ] as const)('normalizes orphan-grounding artifact identity only for %s paths', (_name, groundingFile, expected) => {
    const normalized = normalizeReportEnvelope(envelope({
      results: [{
        id: '/repo/tests/deleted.test.md', file: '/repo/tests/deleted.test.md', planFile: '/repo/tests/deleted.ambercast.plan.json',
        groundingFile, status: 'orphaned-grounding', reason: 'No corresponding test file exists for this grounding artifact.',
      }],
    }), ROOT);

    expect(normalized.results[0]).toMatchObject({
      id: 'tests/deleted.test.md', file: 'tests/deleted.test.md', planFile: 'tests/deleted.ambercast.plan.json',
      groundingFile: expected, reason: 'No corresponding test file exists for this grounding artifact.',
    });
    expect((normalized.results[0] as unknown as { readonly reason?: string } | undefined)?.reason).not.toContain(groundingFile);
  });
});
