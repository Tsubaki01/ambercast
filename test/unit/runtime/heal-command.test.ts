import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '#core/config/schema.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { ReportEnvelope } from '#report/schema.js';
import { runHealCommand, type HealCommandInput, type HealCommandOutput } from '#runtime/heal-command.js';
import type { HealBatchResult, HealCaseCommit, HealCaseOutcome, HealCommitOutcome, HealOutcome } from '#usecases/heal.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const mocks = vi.hoisted(() => ({
  createFsStorage: vi.fn(), createSystemClock: vi.fn(), createProcessEnvironmentInfo: vi.fn(),
  createTtyInteractivityCheck: vi.fn(), createConfirmationAnswerReader: vi.fn(), loadConfig: vi.fn(), createAmbercast: vi.fn(),
  heal: vi.fn(), buildHealReport: vi.fn(), finalizeReportEnvelope: vi.fn(), isEmergencyFinalizedEnvelope: vi.fn(),
}));

vi.mock('#adapters/storage/fs-storage.js', () => ({ createFsStorage: mocks.createFsStorage }));
vi.mock('#adapters/system/process-environment-info.js', () => ({ createProcessEnvironmentInfo: mocks.createProcessEnvironmentInfo }));
vi.mock('#adapters/system/system-clock.js', () => ({ createSystemClock: mocks.createSystemClock }));
vi.mock('#adapters/system/tty-interactivity.js', () => ({ createTtyInteractivityCheck: mocks.createTtyInteractivityCheck }));
vi.mock('#adapters/system/confirmation-answer-reader.js', () => ({ createConfirmationAnswerReader: mocks.createConfirmationAnswerReader }));
vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#runtime/create-ambercast.js', () => ({ createAmbercast: mocks.createAmbercast }));
vi.mock('#usecases/heal.js', async (importOriginal) => ({ ...await importOriginal<typeof import('#usecases/heal.js')>(), heal: mocks.heal }));
vi.mock('#usecases/heal-report.js', async (importOriginal) => ({ ...await importOriginal<typeof import('#usecases/heal-report.js')>(), buildHealReport: mocks.buildHealReport }));
vi.mock('#usecases/report-finalization.js', () => ({
  finalizeReportEnvelope: mocks.finalizeReportEnvelope,
  isEmergencyFinalizedEnvelope: mocks.isEmergencyFinalizedEnvelope,
}));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests', runsDir: '/workspace/tests/.runs', projectRoot: '/workspace',
  testMatch: ['**/*.test.md'], testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } }, defaultTarget: 'web',
  ai: { provider: 'auto', timeoutMs: 120_000 }, viewer: { port: 4600 },
  ci: { heal: true, updateGroundingCache: false }, grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
};

const rawEnvelopeForFinalizedBoundary = {} as ReportEnvelope;
// @ts-expect-error A real command output cannot expose an unfinalized envelope.
const rawHealCommandOutput: HealCommandOutput = { exitCode: 0, envelope: rawEnvelopeForFinalizedBoundary };
void rawHealCommandOutput;

function input(overrides: Partial<HealCommandInput> = {}): HealCommandInput {
  return { files: [], dryRun: false, yes: false, allowEmpty: false, list: false, cwd: '/workspace', ...overrides };
}
function report(exitCode: HealCommandOutput['exitCode']): HealCommandOutput {
  return { exitCode, envelope: { schemaVersion: '3.0', command: 'heal', startedAt: '2026-08-25T00:00:00Z', durationMs: 1, summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }, errors: [], results: [] } } as unknown as HealCommandOutput;
}
function reportWithExecutionEvidence(root: string): HealCommandOutput {
  return {
    exitCode: 1,
    envelope: {
      schemaVersion: '3.0', command: 'heal', startedAt: '2026-08-25T00:00:00Z', durationMs: 1,
      summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 },
      errors: [{
        scope: 'case', kind: 'environment', code: 'FS_IO_ERROR',
        caseId: `${root}/tests/login.test.md`,
        message: 'The grounding artifact could not be read.',
      }],
      results: [{
        id: `${root}/tests/login.test.md`,
        file: `${root}/tests/login.test.md`,
        planFile: `${root}/tests/login.ambercast.plan.json`,
        status: 'completed', repairOutcome: 'unresolved', application: 'no-artifact-change', stopReason: 'settled',
        steps: [{
          id: 'capture', type: 'capture', status: 'passed',
          screenshot: `${root}/tests/.runs/evidence.png`,
        }],
        explanation: 'The candidate did not repair the case.',
        durationMs: 1.6,
      }],
    },
  } as unknown as HealCommandOutput;
}
function caseResult(id: string, overrides: Partial<HealCaseOutcome> = {}): HealCaseOutcome {
  const file = `/workspace/tests/${id}`;
  return { id: file, file, planFile: `/workspace/tests/${id}.ambercast.plan.json`, repairOutcome: 'healed', steps: [], explanation: 'The candidate repaired the case.', durationMs: 1.6, baselineReachedIndex: 0, finalReachedIndex: 1, stage3Error: undefined, finalReplayError: undefined, ...overrides };
}
function outcome(overrides: Partial<HealOutcome> = {}): HealOutcome {
  return { results: [caseResult('login.test.md')], errors: [], noTestsFound: false, listed: [], skipped: [], interrupted: false, ...overrides };
}
function capability(id: string, result: HealCommitOutcome = { outcome: 'committed' }): HealCaseCommit {
  return { file: `/workspace/tests/${id}`, planFile: `/workspace/tests/${id}.ambercast.plan.json`, healingSummary: `Repair ${id}`, commit: vi.fn(async () => result) };
}
function commits(...candidates: readonly HealCaseCommit[]): Map<string, HealCaseCommit> {
  return new Map(candidates.map((candidate) => [candidate.file, candidate]));
}
function batch(overrides: Partial<HealBatchResult> = {}): HealBatchResult {
  const base = outcome();
  return { outcome: base, commits: commits(capability('login.test.md')), ...overrides };
}
function configure({ result = batch(), isCI = false, interactive = false, readConfirmationAnswer = vi.fn(async () => 'declined' as const), config = CONFIG, built = report(0), monotonic = [10, 12.6] }: {
  result?: HealBatchResult; isCI?: boolean; interactive?: boolean; readConfirmationAnswer?: (commits: ReadonlyMap<string, HealCaseCommit>, signal?: AbortSignal) => Promise<'authorized' | 'declined' | 'interrupted'>; config?: ResolvedConfig; built?: HealCommandOutput; monotonic?: readonly number[];
} = {}): void {
  const storage = createInMemoryStorage();
  mocks.createFsStorage.mockReturnValue(storage);
  mocks.createSystemClock.mockReturnValue({ now: () => new Date('2026-08-25T00:00:00.000Z'), monotonicMs: vi.fn().mockReturnValueOnce(monotonic[0] ?? 10).mockReturnValue(monotonic[1] ?? 12.6) });
  mocks.createProcessEnvironmentInfo.mockReturnValue({ isCI: vi.fn(() => isCI) });
  mocks.createTtyInteractivityCheck.mockReturnValue(vi.fn(() => interactive));
  mocks.createConfirmationAnswerReader.mockReturnValue(readConfirmationAnswer);
  mocks.loadConfig.mockResolvedValue(config);
  mocks.createAmbercast.mockReturnValue({ storage, layout: {}, clock: createFixedClock(new Date('2026-08-25T00:00:00.000Z'), 1), discoverTestFiles: vi.fn(async () => []) });
  mocks.heal.mockResolvedValue(result);
  mocks.buildHealReport.mockReturnValue(built);
}

