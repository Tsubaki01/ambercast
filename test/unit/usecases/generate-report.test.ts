import { describe, expect, it } from 'vitest';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { AmbercastError } from '#core/errors/types.js';
import { buildGenerateReport, type GenerateReportInput } from '#usecases/generate-report.js';
import type { GenerateOutcome } from '#usecases/generate.js';

const BASE = {
  startedAt: '2026-08-08T00:00:00Z',
  durationMs: 42,
  options: { strict: false, dryRun: false, allowEmpty: false, list: false },
} as const;

function report(input: {
  readonly outcome?: Omit<GenerateOutcome, 'interrupted'> & { readonly interrupted?: boolean };
  readonly error?: AmbercastError;
  readonly options?: GenerateReportInput['options'];
}): ReturnType<typeof buildGenerateReport> {
  const outcome = 'outcome' in input && input.outcome !== undefined
    ? { ...input.outcome, interrupted: input.outcome.interrupted ?? false }
    : undefined;
  return buildGenerateReport({ ...BASE, ...input, ...(outcome === undefined ? {} : { outcome }) } as GenerateReportInput);
}

const GENERATION_ERROR_MAPPINGS = [
  [new TargetUnresolvedError('target missing'), 'TARGET_UNRESOLVED', 'usage', 2],
  [new SecretLiteralRejectedError('literal secret'), 'SECRET_LITERAL_REJECTED', 'usage', 2],
  [new SecretGrantUnattributableError('unattributable secret grant', {
    reason: 'citation-not-found',
    secretRef: '{{secrets.PAYMENT_TOKEN}}',
    stepId: 'complete-payment',
    hint: 'Correct the prompt citation.',
  }), 'SECRET_GRANT_UNATTRIBUTABLE', 'usage', 2],
  [new AiExecutorUnavailableError('provider unavailable'), 'AI_EXECUTOR_UNAVAILABLE', 'environment', 3],
  [new AiResponseInvalidError('invalid response'), 'AI_RESPONSE_INVALID', 'environment', 3],
  [new FsIoError('storage failed'), 'FS_IO_ERROR', 'environment', 3],
] as const;

describe('buildGenerateReport', () => {
  it('accounts generated, fresh, and would-generate files as passed; listed files as skipped; and failures as failed', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        interrupted: false,
        results: [
          { file: 'generated.test.md', status: 'generated', planFile: 'generated.ambercast.plan.json', ambiguities: [] },
          { file: 'fresh.test.md', status: 'skipped-fresh', planFile: 'fresh.ambercast.plan.json', ambiguities: [] },
          { file: 'preview.test.md', status: 'would-generate', planFile: 'preview.ambercast.plan.json', ambiguities: [] },
          { file: 'listed.test.md', status: 'listed' },
          { file: 'failed.test.md', status: 'failed', error: new FsIoError('read failed') },
        ],
      },
    });

    expect(output.envelope.summary).toEqual({ total: 5, passed: 3, failed: 0, errored: 1, skipped: 1 });
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
    const output = buildGenerateReport({ ...BASE, options, outcome: { noTestsFound: true, results: [], interrupted: false } });

    expect(output.exitCode).toBe(0);
  });

  it('selects the highest-priority exit code across all failed files regardless of order', () => {
    const results = [
      { file: 'first.test.md', status: 'failed' as const, error: new AiResponseInvalidError('first') },
      { file: 'second.test.md', status: 'failed' as const, error: new TargetUnresolvedError('second') },
    ];
    const output = report({
      outcome: {
        noTestsFound: false,
        results,
      },
    });
    const reversedOutput = report({
      outcome: { noTestsFound: false, results: [...results].reverse() },
    });

    expect(output.exitCode).toBe(2);
    expect(reversedOutput.exitCode).toBe(2);
  });

  it('lets a failed file outrank a disallowed zero-match outcome', () => {
    const output = report({
      outcome: {
        noTestsFound: true,
        results: [{ file: 'failed.test.md', status: 'failed', error: new AiResponseInvalidError('invalid response') }],
      },
    });

    expect(output.exitCode).toBe(3);
  });

  it('selects exit 3 over exit 4 across failed files regardless of order', () => {
    const results = [
      { file: 'environment.test.md', status: 'failed' as const, error: new AiResponseInvalidError('invalid response') },
      { file: 'artifact.test.md', status: 'failed' as const, error: new MissingPlanError('plan is missing') },
    ];
    const output = report({ outcome: { noTestsFound: false, results } });
    const reversedOutput = report({
      outcome: { noTestsFound: false, results: [...results].reverse() },
    });

    expect(output.exitCode).toBe(3);
    expect(reversedOutput.exitCode).toBe(3);
  });

  it('surfaces an unattributable secret grant from the first failed file with exit code 2', () => {
    const output = report({
      outcome: {
        noTestsFound: false,
        interrupted: false,
        results: [
          {
            file: 'first.test.md',
            status: 'failed',
            error: new SecretGrantUnattributableError('unattributable grant', {
              reason: 'citation-not-found',
              secretRef: '{{secrets.PAYMENT_TOKEN}}',
              stepId: 'complete-payment',
              hint: 'Correct the prompt citation.',
            }),
          },
          { file: 'second.test.md', status: 'failed', error: new AiResponseInvalidError('invalid response') },
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
        interrupted: false,
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
      interrupted: false,
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
      outcome: { noTestsFound: false, results: [result], interrupted: false },
    });

    expect(output.exitCode).toBe(status === 'failed' ? 3 : 0);
  });
});

