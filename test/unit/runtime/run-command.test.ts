import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '#adapters/ai/shared/command-runner.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { ReportEnvelope, type ReportError } from '#report/schema.js';
import {
  runRunCommand,
  type RunCommandInput,
  type RunCommandOutput,
} from '#runtime/run-command.js';
import type { RunOutcome } from '#usecases/run.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const mocks = vi.hoisted(() => ({
  claudeFactory: vi.fn(),
  codexFactory: vi.fn(),
  createBrowserDriverResolver: vi.fn(),
  createEnvSecretsProvider: vi.fn(),
  createFsStorage: vi.fn(),
  createCryptoRandom: vi.fn(),
  createAmbercast: vi.fn(),
  createNoopEventSink: vi.fn(),
  readCommandEnvironment: vi.fn(),
  createSystemClock: vi.fn(),
  loadConfig: vi.fn(),
  resolveAiProvider: vi.fn(),
  run: vi.fn(),
  buildRunReport: vi.fn(),
}));

vi.mock('#adapters/ai/registry.js', () => ({
  AI_EXECUTOR_FACTORIES: { claude: mocks.claudeFactory, codex: mocks.codexFactory },
}));
vi.mock('#adapters/browser/registry.js', () => ({
  createBrowserDriverResolver: mocks.createBrowserDriverResolver,
}));
vi.mock('#adapters/storage/fs-storage.js', () => ({ createFsStorage: mocks.createFsStorage }));
vi.mock('#adapters/system/crypto-random.js', () => ({ createCryptoRandom: mocks.createCryptoRandom }));
vi.mock('#adapters/system/env-secrets-provider.js', () => ({
  createEnvSecretsProvider: mocks.createEnvSecretsProvider,
}));
vi.mock('#adapters/system/noop-event-sink.js', () => ({ createNoopEventSink: mocks.createNoopEventSink }));
vi.mock('#adapters/system/process-command-environment.js', () => ({
  readCommandEnvironment: mocks.readCommandEnvironment,
}));
vi.mock('#adapters/system/system-clock.js', () => ({ createSystemClock: mocks.createSystemClock }));
vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#runtime/create-ambercast.js', () => ({ createAmbercast: mocks.createAmbercast }));
vi.mock('#runtime/resolve-ai-provider.js', () => ({ resolveAiProvider: mocks.resolveAiProvider }));
vi.mock('#usecases/run.js', () => ({ run: mocks.run }));
vi.mock('#usecases/run-report.js', () => ({ buildRunReport: mocks.buildRunReport }));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  projectRoot: '/workspace',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
  defaultTarget: 'web',
  ai: { provider: 'auto', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
};

function reportOutput(exitCode: RunCommandOutput['exitCode'], errors: ReportError[] = []): RunCommandOutput {
  const output: RunCommandOutput = {
    exitCode,
    envelope: {
      schemaVersion: '1.0',
      command: 'run',
      startedAt: '2026-08-09T00:00:00Z',
      durationMs: 1,
      summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
      errors,
      results: [],
      reportPersistence: 'not-attempted',
    },
  };

  expect(ReportEnvelope.safeParse(output.envelope).success).toBe(true);
  return output;
}

function input(overrides: Partial<RunCommandInput> = {}): RunCommandInput {
  return {
    files: [], headed: false, cacheOnly: false, allowEmpty: false, list: false, stale: 'fail', cwd: '/workspace', ...overrides,
  };
}

interface FactoryCallRecorder {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

function hasCommandRunner(value: unknown): value is { readonly run: CommandRunner } {
  return value !== null
    && typeof value === 'object'
    && 'run' in value
    && typeof value.run === 'function';
}

function capturedRunner(factory: FactoryCallRecorder): CommandRunner {
  const deps = factory.mock.calls[0]?.[0];

  if (!hasCommandRunner(deps)) {
    throw new Error('Expected the executor factory to receive a command runner.');
  }

  return deps.run;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.doMock('#usecases/run-report.js', () => ({ buildRunReport: mocks.buildRunReport }));
});