async function useActualBuildHealReport(): Promise<void> {
  const { buildHealReport } = await vi.importActual<typeof import('#usecases/heal-report.js')>('#usecases/heal-report.js');
  mocks.buildHealReport.mockImplementation(buildHealReport);
}
afterEach(() => vi.resetAllMocks());
beforeEach(async () => {
  configure();
  const actual = await vi.importActual<typeof import('#usecases/report-finalization.js')>(
    '#usecases/report-finalization.js',
  );
  mocks.finalizeReportEnvelope.mockImplementation(actual.finalizeReportEnvelope);
  mocks.isEmergencyFinalizedEnvelope.mockImplementation(actual.isEmergencyFinalizedEnvelope);
});

describe('runHealCommand', () => {
  it.each([['non-interactive', false], ['interactive but undeclined', true]] as const)('lets --list exit zero before disabled ci.heal in a %s environment', async (_name, interactive) => {
    const listed = batch({ outcome: outcome({ results: [], listed: [{ file: '/workspace/tests/login.test.md' }] }), commits: new Map() });
    const readConfirmationAnswer = vi.fn(async (_commits: ReadonlyMap<string, HealCaseCommit>) => 'authorized' as const);
    configure({ result: listed, isCI: true, interactive, readConfirmationAnswer, config: { ...CONFIG, ci: { ...CONFIG.ci, heal: false } } });
    await expect(runHealCommand(input({ list: true }))).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.heal).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ list: true }));
    expect(mocks.createTtyInteractivityCheck).not.toHaveBeenCalled();
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ outcome: listed.outcome }));
  });

  it('refuses a non-list CI invocation when ci.heal is disabled without calling heal', async () => {
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ isCI: true, readConfirmationAnswer, config: { ...CONFIG, ci: { ...CONFIG.ci, heal: false } }, built: report(2) });
    await expect(runHealCommand(input())).resolves.toMatchObject({ exitCode: 2 });
    expect(mocks.heal).not.toHaveBeenCalled();
    expect(mocks.createTtyInteractivityCheck).not.toHaveBeenCalled();
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ConfigInvalidError) }));
  });

  it.each([
    [0, 'healed outcome', outcome(), commits(capability('login.test.md'))],
    [1, 'unresolved outcome', outcome({ results: [caseResult('unresolved.test.md', { repairOutcome: 'unresolved' })] }), new Map()],
    [2, 'configuration error', outcome({ results: [], errors: [{ file: '/workspace/tests/config.test.md', error: new ConfigInvalidError('invalid') }] }), new Map()],
    [3, 'stage 3 browser error', outcome({ results: [caseResult('stage3.test.md', { repairOutcome: 'unresolved', stage3Error: new BrowserLaunchFailedError('browser unavailable') })] }), new Map()],
    [4, 'final replay integrity error', outcome({ results: [caseResult('replay.test.md', { repairOutcome: 'unresolved', finalReplayError: new MissingPlanError('plan missing') })] }), new Map()],
    [5, 'disallowed empty selection', outcome({ results: [], noTestsFound: true }), new Map()],
  ] as const)('forwards buildHealReport\'s preselected exit %i for %s without reimplementing selection', async (exitCode, _name, healingOutcome, pendingCommits) => {
    configure({ result: batch({ outcome: healingOutcome, commits: pendingCommits }), built: report(exitCode) });
    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode });
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        errors: healingOutcome.errors,
        noTestsFound: healingOutcome.noTestsFound,
      }),
    }));
  });

  it('forwards a stage3Error value to buildHealReport unchanged', async () => {
    const stage3Error = new BrowserLaunchFailedError('browser unavailable');
    const healingOutcome = outcome({ results: [caseResult('stage3.test.md', { repairOutcome: 'unresolved', stage3Error })] });
    configure({ result: batch({ outcome: healingOutcome, commits: new Map() }), built: report(3) });
    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode: 3 });
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ stage3Error, application: 'no-artifact-change', stopReason: 'settled' })],
      }),
    }));
  });

  it.each([['ordinary dry run', false], ['--dry-run --yes no-op', true]] as const)('never prompts or commits during %s', async (_name, yes) => {
    const pending = capability('login.test.md');
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ result: batch({ commits: commits(pending) }), readConfirmationAnswer });
    await expect(runHealCommand(input({ dryRun: true, yes }))).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.createTtyInteractivityCheck).not.toHaveBeenCalled();
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ application: 'preview-only', stopReason: 'settled' })],
      }),
    }));
  });

  it('settles a partially-healed dry-run as preview-only', async () => {
    const pending = capability('partial-preview.test.md');
    const partial = outcome({ results: [caseResult('partial-preview.test.md', { repairOutcome: 'partially-healed', durationMs: 1 })] });
    configure({ result: batch({ outcome: partial, commits: commits(pending) }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ dryRun: true }))).resolves.toMatchObject({
      exitCode: 1,
      envelope: expect.objectContaining({
        results: [expect.objectContaining({ repairOutcome: 'partially-healed', application: 'preview-only' })],
      }),
    });
    expect(pending.commit).not.toHaveBeenCalled();
  });

  it('settles a partially-healed authorized commit as applied', async () => {
    const pending = capability('partial-committed.test.md');
    const partial = outcome({ results: [caseResult('partial-committed.test.md', { repairOutcome: 'partially-healed', durationMs: 1 })] });
    configure({ result: batch({ outcome: partial, commits: commits(pending) }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({
      exitCode: 1,
      envelope: expect.objectContaining({
        results: [expect.objectContaining({ repairOutcome: 'partially-healed', application: 'applied' })],
      }),
    });
    expect(pending.commit).toHaveBeenCalledOnce();
  });

  it('settles a partially-healed confirmation interruption without committing', async () => {
    const healedPending = capability('healed-interrupted.test.md');
    const partialPending = capability('partial-interrupted.test.md');
    const partial = outcome({ results: [
      caseResult('healed-interrupted.test.md', { durationMs: 1 }),
      caseResult('partial-interrupted.test.md', { repairOutcome: 'partially-healed', durationMs: 1 }),
    ] });
    configure({ result: batch({ outcome: partial, commits: commits(healedPending, partialPending) }), interactive: true, readConfirmationAnswer: vi.fn(async () => 'interrupted' as const) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input())).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        summary: expect.objectContaining({ total: 2, failed: 2 }),
        results: [
          expect.objectContaining({ repairOutcome: 'healed', application: 'not-applied-interrupted' }),
          expect.objectContaining({ repairOutcome: 'partially-healed', application: 'not-applied-interrupted' }),
        ],
        errors: [expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' })],
      }),
    });
    expect(healedPending.commit).not.toHaveBeenCalled();
    expect(partialPending.commit).not.toHaveBeenCalled();
  });

  it('honors the already-parsed yes field as pre-authorization without TTY consultation', async () => {
    const pending = capability('login.test.md');
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ result: batch({ commits: commits(pending) }), readConfirmationAnswer });
    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.createTtyInteractivityCheck).not.toHaveBeenCalled();
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(pending.commit).toHaveBeenCalledOnce();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ application: 'applied', stopReason: 'settled' })],
      }),
    }));
  });

  it('refuses an unconfirmed non-interactive invocation without committing', async () => {
    const pending = capability('login.test.md');
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ result: batch({ commits: commits(pending) }), readConfirmationAnswer, built: report(2) });
    await expect(runHealCommand(input())).resolves.toMatchObject({ exitCode: 2 });
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ConfigInvalidError) }));
  });

  it.each([
    ['CI', true],
    ['non-CI non-interactive', false],
  ] as const)('refuses an aborted unconfirmed %s invocation after healing finishes', async (_name, isCI) => {
    const pending = capability('login.test.md');
    const controller = new AbortController();
    let resolveHeal!: (result: HealBatchResult) => void;
    const pendingHeal = new Promise<HealBatchResult>((resolve) => {
      resolveHeal = resolve;
    });
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({
      isCI,
      result: batch({ commits: commits(pending) }),
      readConfirmationAnswer,
      built: report(2),
    });
    mocks.heal.mockImplementationOnce(async () => pendingHeal);

    const command = runHealCommand(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(mocks.heal).toHaveBeenCalledOnce());
    controller.abort();
    resolveHeal(batch({ commits: commits(pending) }));

    await expect(command).resolves.toMatchObject({ exitCode: 2 });
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ConfigInvalidError) }));
  });

  it('commits every pending candidate after an interactive affirmative answer and reports the settled outcome', async () => {
    const first = capability('first.test.md');
    const second = capability('second.test.md');
    const healed = outcome({ results: [caseResult('first.test.md'), caseResult('second.test.md')] });
    const built = report(0);
    const readConfirmationAnswer = vi.fn(async (_commits: ReadonlyMap<string, HealCaseCommit>) => 'authorized' as const);
    configure({
      result: batch({ outcome: healed, commits: commits(first, second) }),
      interactive: true,
      readConfirmationAnswer,
      built,
    });

    await expect(runHealCommand(input())).resolves.toEqual(built);
    expect(readConfirmationAnswer).toHaveBeenCalledOnce();
    const candidates = readConfirmationAnswer.mock.calls[0]?.[0];
    expect(candidates?.size).toBe(2);
    expect([...candidates!.entries()]).toEqual([
      ['/workspace/tests/first.test.md', { file: '/workspace/tests/first.test.md', healingSummary: 'Repair first.test.md' }],
      ['/workspace/tests/second.test.md', { file: '/workspace/tests/second.test.md', healingSummary: 'Repair second.test.md' }],
    ]);
    expect(first.commit).toHaveBeenCalledOnce();
    expect(second.commit).toHaveBeenCalledOnce();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [
          expect.objectContaining({ id: first.file, application: 'applied', stopReason: 'settled' }),
          expect.objectContaining({ id: second.file, application: 'applied', stopReason: 'settled' }),
        ],
      }),
    }));
  });

  it('forwards the mocked report builder exit code after a mid-read interruption', async () => {
    const pending = capability('login.test.md');
    const controller = new AbortController();
    const readConfirmationAnswer = vi.fn(async (_commits: ReadonlyMap<string, HealCaseCommit>, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return 'interrupted' as const;
    });
    configure({ result: batch({ commits: commits(pending) }), interactive: true, readConfirmationAnswer });

    // This exercises call forwarding; the mocked exit code is not the public interruption contract.
    await expect(runHealCommand(input({ signal: controller.signal }))).resolves.toMatchObject({ exitCode: 0 });

    expect(readConfirmationAnswer).toHaveBeenCalledWith(expect.any(Map), controller.signal);
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        interrupted: true,
        results: [expect.objectContaining({ application: 'not-applied-interrupted', stopReason: 'settled' })],
      }),
    }));
  });

  it('settles an interactive decline without committing', async () => {
    const pending = capability('login.test.md');
    const unchanged = outcome({ results: [caseResult('login.test.md')] });
    const built = report(0);
    const readConfirmationAnswer = vi.fn(async (_commits: ReadonlyMap<string, HealCaseCommit>) => 'declined' as const);
    configure({ result: batch({ outcome: unchanged, commits: commits(pending) }), interactive: true, readConfirmationAnswer, built });

    await expect(runHealCommand(input())).resolves.toEqual(built);
    expect(readConfirmationAnswer).toHaveBeenCalledOnce();
    const candidates = readConfirmationAnswer.mock.calls[0]?.[0];
    expect(candidates?.size).toBe(1);
    expect([...candidates!.entries()]).toEqual([
      ['/workspace/tests/login.test.md', { file: '/workspace/tests/login.test.md', healingSummary: 'Repair login.test.md' }],
    ]);
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ application: 'declined', stopReason: 'settled' })],
      }),
    }));
  });

  it('reports exit 1 for an interactive decline over a healed pending commit with the real report builder', async () => {
    const pending = capability('healed.test.md');
    const healed = outcome({ results: [caseResult('healed.test.md', { durationMs: 1 })] });
    configure({ result: batch({ outcome: healed, commits: commits(pending) }), interactive: true, readConfirmationAnswer: vi.fn(async () => 'declined' as const) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input())).resolves.toMatchObject({
      exitCode: 1,
      envelope: expect.objectContaining({
        results: [expect.objectContaining({ application: 'declined' })],
      }),
    });
    expect(pending.commit).not.toHaveBeenCalled();
  });

  it('reports exit 1 for an interactive decline over a partially-healed pending commit with the real report builder', async () => {
    const pending = capability('partial.test.md');
    const partial = outcome({ results: [caseResult('partial.test.md', { repairOutcome: 'partially-healed', durationMs: 1 })] });
    configure({ result: batch({ outcome: partial, commits: commits(pending) }), interactive: true, readConfirmationAnswer: vi.fn(async () => 'declined' as const) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input())).resolves.toMatchObject({
      exitCode: 1,
      envelope: expect.objectContaining({
        results: [expect.objectContaining({ repairOutcome: 'partially-healed', application: 'declined' })],
      }),
    });
    expect(pending.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['default flags + non-interactive', {}, false, false],
    ['--yes + non-interactive', { yes: true }, false, false],
    ['--dry-run', { dryRun: true }, false, false],
    ['interactive reader available', {}, true, false],
    ['CI non-interactive', {}, false, true],
  ] as const)('skips confirmation for an empty commits map with %s', async (_name, flags, interactive, isCI) => {
    const unchanged = outcome({ results: [caseResult('unchanged.test.md', { repairOutcome: 'no-changes-needed' })] });
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ result: batch({ outcome: unchanged, commits: new Map() }), isCI, interactive, readConfirmationAnswer });
    await expect(runHealCommand(input(flags))).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.createTtyInteractivityCheck).not.toHaveBeenCalled();
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ application: 'no-artifact-change', stopReason: 'settled' })],
      }),
    }));
  });

  it('reports an invariant failure when a non-dry-run healed result lacks its required commit capability', async () => {
    configure({ result: batch({ commits: new Map() }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        results: [],
        errors: [expect.objectContaining({
          scope: 'run',
          code: 'UNEXPECTED_CRASH',
          message: 'Healing settlement invariant failed: commit capabilities do not match commit-capable measured cases',
        })],
      }),
    });
  });

  it('reports an invariant failure when an authorized commit-capable case has no settlement', async () => {
    const pending = capability('missing-settlement.test.md');
    const pendingCommits = commits(pending);
    Object.defineProperty(pendingCommits, Symbol.iterator, { value: function* (): IterableIterator<never> {} });
    configure({ result: batch({ outcome: outcome({ results: [caseResult('missing-settlement.test.md')] }), commits: pendingCommits }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        results: [],
        errors: [expect.objectContaining({
          scope: 'run',
          code: 'UNEXPECTED_CRASH',
          message: 'Healing settlement invariant failed: authorized healed case lacks a commit settlement: /workspace/tests/missing-settlement.test.md',
        })],
      }),
    });
  });

  it.each([
    ['dry-run', input({ dryRun: true }), false, undefined],
    ['declined', input(), true, 'declined'],
    ['interrupted', input(), true, 'interrupted'],
  ] as const)('reports an invariant failure when %s lacks a commit capability for a measured repair', async (_name, commandInput, interactive, answer) => {
    const onlyCapability = capability('first.test.md');
    const measured = outcome({ results: [caseResult('first.test.md'), caseResult('second.test.md', { repairOutcome: 'partially-healed' })] });
    configure({
      result: batch({ outcome: measured, commits: commits(onlyCapability) }),
      interactive,
      readConfirmationAnswer: vi.fn(async () => answer ?? 'authorized'),
    });
    await useActualBuildHealReport();

    await expect(runHealCommand(commandInput)).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        results: [],
        errors: [expect.objectContaining({
          scope: 'run',
          code: 'UNEXPECTED_CRASH',
          message: 'Healing settlement invariant failed: commit capabilities do not match commit-capable measured cases',
        })],
      }),
    });
    expect(onlyCapability.commit).not.toHaveBeenCalled();
  });

  it('reports an invariant failure for an unknown authorized settlement outcome', async () => {
    const pending = capability('unknown-settlement.test.md', {
      outcome: 'unknown',
    } as unknown as HealCommitOutcome);
    configure({ result: batch({ outcome: outcome({ results: [caseResult('unknown-settlement.test.md')] }), commits: commits(pending) }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        results: [],
        errors: [expect.objectContaining({
          scope: 'run',
          code: 'UNEXPECTED_CRASH',
          message: 'Healing settlement invariant failed: unknown settlement outcome: unknown',
        })],
      }),
    });
  });

  it('requires --yes for a pending commit capability in non-interactive CI', async () => {
    const pending = capability('healable.test.md');
    const healable = outcome({ results: [caseResult('healable.test.md')] });
    configure({ result: batch({ outcome: healable, commits: commits(pending) }), isCI: true, interactive: false, built: report(2) });

    await expect(runHealCommand(input())).resolves.toMatchObject({ exitCode: 2 });
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ConfigInvalidError) }));
    expect(pending.commit).not.toHaveBeenCalled();
  });

  it('commits only terminal cases after --yes when cancellation skipped a later case', async () => {
    const completed = capability('completed.test.md');
    const healed = outcome({ results: [caseResult('completed.test.md')], skipped: [{ file: '/workspace/tests/interrupted.test.md' }], interrupted: true });
    const controller = new AbortController();
    let resolveHeal!: (result: HealBatchResult) => void;
    const pendingHeal = new Promise<HealBatchResult>((resolve) => {
      resolveHeal = resolve;
    });
    const readConfirmationAnswer = vi.fn(async () => 'authorized' as const);
    configure({ result: batch({ outcome: healed, commits: commits(completed) }), readConfirmationAnswer, built: report(3) });
    mocks.heal.mockImplementationOnce(async () => pendingHeal);
    const command = runHealCommand(input({ yes: true, signal: controller.signal }));
    await vi.waitFor(() => expect(mocks.heal).toHaveBeenCalledOnce());
    controller.abort();
    resolveHeal(batch({ outcome: healed, commits: commits(completed) }));

    await expect(command).resolves.toMatchObject({ exitCode: 3 });
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(completed.commit).toHaveBeenCalledOnce();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        interrupted: true,
        results: [expect.objectContaining({ application: 'applied', stopReason: 'settled' })],
      }),
    }));
  });

  it('treats interactive cancellation before confirmation as interrupted with no writes', async () => {
    const pending = capability('completed.test.md');
    const healed = outcome({ results: [caseResult('completed.test.md')], skipped: [{ file: '/workspace/tests/later.test.md' }], interrupted: true });
    const controller = new AbortController();
    let resolveHeal!: (result: HealBatchResult) => void;
    const pendingHeal = new Promise<HealBatchResult>((resolve) => {
      resolveHeal = resolve;
    });
    const readConfirmationAnswer = vi.fn(async () => 'declined' as const);
    configure({ result: batch({ outcome: healed, commits: commits(pending) }), interactive: true, readConfirmationAnswer, built: report(3) });
    mocks.heal.mockImplementationOnce(async () => pendingHeal);
    const command = runHealCommand(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(mocks.heal).toHaveBeenCalledOnce());
    controller.abort();
    resolveHeal(batch({ outcome: healed, commits: commits(pending) }));

    await expect(command).resolves.toMatchObject({ exitCode: 3 });
    expect(readConfirmationAnswer).not.toHaveBeenCalled();
    expect(pending.commit).not.toHaveBeenCalled();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        interrupted: true,
        results: [expect.objectContaining({ application: 'not-applied-interrupted', stopReason: 'settled' })],
      }),
    }));
  });

  it('settles every authorized commit after cancellation begins during settlement', async () => {
    const controller = new AbortController();
    const first = capability('first.test.md'); const second = capability('second.test.md');
    let releaseFirst!: (result: HealCommitOutcome) => void;
    let firstSettled = false;
    let secondSettled = false;
    const firstResult = new Promise<HealCommitOutcome>((resolve) => {
      releaseFirst = (result) => { firstSettled = true; resolve(result); };
    });
    vi.mocked(first.commit).mockImplementation(() => { controller.abort(); return firstResult; });
    vi.mocked(second.commit).mockImplementation(async () => { secondSettled = true; return { outcome: 'committed' }; });
    configure({
      result: batch({
        outcome: outcome({ results: [caseResult('first.test.md'), caseResult('second.test.md')] }),
        commits: commits(first, second),
      }),
    });
    const command = runHealCommand(input({ yes: true, signal: controller.signal }));
    void command.catch(() => undefined);
    await vi.waitFor(() => expect(first.commit).toHaveBeenCalledOnce());
    expect(mocks.buildHealReport).not.toHaveBeenCalled();
    releaseFirst({ outcome: 'committed' });
    await expect(command).resolves.toMatchObject({ exitCode: 0 });
    expect(first.commit).toHaveBeenCalledOnce();
    expect(second.commit).toHaveBeenCalledOnce();
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(mocks.buildHealReport).toHaveBeenCalledOnce();
  });

  it('keeps the interrupted, failed, and committed cases isolated in one authorized batch', async () => {
    const partiallyWritten: ('plan' | 'grounding')[] = ['plan', 'grounding'];
    const originalErrorPartiallyWritten: ('plan' | 'grounding')[] = ['grounding'];
    const commitFailure = new FsIoError('grounding write failed', {
      operation: 'write-grounding',
      partiallyWritten: originalErrorPartiallyWritten,
    });
    const failed = capability('failed.test.md', {
      outcome: 'failed',
      error: commitFailure,
      partiallyWritten,
    });
    const succeeded = capability('committed.test.md');
    const healed = outcome({
      results: [caseResult('failed.test.md'), caseResult('committed.test.md')],
      skipped: [{ file: '/workspace/tests/interrupted-stage3.test.md' }],
      interrupted: true,
    });
    configure({ result: batch({ outcome: healed, commits: commits(failed, succeeded) }), built: report(3) });
    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode: 3 });
    partiallyWritten.length = 0;
    const settlementReportInput = mocks.buildHealReport.mock.calls[0]?.[0] as {
      readonly outcome: { readonly errors: readonly { readonly error: FsIoError }[] };
    };
    const wrappedSettlementError = settlementReportInput.outcome.errors[0]?.error;
    expect(commitFailure.details?.partiallyWritten).toBe(originalErrorPartiallyWritten);
    expect(commitFailure.details?.partiallyWritten).toEqual(['grounding']);
    expect(wrappedSettlementError?.details?.partiallyWritten).not.toBe(originalErrorPartiallyWritten);
    expect(wrappedSettlementError?.details?.partiallyWritten).not.toBe(partiallyWritten);
    expect(failed.commit).toHaveBeenCalledOnce();
    expect(succeeded.commit).toHaveBeenCalledOnce();
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [
          expect.objectContaining({
            id: failed.file,
            application: 'partially-applied',
            stopReason: 'settled',
          }),
          expect.objectContaining({
            id: succeeded.file,
            application: 'applied',
            stopReason: 'settled',
          }),
        ],
        errors: [expect.objectContaining({
          file: failed.file,
          error: expect.objectContaining({
            kind: 'fs-io-error',
            message: 'Healing artifacts could not be committed after persisting plan and grounding.',
            details: { operation: 'write-grounding', partiallyWritten: ['plan', 'grounding'] },
            cause: commitFailure,
          }),
        })],
        skipped: [{ file: '/workspace/tests/interrupted-stage3.test.md' }],
        interrupted: true,
      }),
    }));
  });

  const caughtPartiallyWritten: ('plan' | 'grounding')[] = ['plan'];
  it.each([
    {
      name: 'a generic error',
      commitFailure: new Error('rename failed'),
      expectedDetails: { partiallyWritten: [] },
      originalPartiallyWritten: undefined,
    },
    {
      name: 'an FsIoError with structured context',
      commitFailure: new FsIoError('rename failed', {
        operation: 'rename-plan',
        partiallyWritten: caughtPartiallyWritten,
      }),
      expectedDetails: { operation: 'rename-plan', partiallyWritten: [] },
      originalPartiallyWritten: caughtPartiallyWritten,
    },
  ])('wraps $name thrown by a commit attempt with authoritative empty partial-write evidence', async ({ commitFailure, expectedDetails, originalPartiallyWritten }) => {
    const failed = capability('thrown-commit.test.md');
    vi.mocked(failed.commit).mockRejectedValue(commitFailure);
    configure({
      result: batch({
        outcome: outcome({ results: [caseResult('thrown-commit.test.md')] }),
        commits: commits(failed),
      }),
      built: report(3),
    });

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode: 3 });
    const caughtReportInput = mocks.buildHealReport.mock.calls[0]?.[0] as {
      readonly outcome: { readonly errors: readonly { readonly error: FsIoError }[] };
    };
    const outerWrappedError = caughtReportInput.outcome.errors[0]?.error;
    if (originalPartiallyWritten !== undefined) {
      originalPartiallyWritten.push('grounding');
      expect(commitFailure).toBeInstanceOf(FsIoError);
      expect((commitFailure as FsIoError).details?.partiallyWritten).toBe(originalPartiallyWritten);
      expect((commitFailure as FsIoError).details?.partiallyWritten).toEqual(['plan', 'grounding']);
      expect(outerWrappedError?.cause).toBeInstanceOf(FsIoError);
      const innerWrappedError = outerWrappedError?.cause as FsIoError;
      expect(outerWrappedError?.details?.partiallyWritten).toEqual([]);
      expect(innerWrappedError.details?.partiallyWritten).toEqual([]);
      expect(outerWrappedError?.details?.partiallyWritten).not.toBe(innerWrappedError.details?.partiallyWritten);
    }

    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({
        results: [expect.objectContaining({ application: 'apply-failed', stopReason: 'settled' })],
        errors: [expect.objectContaining({
          file: failed.file,
          error: expect.objectContaining({
            kind: 'fs-io-error',
            message: 'Healing artifacts could not be committed after persisting no artifacts.',
            details: expectedDetails,
            cause: expect.objectContaining({
              kind: 'fs-io-error',
              message: 'Healing artifacts could not be committed after persisting no artifacts.',
              details: expectedDetails,
              cause: commitFailure,
            }),
          }),
        })],
      }),
    }));
  });

  it('keeps an apply-failed case with empty partial-write evidence', async () => {
    const failed = capability('failed-before-write.test.md', {
      outcome: 'failed',
      error: new FsIoError('plan write failed', { partiallyWritten: ['grounding'] }),
      partiallyWritten: [],
    });
    const partial = outcome({ results: [caseResult('failed-before-write.test.md', { repairOutcome: 'partially-healed', durationMs: 1 })] });
    configure({ result: batch({ outcome: partial, commits: commits(failed) }) });
    await useActualBuildHealReport();

    const output = await runHealCommand(input({ yes: true }));

    expect(output).toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        summary: expect.objectContaining({ errored: 1 }),
        results: [expect.objectContaining({
          id: 'tests/failed-before-write.test.md',
          repairOutcome: 'partially-healed',
          application: 'apply-failed',
          stopReason: 'settled',
        })],
        errors: [expect.objectContaining({
          scope: 'case',
          code: 'FS_IO_ERROR',
          caseId: 'tests/failed-before-write.test.md',
          details: { partiallyWritten: [] },
          message: 'Healing artifacts could not be committed after persisting no artifacts.',
        })],
      }),
    });
    expect(failed.commit).toHaveBeenCalledOnce();
  });

  it('uses settlement partial-write evidence for a partially-applied public report', async () => {
    const failed = capability('failed-after-plan-write.test.md', {
      outcome: 'failed',
      error: new FsIoError('grounding write failed', { partiallyWritten: ['grounding'] }),
      partiallyWritten: ['plan'],
    });
    const partial = outcome({ results: [caseResult('failed-after-plan-write.test.md', { repairOutcome: 'partially-healed', durationMs: 1 })] });
    configure({ result: batch({ outcome: partial, commits: commits(failed) }) });
    await useActualBuildHealReport();

    const output = await runHealCommand(input({ yes: true }));

    expect(output).toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        summary: expect.objectContaining({ errored: 1 }),
        results: [expect.objectContaining({
          id: 'tests/failed-after-plan-write.test.md',
          repairOutcome: 'partially-healed',
          application: 'partially-applied',
          stopReason: 'settled',
        })],
        errors: [expect.objectContaining({
          scope: 'case',
          code: 'FS_IO_ERROR',
          caseId: 'tests/failed-after-plan-write.test.md',
          details: { partiallyWritten: ['plan'] },
          message: 'Healing artifacts could not be committed after persisting plan.',
        })],
      }),
    });
    expect(failed.commit).toHaveBeenCalledOnce();
  });

  it('reports an invariant failure for malformed failed settlement evidence', async () => {
    const failed = capability('malformed-failure.test.md', {
      outcome: 'failed',
      error: new FsIoError('write failed'),
      partiallyWritten: 'plan',
    } as unknown as HealCommitOutcome);
    configure({ result: batch({ outcome: outcome({ results: [caseResult('malformed-failure.test.md')] }), commits: commits(failed) }) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        results: [],
        errors: [expect.objectContaining({
          scope: 'run',
          code: 'UNEXPECTED_CRASH',
          message: 'Healing settlement invariant failed: malformed failed settlement for /workspace/tests/malformed-failure.test.md',
        })],
      }),
    });
  });

  it('settles a multi-case interactive decline without committing any candidate', async () => {
    const first = capability('first.test.md');
    const second = capability('second.test.md');
    const healed = outcome({ results: [caseResult('first.test.md', { durationMs: 1 }), caseResult('second.test.md', { durationMs: 1 })] });
    configure({ result: batch({ outcome: healed, commits: commits(first, second) }), interactive: true, readConfirmationAnswer: vi.fn(async () => 'declined' as const) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input())).resolves.toMatchObject({
      exitCode: 1,
      envelope: expect.objectContaining({
        summary: expect.objectContaining({ failed: 2 }),
        errors: [],
        results: [
          expect.objectContaining({ id: 'tests/first.test.md', application: 'declined', stopReason: 'settled' }),
          expect.objectContaining({ id: 'tests/second.test.md', application: 'declined', stopReason: 'settled' }),
        ],
      }),
    });
    expect(first.commit).not.toHaveBeenCalled();
    expect(second.commit).not.toHaveBeenCalled();
  });

  it('treats confirmation interruption as a run interruption without committing pending candidates', async () => {
    const pending = capability('interrupted.test.md');
    const healed = outcome({ results: [caseResult('interrupted.test.md', { durationMs: 1 })] });
    configure({ result: batch({ outcome: healed, commits: commits(pending) }), interactive: true, readConfirmationAnswer: vi.fn(async () => 'interrupted' as const) });
    await useActualBuildHealReport();

    await expect(runHealCommand(input())).resolves.toMatchObject({
      exitCode: 3,
      envelope: expect.objectContaining({
        errors: [expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' })],
        results: [expect.objectContaining({ id: 'tests/interrupted.test.md', application: 'not-applied-interrupted', stopReason: 'settled' })],
      }),
    });
    expect(pending.commit).not.toHaveBeenCalled();
  });

  it('rounds only command duration before reporting and preserves fractional case duration', async () => {
    const fractional = caseResult('fractional.test.md', { repairOutcome: 'no-changes-needed', durationMs: 1.6 });
    configure({ result: batch({ outcome: outcome({ results: [fractional] }), commits: new Map() }), monotonic: [10, 12.6] });
    await expect(runHealCommand(input({ yes: true }))).resolves.toMatchObject({ exitCode: 0 });
    expect(mocks.buildHealReport).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 3, outcome: expect.objectContaining({ results: [expect.objectContaining({ durationMs: 1.6 })] }) }));
  });

  it('finalizes the completed heal report against the resolved project root', async () => {
    const built = report(0);
    configure({ built });

    await runHealCommand(input({ yes: true }));

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(built.envelope, '/workspace');
  });

  it('finalizes a configuration-load failure using cwd as its project-root fallback', async () => {
    await useActualBuildHealReport();
    mocks.loadConfig.mockRejectedValue(new ConfigInvalidError('invalid config'));

    await runHealCommand(input({ cwd: '/workspace/fallback' }));

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: 'heal' }),
      '/workspace/fallback',
    );
  });

  it('finalizes completed heal evidence with rounded duration and portable paths', async () => {
    const projectRoot = '/workspace/project';
    const built = reportWithExecutionEvidence(projectRoot);
    configure({
      result: batch({
        outcome: outcome({ results: [caseResult('login.test.md', { repairOutcome: 'no-changes-needed' })] }),
        commits: new Map(),
      }),
      config: { ...CONFIG, projectRoot },
      built,
    });

    const output = await runHealCommand(input({ cwd: `${projectRoot}/nested`, yes: true }));

    expect(output.envelope.results[0]).toMatchObject({
      id: 'tests/login.test.md',
      file: 'tests/login.test.md',
      planFile: 'tests/login.ambercast.plan.json',
      durationMs: 2,
      steps: [expect.objectContaining({ screenshot: 'tests/.runs/evidence.png' })],
    });
    expect(output.envelope.errors[0]).toMatchObject({ caseId: 'tests/login.test.md' });
  });

  it('finalizes a post-config error report with the resolved project root', async () => {
    const projectRoot = '/workspace/project';
    const built = reportWithExecutionEvidence(projectRoot);
    configure({ config: { ...CONFIG, projectRoot }, built });
    mocks.heal.mockRejectedValue(new Error('heal failed'));

    const output = await runHealCommand(input({ cwd: `${projectRoot}/nested`, yes: true }));

    expect(output.envelope.results[0]).toMatchObject({
      planFile: 'tests/login.ambercast.plan.json',
      durationMs: 2,
      steps: [expect.objectContaining({ screenshot: 'tests/.runs/evidence.png' })],
    });
    expect(output.envelope.errors[0]).toMatchObject({ caseId: 'tests/login.test.md' });
  });

  it('uses cwd to finalize error evidence when config loading never resolves a root', async () => {
    const cwd = '/workspace/fallback';
    const built = reportWithExecutionEvidence(cwd);
    configure({ built });
    mocks.loadConfig.mockRejectedValue(new ConfigInvalidError('invalid config'));

    const output = await runHealCommand(input({ cwd }));

    expect(output.envelope.results[0]).toMatchObject({
      id: 'tests/login.test.md',
      planFile: 'tests/login.ambercast.plan.json',
      durationMs: 2,
      steps: [expect.objectContaining({ screenshot: 'tests/.runs/evidence.png' })],
    });
  });

  it.each(['completed', 'error'] as const)('forces exit 3 when %s finalization returns the emergency singleton', async (branch) => {
    const built = report(0);
    configure({ built });
    if (branch === 'error') {
      mocks.loadConfig.mockRejectedValue(new ConfigInvalidError('invalid config'));
    }
    mocks.finalizeReportEnvelope.mockReturnValue(built.envelope);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(true);

    await expect(runHealCommand(input({ yes: true }))).resolves.toEqual({
      exitCode: 3,
      envelope: built.envelope,
    });
  });
});