describe('buildGenerateReport v3 interruption accounting', () => {
  it('adds one run-scoped interruption error, identity-only skipped rows, and exit 3 without inflating errored', () => {
    const output = report({ outcome: {
      noTestsFound: false,
      interrupted: true,
      results: [{ file: 'done.test.md', status: 'generated', planFile: 'done.plan.json', ambiguities: [] }, { file: 'pending.test.md', status: 'skipped' }],
    } } as unknown as Omit<GenerateReportInput, keyof typeof BASE>);

    expect(output.exitCode).toBe(3);
    expect(output.envelope.schemaVersion).toBe('3.0');
    expect(output.envelope.summary).toEqual({ total: 2, passed: 1, failed: 0, errored: 0, skipped: 1 });
    expect(output.envelope.errors).toEqual([expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' })]);
    expect(output.envelope.results[1]).toEqual({ id: 'pending.test.md', file: 'pending.test.md', status: 'skipped' });
  });

  it.each([
    ['usage 2', new TargetUnresolvedError('usage'), 2],
    ['artifact 4', new MissingPlanError('artifact'), 3],
    ['environment 3', new AiResponseInvalidError('environment'), 3],
    ['strict 1', undefined, 3],
    ['zero-match 5', undefined, 3],
    ['success 0', undefined, 3],
  ] as const)('emits exactly one run interruption error and applies 2/4/1/5/0 priority against %s', (_name, error, expectedExitCode) => {
    const output = report({
      options: _name === 'strict 1' ? { ...BASE.options, strict: true }
        : _name === 'zero-match 5' ? { ...BASE.options, allowEmpty: false }
          : BASE.options,
      outcome: {
        noTestsFound: _name === 'zero-match 5',
        interrupted: true,
        results: error === undefined
          ? (_name === 'strict 1'
            ? [{ file: 'strict.test.md', status: 'generated', planFile: 'strict.plan.json', ambiguities: ['ambiguous'] }]
            : [])
          : [{ file: 'error.test.md', status: 'failed', error }],
      },
    } as unknown as Omit<GenerateReportInput, keyof typeof BASE>);

    const interruptions = (output.envelope.errors as readonly { readonly code: string }[]).filter((entry) => entry.code === 'INTERRUPTED');
    expect(interruptions).toEqual([expect.objectContaining({ scope: 'run', kind: 'environment', code: 'INTERRUPTED' })]);
    expect(interruptions[0]).not.toHaveProperty('caseId');
    expect(output.exitCode).toBe(expectedExitCode);
  });

  it('promotes a failed result and its matching case error to one errored identity', () => {
    const output = report({ outcome: {
      noTestsFound: false,
      results: [{ file: 'same.test.md', status: 'failed', error: new FsIoError('read failed') }],
    } });

    expect(output.envelope.summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, skipped: 0 });
  });

  it('keeps every command-error envelope all-zero even when interruption-shaped fields are supplied', () => {
    const output = report({ error: new TargetUnresolvedError('invalid command') });
    expect(output.envelope.summary).toEqual({ total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 });
  });
});