beforeEach(() => {
  mocks.createSystemClock.mockReturnValue(createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 10));
  mocks.createCryptoRandom.mockReturnValue({ uuid: () => '550e8400-e29b-41d4-a716-446655440000' });
});

describe('runRunCommand', () => {
  it('persists a report-safe failing outcome under the invocation path without leaking an absolute screenshot path', async () => {
    const storage = createInMemoryStorage();
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();
    const runId = '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000';
    const layout = {
      planPathFor: vi.fn(),
      groundingPathFor: vi.fn(),
      runReportPathFor: vi.fn(() => `${CONFIG.runsDir}/${runId}/report.json`),
    };
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/workspace/tests/login.test.md',
          file: '/workspace/tests/login.test.md',
          planFile: '/workspace/tests/login.ambercast.plan.json',
          status: 'failed' as const,
          durationMs: 12,
          explanation: 'The page did not contain the dashboard.',
          steps: [
            {
              id: 'assert-dashboard', type: 'assert' as const, status: 'failed' as const, kind: 'assertion' as const,
              expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
              screenshot: `${CONFIG.runsDir}/${runId}/login/assert-dashboard.png`,
            },
            { id: 'later', type: 'action' as const, status: 'skipped' as const },
          ],
        },
      }, {
        result: {
          id: '/workspace/tests/settings.test.md',
          file: '/workspace/tests/settings.test.md',
          planFile: '/workspace/tests/settings.ambercast.plan.json',
          status: 'passed' as const,
          durationMs: 4,
          explanation: 'Replay completed successfully.',
          steps: [{ id: 'open-settings', type: 'action' as const, status: 'passed' as const }],
        },
      }],
    };
    const persistedResults = outcome.results.map(({ result }) => ({
      ...result,
      id: result.id.replace('/workspace/', ''),
      file: result.file.replace('/workspace/', ''),
      planFile: result.planFile.replace('/workspace/', ''),
      steps: result.steps.map((step) => (
        !('screenshot' in step) || step.screenshot === undefined
          ? step
          : { ...step, screenshot: `tests/.runs/${runId}/login/assert-dashboard.png` }
      )),
    }));
    const output: RunCommandOutput = {
      exitCode: 1,
      envelope: {
        schemaVersion: '1.0', command: 'run', startedAt: '2026-08-09T00:00:00Z', durationMs: 1,
        summary: { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0 }, errors: [], results: persistedResults,
        reportPersistence: 'not-attempted',
      },
    };
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(browserDriver);
    mocks.createEnvSecretsProvider.mockReturnValue(secrets);
    mocks.createNoopEventSink.mockReturnValue(events.sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);
    const writeText = vi.spyOn(storage, 'writeText');

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ runId }), expect.anything());
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ results: expect.arrayContaining([expect.objectContaining({
        result: expect.objectContaining({
          id: 'tests/login.test.md',
          steps: expect.arrayContaining([expect.objectContaining({ screenshot: `tests/.runs/${runId}/login/assert-dashboard.png` })]),
        }),
      })]) }),
    }));
    const reportInput = mocks.buildRunReport.mock.calls[0]?.[0];
    expect(reportInput?.outcome?.results[1]?.result.id).toBe('tests/settings.test.md');
    expect(layout.runReportPathFor).toHaveBeenCalledWith(runId);
    expect(writeText).toHaveBeenCalledWith(`${CONFIG.runsDir}/${runId}/report.json`, JSON.stringify(persistedOutput.envelope));
    const persistedEnvelope = JSON.parse(await storage.readText(`${CONFIG.runsDir}/${runId}/report.json`));
    expect(persistedEnvelope.results[0].steps[0].screenshot).toBe(`tests/.runs/${runId}/login/assert-dashboard.png`);
    expect(persistedEnvelope.results[0].steps[0].screenshot).not.toContain(CONFIG.projectRoot);
    expect(persistedEnvelope).toEqual(persistedOutput.envelope);
  });

  it('omits an uncontained screenshot without replacing the completed outcome with a crash report', async () => {
    const storage = createInMemoryStorage();
    const runId = '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000';
    const layout = {
      planPathFor: vi.fn(),
      groundingPathFor: vi.fn(),
      runReportPathFor: vi.fn(() => `${CONFIG.runsDir}/${runId}/report.json`),
    };
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/workspace/tests/login.test.md',
          file: '/workspace/tests/login.test.md',
          planFile: '/workspace/tests/login.ambercast.plan.json',
          status: 'failed' as const,
          durationMs: 12,
          explanation: 'The page did not contain the dashboard.',
          steps: [{
            id: 'assert-dashboard', type: 'assert' as const, status: 'failed' as const, kind: 'assertion' as const,
            expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
            screenshot: '/host/diagnostics/assert-dashboard.png',
          }],
        },
      }],
    };
    const output: RunCommandOutput = {
      exitCode: 1,
      envelope: {
        schemaVersion: '1.0', command: 'run', startedAt: '2026-08-09T00:00:00Z', durationMs: 1,
        summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, errors: [],
        results: [{
          id: 'tests/login.test.md',
          file: 'tests/login.test.md',
          planFile: 'tests/login.ambercast.plan.json',
          status: 'failed',
          durationMs: 12,
          explanation: 'The page did not contain the dashboard.',
          steps: [{
            id: 'assert-dashboard', type: 'assert', status: 'failed', kind: 'assertion',
            expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
          }],
        }],
        reportPersistence: 'not-attempted',
      },
    };
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    expect(output).toMatchObject({ exitCode: 1, envelope: { summary: { total: 1, failed: 1, errored: 0 } } });
    expect(mocks.buildRunReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: expect.any(Object) }));
    const reportInput = mocks.buildRunReport.mock.calls[0]?.[0];
    const reportStep = reportInput?.outcome?.results[0]?.result.steps[0];
    expect(reportStep).toMatchObject({
      id: 'assert-dashboard', status: 'failed', kind: 'assertion',
      expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
    });
    expect(reportInput?.outcome?.results[0]?.result.id).toBe('tests/login.test.md');
    expect(reportStep).not.toHaveProperty('screenshot');
    expect(mocks.buildRunReport).not.toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }));
    const persistedEnvelope = JSON.parse(await storage.readText(`${CONFIG.runsDir}/${runId}/report.json`));
    expect(persistedEnvelope.results[0].steps[0]).not.toHaveProperty('screenshot');
    expect(JSON.stringify(persistedEnvelope)).not.toContain('/host/diagnostics');
  });

  it('omits a screenshot inside a runs directory that sits outside projectRoot', async () => {
    const storage = createInMemoryStorage();
    const writeText = vi.spyOn(storage, 'writeText');
    const config = { ...CONFIG, runsDir: '/elsewhere/.runs' };
    const runId = '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000';
    const reportPath = `${config.runsDir}/${runId}/report.json`;
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/workspace/tests/login.test.md',
          file: '/workspace/tests/login.test.md',
          planFile: '/workspace/tests/login.ambercast.plan.json',
          status: 'failed' as const,
          durationMs: 12,
          explanation: 'The page did not contain the dashboard.',
          steps: [{
            id: 'assert-dashboard', type: 'assert' as const, status: 'failed' as const, kind: 'assertion' as const,
            expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
            screenshot: `${config.runsDir}/${runId}/login/assert-dashboard.png`,
          }],
        },
      }],
    };
    const output: RunCommandOutput = {
      exitCode: 1,
      envelope: {
        schemaVersion: '1.0', command: 'run', startedAt: '2026-08-09T00:00:00Z', durationMs: 1,
        summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, errors: [],
        results: [{
          id: 'tests/login.test.md', file: 'tests/login.test.md', planFile: 'tests/login.ambercast.plan.json',
          status: 'failed', durationMs: 12, explanation: 'The page did not contain the dashboard.',
          steps: [{
            id: 'assert-dashboard', type: 'assert', status: 'failed', kind: 'assertion',
            expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.',
          }],
        }],
        reportPersistence: 'not-attempted',
      },
    };
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    const result = await runRunCommand(input());

    const reportInput = mocks.buildRunReport.mock.calls[0]?.[0];
    expect(reportInput?.outcome?.results[0]?.result.id).toBe('tests/login.test.md');
    expect(reportInput?.outcome?.results[0]?.result.steps[0]).not.toHaveProperty('screenshot');
    expect(writeText).toHaveBeenCalledWith(reportPath, JSON.stringify(persistedOutput.envelope));
    expect(result).toEqual(persistedOutput);
    expect(result.envelope.results[0]).not.toHaveProperty('steps.0.screenshot');
  });

  it('reports a failed completed-report persistence write without masking its semantic exit code', async () => {
    const storage = createInMemoryStorage();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const output = reportOutput(1);
    const failedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'failed' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue({ results: [], noTestsFound: false, listed: [] });
    mocks.buildRunReport.mockReturnValue(output);
    vi.spyOn(storage, 'writeText').mockRejectedValueOnce(new Error('disk full'));

    await expect(runRunCommand(input())).resolves.toEqual(failedOutput);

    expect(mocks.buildRunReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: expect.any(Object) }));
    expect(storage.writeText).toHaveBeenCalledOnce();
    await expect(storage.exists('/workspace/tests/.runs/report.json')).resolves.toBe(false);
  });

  it.each([
    [0, 3],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
  ] as const)('changes a failed persistence write from semantic exit %i to %i', async (semanticExitCode, expectedExitCode) => {
    const storage = createInMemoryStorage();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const output = reportOutput(semanticExitCode);
    const failedOutput: RunCommandOutput = {
      ...output,
      exitCode: expectedExitCode,
      envelope: { ...output.envelope, reportPersistence: 'failed' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue({ results: [], noTestsFound: false, listed: [] });
    mocks.buildRunReport.mockReturnValue(output);
    vi.spyOn(storage, 'writeText').mockRejectedValueOnce(new Error('disk full'));

    await expect(runRunCommand(input())).resolves.toEqual(failedOutput);
  });

  it.each([
    ['a case-scoped usage error', 2, {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: 'configuration.test.md',
          file: '/workspace/tests/configuration.test.md',
          planFile: '/workspace/tests/configuration.ambercast.plan.json',
          status: 'error',
          durationMs: 1,
          explanation: 'The case configuration is invalid.',
          steps: [],
        },
        error: new ConfigInvalidError('The case configuration is invalid.'),
      }],
    } satisfies RunOutcome],
    ['an unclassified aborted case', 3, {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: 'aborted.test.md',
          file: '/workspace/tests/aborted.test.md',
          planFile: '/workspace/tests/aborted.ambercast.plan.json',
          status: 'error',
          durationMs: 1,
          explanation: 'The case stopped before completion.',
          steps: [],
        },
      }],
    } satisfies RunOutcome],
    ['an empty selection', 5, {
      noTestsFound: true,
      listed: [],
      results: [],
    } satisfies RunOutcome],
  ] as const)('persists a completed outcome from %s with semantic exit %i', async (_description, semanticExitCode, outcome) => {
    const storage = createInMemoryStorage();
    const writeText = vi.spyOn(storage, 'writeText');
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const output = reportOutput(semanticExitCode);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    const expectedOutcome = {
      ...outcome,
      results: outcome.results.map((caseOutcome) => ({
        ...caseOutcome,
        result: {
          ...caseOutcome.result,
          file: caseOutcome.result.file.replace(`${CONFIG.projectRoot}/`, ''),
          planFile: caseOutcome.result.planFile.replace(`${CONFIG.projectRoot}/`, ''),
        },
      })),
    };
    expect(mocks.buildRunReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: expectedOutcome }));
    expect(writeText).toHaveBeenCalledWith(reportPath, JSON.stringify(persistedOutput.envelope));
    await expect(storage.readText(reportPath)).resolves.toBe(JSON.stringify(persistedOutput.envelope));
  });

  it('keeps a top-level configuration failure not attempted without an exit-code override', async () => {
    const storage = createInMemoryStorage();
    const error = new ConfigInvalidError('Configuration is invalid.');
    const output = reportOutput(2, [{
      scope: 'run', kind: 'usage', code: 'CONFIG_INVALID', message: 'Configuration is invalid.',
    }]);
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockRejectedValue(error);
    mocks.buildRunReport.mockReturnValue(output);
    const writeText = vi.spyOn(storage, 'writeText');

    await expect(runRunCommand(input())).resolves.toEqual(output);

    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({ error }));
    expect(writeText).not.toHaveBeenCalled();
    expect(output.envelope.errors).toEqual([expect.objectContaining({
      scope: 'run', code: 'CONFIG_INVALID',
    })]);
    expect(output.envelope.reportPersistence).toBe('not-attempted');
    expect(output.exitCode).toBe(2);
  });

  it('threads allow-empty and list to replay and report construction, then persists the list report', async () => {
    const storage = createInMemoryStorage();
    const writeText = vi.spyOn(storage, 'writeText');
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = { results: [], noTestsFound: true, listed: [] };
    const output = reportOutput(0);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20),
      discoverTestFiles: vi.fn(async () => []),
    });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({ allowEmpty: true, list: true }))).resolves.toEqual(persistedOutput);

    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      allowEmpty: true,
      list: true,
    }));
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      options: { allowEmpty: true, list: true },
      outcome,
    }));
    expect(writeText).toHaveBeenCalledWith(reportPath, JSON.stringify(persistedOutput.envelope));
    await expect(storage.readText(reportPath)).resolves.toBe(JSON.stringify(persistedOutput.envelope));
  });

  it('threads allow-empty and list into the report context on the command-error path', async () => {
    const storage = createInMemoryStorage();
    const error = new ConfigInvalidError('Configuration is invalid.');
    const output = reportOutput(2, [{
      scope: 'run', kind: 'usage', code: 'CONFIG_INVALID', message: error.message,
    }]);
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockRejectedValue(error);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({ allowEmpty: true, list: true }))).resolves.toBe(output);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      options: { allowEmpty: true, list: true },
      error,
    }));
  });

  it('rejects stale regeneration before configuration or prompt and plan storage can be read', async () => {
    const storage = createInMemoryStorage();
    const readText = vi.spyOn(storage, 'readText');
    const error = new ConfigInvalidError(
      'The --stale=regenerate option is not available in this build; only --stale=fail is supported.',
    );
    const output = reportOutput(2, [{
      scope: 'run', kind: 'usage', code: 'CONFIG_INVALID', message: error.message,
    }]);
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({ stale: 'regenerate' }))).resolves.toEqual(output);

    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.createFsStorage).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(mocks.createAmbercast).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ConfigInvalidError) }));
  });

  it('composes replay ports and delegates the outcome to run reporting without launching a real browser', async () => {
    const storage = createInMemoryStorage();
    let monotonicCall = 0;
    const commandClock = {
      now: () => new Date('2026-08-09T00:00:00Z'),
      monotonicMs: () => {
        monotonicCall += 1;
        return monotonicCall === 1 ? 10 : 260;
      },
    };
    const replayClock = createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20);
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map([['{{secrets.auth.password}}', 'secret']]));
    const events = createRecordingEventSink();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const discoverTestFiles = vi.fn(async () => []);
    const outcome = { results: [], noTestsFound: false, listed: [] };
    const output = reportOutput(0);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };
    const grep = /login/;
    const commandEnvironment = {
      AMBERCAST_RUNTIME_ALLOWED: 'allowed',
      AMBERCAST_SECRET_RUNTIME_TEST: 'secret',
    };

    mocks.createSystemClock.mockReturnValue(commandClock);
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(browserDriver);
    mocks.createEnvSecretsProvider.mockReturnValue(secrets);
    mocks.createNoopEventSink.mockReturnValue(events.sink);
    mocks.readCommandEnvironment.mockReturnValue(commandEnvironment);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: replayClock,
      discoverTestFiles,
    });
    mocks.resolveAiProvider.mockResolvedValue('codex');
    mocks.codexFactory.mockReturnValue({ name: 'codex-cli' });
    mocks.run.mockImplementation(async (deps: { readonly resolveAiExecutor: () => Promise<unknown> }) => {
      await deps.resolveAiExecutor();
      return outcome;
    });
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({
      files: ['login.test.md'],
      grep,
      target: 'web',
      headed: true,
      cacheOnly: true,
      aiProviderOverride: 'codex',
    }))).resolves.toEqual(persistedOutput);

    expect(mocks.createBrowserDriverResolver).toHaveBeenCalledWith({ headed: true });
    expect(mocks.createAmbercast).toHaveBeenCalledWith({
      config: CONFIG,
      aiProvider: 'claude',
      browserDriver,
      secrets,
      events: events.sink,
    });
    expect(mocks.run).toHaveBeenCalledWith({
      storage,
      layout,
      clock: replayClock,
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver,
      secrets,
      events: events.sink,
      discoverTestFiles,
      config: CONFIG,
      resolveAiExecutor: expect.any(Function),
    }, {
      files: ['/workspace/login.test.md'],
      grep,
      target: 'web',
      cacheOnly: true,
      allowEmpty: false,
      list: false,
      stale: 'fail',
    });
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      startedAt: '2026-08-09T00:00:00Z',
      durationMs: 250,
    }));
    expect(mocks.readCommandEnvironment).toHaveBeenCalledExactlyOnceWith();
    const result = await capturedRunner(mocks.codexFactory)(process.execPath, [
      '--input-type=module',
      '--eval',
      'process.stdout.write(JSON.stringify(process.env));',
    ]);

    expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
    if (result.outcome !== 'exited') {
      throw new Error('Expected the environment probe child to exit normally.');
    }

    const childEnvironment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
    expect(childEnvironment.AMBERCAST_RUNTIME_ALLOWED).toBe('allowed');
    expect(childEnvironment).not.toHaveProperty('AMBERCAST_SECRET_RUNTIME_TEST');
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('passes caller cancellation into replay', async () => {
    const storage = createInMemoryStorage();
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const discoverTestFiles = vi.fn(async () => []);
    const controller = new AbortController();
    const outcome = { results: [], noTestsFound: false, listed: [] };
    const output = reportOutput(0);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(browserDriver);
    mocks.createEnvSecretsProvider.mockReturnValue(secrets);
    mocks.createNoopEventSink.mockReturnValue(events.sink);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20),
      discoverTestFiles,
    });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({ signal: controller.signal }))).resolves.toEqual(persistedOutput);

    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }), expect.anything());
  });

  it('normalizes an unexpected replay failure before top-level report construction', async () => {
    const storage = createInMemoryStorage();
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const discoverTestFiles = vi.fn(async () => []);
    const output = reportOutput(3, [{
      scope: 'run', kind: 'environment', code: 'UNEXPECTED_CRASH', message: 'The run command crashed unexpectedly.',
    }]);

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(browserDriver);
    mocks.createEnvSecretsProvider.mockReturnValue(secrets);
    mocks.createNoopEventSink.mockReturnValue(events.sink);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20),
      discoverTestFiles,
    });
    mocks.run.mockRejectedValue(new Error('unexpected test rejection'));
    mocks.buildRunReport.mockReturnValue(output);
    const writeText = vi.spyOn(storage, 'writeText');

    await expect(runRunCommand(input())).resolves.toEqual(output);

    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(UnexpectedCrashError),
    }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('defers AI provider resolution and executor creation when replay needs no fallback', async () => {
    const storage = createInMemoryStorage();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => '/workspace/tests/.runs/report.json') };
    const discoverTestFiles = vi.fn(async () => []);
    const outcome = { results: [], noTestsFound: false, listed: [] };
    const output = reportOutput(0);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20),
      discoverTestFiles,
    });
    // A resolved run outcome models a complete grounding hit, which does not
    // dereference the lazy per-case fallback resolver passed to `run()`.
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    expect(mocks.resolveAiProvider).not.toHaveBeenCalled();
    expect(mocks.claudeFactory).not.toHaveBeenCalled();
    expect(mocks.codexFactory).not.toHaveBeenCalled();
  });

  it('keeps identities outside projectRoot absolute while persisting a completed report', async () => {
    const storage = createInMemoryStorage();
    const config = { ...CONFIG, testDir: '/elsewhere/tests' };
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/elsewhere/tests/case.test.md',
          file: '/elsewhere/tests/case.test.md',
          planFile: '/elsewhere/tests/case.ambercast.plan.json',
          status: 'passed' as const,
          durationMs: 4,
          explanation: 'Replay completed successfully.',
          steps: [],
        },
      }],
    } satisfies RunOutcome;
    const output: RunCommandOutput = {
      exitCode: 0,
      envelope: {
        schemaVersion: '1.0', command: 'run', startedAt: '2026-08-09T00:00:00Z', durationMs: 1,
        summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, errors: [],
        results: [outcome.results[0]!.result], reportPersistence: 'not-attempted',
      },
    };
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    const reportInput = mocks.buildRunReport.mock.calls[0]?.[0];
    const reportResult = reportInput?.outcome?.results[0]?.result;
    expect(reportResult?.id).toBe('/elsewhere/tests/case.test.md');
    expect(reportResult?.file).toBe('/elsewhere/tests/case.test.md');
    expect(reportResult?.planFile).toBe('/elsewhere/tests/case.ambercast.plan.json');
    const persistedEnvelope = JSON.parse(await storage.readText(reportPath));
    expect(persistedOutput.exitCode).toBe(0);
    expect(persistedEnvelope.reportPersistence).toBe('persisted');
    expect(persistedEnvelope.results[0].id).toBe('/elsewhere/tests/case.test.md');
    expect(persistedEnvelope.results[0].file).toBe('/elsewhere/tests/case.test.md');
    expect(persistedEnvelope.results[0].planFile).toBe('/elsewhere/tests/case.ambercast.plan.json');
  });

  it('relativizes only the in-project identities within a mixed outcome', async () => {
    const storage = createInMemoryStorage();
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/workspace/identities/inside.test.md',
          file: '/workspace/tests/inside.test.md',
          planFile: '/workspace/plans/inside.ambercast.plan.json',
          status: 'passed' as const,
          durationMs: 4,
          explanation: 'Replay completed successfully.',
          steps: [],
        },
      }, {
        result: {
          id: '/elsewhere/identities/outside.test.md',
          file: '/elsewhere/tests/outside.test.md',
          planFile: '/elsewhere/plans/outside.ambercast.plan.json',
          status: 'passed' as const,
          durationMs: 6,
          explanation: 'Replay completed successfully.',
          steps: [],
        },
      }],
    } satisfies RunOutcome;
    const output = reportOutput(0);
    const persistedOutput: RunCommandOutput = {
      ...output,
      envelope: { ...output.envelope, reportPersistence: 'persisted' },
    };

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(persistedOutput);

    const reportInput = mocks.buildRunReport.mock.calls[0]?.[0];
    const inProjectResult = reportInput?.outcome?.results[0]?.result;
    const outsideProjectResult = reportInput?.outcome?.results[1]?.result;
    expect(inProjectResult?.id).toBe('identities/inside.test.md');
    expect(inProjectResult?.file).toBe('tests/inside.test.md');
    expect(inProjectResult?.planFile).toBe('plans/inside.ambercast.plan.json');
    expect(outsideProjectResult?.id).toBe('/elsewhere/identities/outside.test.md');
    expect(outsideProjectResult?.file).toBe('/elsewhere/tests/outside.test.md');
    expect(outsideProjectResult?.planFile).toBe('/elsewhere/plans/outside.ambercast.plan.json');
  });

  it('persists transformed executed and listed results from the same outcome', async () => {
    const storage = createInMemoryStorage();
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = {
      noTestsFound: false,
      listed: [{ file: '/workspace/tests/listed.test.md' }],
      results: [{
        result: {
          id: '/workspace/identities/executed.test.md',
          file: '/workspace/tests/executed.test.md',
          planFile: '/workspace/plans/executed.ambercast.plan.json',
          status: 'passed' as const,
          durationMs: 4,
          explanation: 'Replay completed successfully.',
          steps: [],
        },
      }],
    } satisfies RunOutcome;

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    vi.doUnmock('#usecases/run-report.js');
    vi.resetModules();
    const { runRunCommand: runRunCommandWithRealReport } = await import('#runtime/run-command.js');

    const output = await runRunCommandWithRealReport(input());

    expect(output.exitCode).toBe(0);
    expect(output.envelope.reportPersistence).toBe('persisted');
    const persistedEnvelope = JSON.parse(await storage.readText(reportPath));
    expect(persistedEnvelope.results[0].id).toBe('identities/executed.test.md');
    expect(persistedEnvelope.results[0].file).toBe('tests/executed.test.md');
    expect(persistedEnvelope.results[0].planFile).toBe('plans/executed.ambercast.plan.json');
    expect(persistedEnvelope.results[1].id).toBe('tests/listed.test.md');
    expect(persistedEnvelope.results[1].file).toBe('tests/listed.test.md');
  });

  it('preserves an absolute listed fallback while running in list mode', async () => {
    const storage = createInMemoryStorage();
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outcome = {
      noTestsFound: false,
      listed: [{ file: '/workspace/tests/inside.test.md' }, { file: '/elsewhere/tests/outside.test.md' }],
      results: [],
    } satisfies RunOutcome;

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    vi.doUnmock('#usecases/run-report.js');
    vi.resetModules();
    const { runRunCommand: runRunCommandWithRealReport } = await import('#runtime/run-command.js');

    const output = await runRunCommandWithRealReport(input({ list: true }));

    expect(output.exitCode).toBe(0);
    expect(output.envelope.reportPersistence).toBe('persisted');
    const persistedEnvelope = JSON.parse(await storage.readText(reportPath));
    expect(persistedEnvelope.results[0].id).toBe('tests/inside.test.md');
    expect(persistedEnvelope.results[0].file).toBe('tests/inside.test.md');
    expect(persistedEnvelope.results[1].id).toBe('/elsewhere/tests/outside.test.md');
    expect(persistedEnvelope.results[1].file).toBe('/elsewhere/tests/outside.test.md');
  });

  it('derives case error identities from the transformed executed identity', async () => {
    const storage = createInMemoryStorage();
    const reportPath = '/workspace/tests/.runs/report.json';
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn(), runReportPathFor: vi.fn(() => reportPath) };
    const outsideError = new ConfigInvalidError('The outside case configuration is invalid.');
    const insideError = new ConfigInvalidError('The inside case configuration is invalid.');
    const outcome = {
      noTestsFound: false,
      listed: [],
      results: [{
        result: {
          id: '/elsewhere/tests/outside.test.md',
          file: '/elsewhere/tests/outside.test.md',
          planFile: '/elsewhere/tests/outside.ambercast.plan.json',
          status: 'error' as const,
          durationMs: 4,
          explanation: 'The case configuration is invalid.',
          steps: [],
        },
        error: outsideError,
      }, {
        result: {
          id: '/workspace/tests/inside.test.md',
          file: '/workspace/tests/inside.test.md',
          planFile: '/workspace/tests/inside.ambercast.plan.json',
          status: 'error' as const,
          durationMs: 6,
          explanation: 'The case configuration is invalid.',
          steps: [],
        },
        error: insideError,
      }],
    } satisfies RunOutcome;

    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    mocks.createEnvSecretsProvider.mockReturnValue(createFakeSecretsProvider(new Map()));
    mocks.createNoopEventSink.mockReturnValue(createRecordingEventSink().sink);
    mocks.createAmbercast.mockReturnValue({ storage, layout, clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 20), discoverTestFiles: vi.fn(async () => []) });
    mocks.run.mockResolvedValue(outcome);
    vi.doUnmock('#usecases/run-report.js');
    vi.resetModules();
    const { runRunCommand: runRunCommandWithRealReport } = await import('#runtime/run-command.js');

    const output = await runRunCommandWithRealReport(input());

    expect(output.exitCode).toBe(2);
    expect(output.envelope.reportPersistence).toBe('persisted');
    const persistedEnvelope = JSON.parse(await storage.readText(reportPath));
    expect(persistedEnvelope.errors[0].caseId).toBe('/elsewhere/tests/outside.test.md');
    expect(persistedEnvelope.errors[1].caseId).toBe('tests/inside.test.md');
  });
});
