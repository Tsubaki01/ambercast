import { describe, expect, it } from 'vitest';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { buildGenerateReport, type GenerateReportInput } from '#usecases/generate-report.js';

const BASE = {
  startedAt: '2026-08-08T00:00:00Z',
  durationMs: 42,
  options: { strict: false, dryRun: false, allowEmpty: false, list: false },
} as const;

function report(input: Omit<GenerateReportInput, keyof typeof BASE>): ReturnType<typeof buildGenerateReport> {
  return buildGenerateReport({ ...BASE, ...input } as GenerateReportInput);
}

const GENERATION_ERROR_MAPPINGS = [
  [new TargetUnresolvedError('target missing'), 'TARGET_UNRESOLVED', 'usage', 2],
  [new SecretLiteralRejectedError('literal secret'), 'SECRET_LITERAL_REJECTED', 'usage', 2],
  [new AiExecutorUnavailableError('provider unavailable'), 'AI_EXECUTOR_UNAVAILABLE', 'environment', 3],
  [new AiResponseInvalidError('invalid response'), 'AI_RESPONSE_INVALID', 'environment', 3],
  [new FsIoError('storage failed'), 'FS_IO_ERROR', 'environment', 3],
] as const;

describe('buildGenerateReport', () => {
  it('accounts generated, fresh, previewed, and listed files as passed while failures are failed', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          { file: 'generated.test.md', status: 'generated', planFile: 'generated.ambercast.plan.json', ambiguities: [] },
          { file: 'fresh.test.md', status: 'skipped-fresh', planFile: 'fresh.ambercast.plan.json', ambiguities: [] },
          { file: 'preview.test.md', status: 'would-generate', planFile: 'preview.ambercast.plan.json', ambiguities: [] },
          { file: 'listed.test.md', status: 'listed' },
          { file: 'failed.test.md', status: 'failed', error: new FsIoError('read failed') },
        ],
      },
    });

    expect(output.envelope.summary).toEqual({ total: 5, passed: 4, failed: 1, errored: 0, skipped: 0 });
    expect(output.envelope.results.map((result) => result.status)).toEqual([
      'generated', 'skipped-fresh', 'would-generate', 'listed', 'failed',
    ]);
  });

  it.each(GENERATION_ERROR_MAPPINGS)(
    'maps generation-reachable $0.kind errors to %s',
    (error, code, kind, exitCode) => {
      const output = report({
        outcome: {
          noTestsFound: false,
          results: [{ file: 'login.test.md', status: 'failed', error }],
        },
      });

      expect(output.exitCode).toBe(exitCode);
      expect(output.envelope.errors).toEqual([{
        scope: 'case',
        kind,
        code,
        caseId: 'login.test.md',
        message: error.message,
      }]);
      expect(output.envelope.results[0]).toEqual({
        id: 'login.test.md',
        file: 'login.test.md',
        status: 'failed',
        dryRun: false,
      });
    },
  );

  it('serializes a top-level classified error as one run-scoped error with no results', () => {
    const output = report({ error: new TargetUnresolvedError('target missing') });

    expect(output.exitCode).toBe(2);
    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toEqual([{
      scope: 'run',
      kind: 'usage',
      code: 'TARGET_UNRESOLVED',
      message: 'target missing',
    }]);
  });

  it('gives a top-level error precedence over genuinely competing completed-outcome conditions', () => {
    const output = buildGenerateReport({
      ...BASE,
      error: new TargetUnresolvedError('target missing'),
      outcome: {
        noTestsFound: true,
        results: [{
          file: 'failed.test.md',
          status: 'failed',
          error: new AiResponseInvalidError('would otherwise select exit 3'),
        }, {
          file: 'ambiguous.test.md',
          status: 'generated',
          planFile: 'ambiguous.ambercast.plan.json',
          ambiguities: ['would otherwise select exit 1'],
        }],
      },
      options: { ...BASE.options, strict: true },
    } as unknown as GenerateReportInput);

    expect(output.exitCode).toBe(2);
    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toHaveLength(1);
  });

  it('selects exit 5 with an error-free zero summary for a disallowed zero-match outcome', () => {
    const output = report({ outcome: { noTestsFound: true, results: [] } });

    expect(output.exitCode).toBe(5);
    expect(output.envelope.summary).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
    expect(output.envelope.errors).toEqual([]);
  });

  it.each([
    ['allow-empty', { strict: false, dryRun: false, allowEmpty: true, list: false }],
    ['list', { strict: false, dryRun: false, allowEmpty: false, list: true }],
  ] as const)('keeps a zero-match %s outcome successful', (_description, options) => {
    const output = buildGenerateReport({ ...BASE, options, outcome: { noTestsFound: true, results: [] } });

    expect(output.exitCode).toBe(0);
  });

  it('uses the first failed file in deterministic result order when failures have different exit codes', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          { file: 'first.test.md', status: 'failed', error: new TargetUnresolvedError('first') },
          { file: 'second.test.md', status: 'failed', error: new AiResponseInvalidError('second') },
        ],
      },
    });

    expect(output.exitCode).toBe(2);
  });

  it('uses unexpected-crash when a failed outcome has no classified error', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [{ file: 'failed.test.md', status: 'failed' }],
      },
    });

    expect(output.exitCode).toBe(3);
  });

  it('emits one ordered case-scoped error for every failed file', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        results: [
          { file: 'first.test.md', status: 'failed', error: new TargetUnresolvedError('first failure') },
          { file: 'second.test.md', status: 'failed', error: new AiResponseInvalidError('second failure') },
        ],
      },
    });

    expect(output.envelope.errors).toEqual([
      expect.objectContaining({ scope: 'case', caseId: 'first.test.md', code: 'TARGET_UNRESOLVED' }),
      expect.objectContaining({ scope: 'case', caseId: 'second.test.md', code: 'AI_RESPONSE_INVALID' }),
    ]);
  });

  it('lets a failed file take precedence over strict ambiguities', () => {
    const output = buildGenerateReport({
      ...BASE,
      options: { ...BASE.options, strict: true },
      outcome: {
        noTestsFound: false,
        results: [
          { file: 'failed.test.md', status: 'failed', error: new AiResponseInvalidError('invalid response') },
          { file: 'ambiguous.test.md', status: 'generated', planFile: 'ambiguous.ambercast.plan.json', ambiguities: ['unclear'] },
        ],
      },
    });

    expect(output.exitCode).toBe(3);
  });

  it.each(['generated', 'would-generate'] as const)('escalates ambiguities on %s results only in strict mode', (status) => {
    const outcome = {
      noTestsFound: false,
      results: [{ file: 'login.test.md', status, planFile: 'login.ambercast.plan.json', ambiguities: ['unclear'] }],
    };

    expect(buildGenerateReport({ ...BASE, outcome }).exitCode).toBe(0);
    expect(buildGenerateReport({ ...BASE, options: { ...BASE.options, strict: true }, outcome }).exitCode).toBe(1);
  });

  it.each(['skipped-fresh', 'listed', 'failed'] as const)('ignores ambiguity-shaped data on a %s result for exit policy', (status) => {
    const result = status === 'failed'
      ? { file: 'login.test.md', status, error: new AiResponseInvalidError('failed'), ambiguities: ['ignored'] }
      : status === 'listed'
        ? { file: 'login.test.md', status, ambiguities: ['ignored'] }
        : { file: 'login.test.md', status, planFile: 'login.ambercast.plan.json', ambiguities: ['ignored'] };
    const output = buildGenerateReport({
      ...BASE,
      options: { ...BASE.options, strict: true },
      outcome: { noTestsFound: false, results: [result] },
    });

    expect(output.exitCode).toBe(status === 'failed' ? 3 : 0);
  });
});
