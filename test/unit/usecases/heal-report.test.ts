import { describe, expect, it } from 'vitest';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import type { AmbercastError } from '#core/errors/types.js';
import { buildHealReport, type HealReportInput } from '#usecases/heal-report.js';
import type { HealCaseOutcome, HealOutcome } from '#usecases/heal.js';

const BASE = {
  startedAt: '2026-08-25T00:00:00Z',
  durationMs: 3.6,
  options: { allowEmpty: false, list: false },
} as const;

function healed(status: HealCaseOutcome['status'] = 'healed', error?: AmbercastError): HealCaseOutcome {
  return {
    id: 'login.test.md', file: 'login.test.md', planFile: 'login.ambercast.plan.json', status,
    steps: [], explanation: `The case is ${status}.`, durationMs: 1.6, dryRun: false,
    baselineReachedIndex: 0, finalReachedIndex: status === 'healed' ? 1 : 0,
    stage3Error: error, finalReplayError: undefined,
  };
}

function outcome(overrides: Partial<HealOutcome> = {}): HealOutcome {
  return { results: [healed()], errors: [], noTestsFound: false, listed: [], skipped: [], interrupted: false, ...overrides };
}

function report(input: { readonly outcome?: HealOutcome; readonly error?: AmbercastError; readonly options?: HealReportInput['options'] }) {
  return buildHealReport({ ...BASE, ...input } as HealReportInput);
}

describe('buildHealReport', () => {
  it('serializes a completed healed candidate without exposing internal stages or progress indices', () => {
    const output = report({ outcome: outcome() });

    expect(output.exitCode).toBe(0);
    expect(output.envelope.results).toEqual([expect.objectContaining({ status: 'healed', dryRun: false })]);
    expect(JSON.stringify(output.envelope)).not.toContain('ReachedIndex');
    expect(JSON.stringify(output.envelope)).not.toContain('stage3');
  });

  it.each(['partially-healed', 'unresolved'] as const)('classifies %s as an exit-1 healing failure', (status) => {
    expect(report({ outcome: outcome({ results: [healed(status)] }) }).exitCode).toBe(1);
  });

  it('uses stage3Error and finalReplayError in normal exit-code priority selection', () => {
    const output = report({ outcome: outcome({ results: [{ ...healed('unresolved'), stage3Error: new AiExecutorUnavailableError('offline'), finalReplayError: new FsIoError('evidence failed') }] }) });

    expect(output.exitCode).toBe(3);
  });

  it('maps preflight failures into case-scoped report errors rather than repair results', () => {
    const output = report({ outcome: outcome({ results: [], errors: [{ file: 'broken.test.md', error: new MissingPlanError('missing plan') }] }) });

    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toEqual([expect.objectContaining({ scope: 'case', caseId: 'broken.test.md', code: 'MISSING_PLAN' })]);
    expect(output.exitCode).toBe(4);
  });

  it('renders listed and interruption-skipped identities as non-executed rows', () => {
    const output = report({ outcome: outcome({ results: [], listed: [{ file: 'listed.test.md' }], skipped: [{ file: 'later.test.md' }] }) });

    expect(output.envelope.results).toEqual([
      { id: 'listed.test.md', file: 'listed.test.md', status: 'listed' },
      { id: 'later.test.md', file: 'later.test.md', status: 'skipped' },
    ]);
  });

  it('adds one run-scoped interruption error without inventing a case identity', () => {
    const output = report({ outcome: outcome({ interrupted: true }) });

    expect(output.envelope.errors).toEqual([expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' })]);
    expect(output.exitCode).toBe(3);
  });

  it('uses empty-selection policy and list mode in the shared exit-code table', () => {
    expect(report({ outcome: outcome({ results: [], noTestsFound: true }) }).exitCode).toBe(5);
    expect(report({ options: { allowEmpty: true, list: false }, outcome: outcome({ results: [], noTestsFound: true }) }).exitCode).toBe(0);
    expect(report({ options: { allowEmpty: false, list: true }, outcome: outcome({ results: [], noTestsFound: true }) }).exitCode).toBe(0);
  });

  it('passes through the command-normalized integer duration unchanged', () => {
    const output = buildHealReport({ ...BASE, durationMs: 4, outcome: outcome() });

    expect(output.envelope.durationMs).toBe(4);
  });

  it('preserves dry-run reporting while keeping report construction independent of commit capabilities', () => {
    const output = report({ outcome: outcome({ results: [{ ...healed(), dryRun: true }] }) });

    expect(output.envelope.results[0]).toMatchObject({ status: 'healed', dryRun: true });
  });

  it('turns a command-scoped classified error into an all-zero run error report', () => {
    const output = report({ error: new FsIoError('cannot discover tests') });

    expect(output.exitCode).toBe(3);
    expect(output.envelope.results).toEqual([]);
    expect(output.envelope.errors).toEqual([expect.objectContaining({ scope: 'run', code: 'FS_IO_ERROR' })]);
  });
});
