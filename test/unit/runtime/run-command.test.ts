import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { ReportEnvelope, type ReportError } from '#report/schema.js';
import {
  runRunCommand,
  type RunCommandInput,
  type RunCommandOutput,
} from '#runtime/run-command.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const mocks = vi.hoisted(() => ({
  createBrowserDriverResolver: vi.fn(),
  createEnvSecretsProvider: vi.fn(),
  createFsStorage: vi.fn(),
  createAmbercast: vi.fn(),
  createNoopEventSink: vi.fn(),
  createSystemClock: vi.fn(),
  loadConfig: vi.fn(),
  run: vi.fn(),
  buildRunReport: vi.fn(),
}));

vi.mock('#adapters/browser/registry.js', () => ({
  createBrowserDriverResolver: mocks.createBrowserDriverResolver,
}));
vi.mock('#adapters/storage/fs-storage.js', () => ({ createFsStorage: mocks.createFsStorage }));
vi.mock('#adapters/system/env-secrets-provider.js', () => ({
  createEnvSecretsProvider: mocks.createEnvSecretsProvider,
}));
vi.mock('#adapters/system/noop-event-sink.js', () => ({ createNoopEventSink: mocks.createNoopEventSink }));
vi.mock('#adapters/system/system-clock.js', () => ({ createSystemClock: mocks.createSystemClock }));
vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#runtime/create-ambercast.js', () => ({ createAmbercast: mocks.createAmbercast }));
vi.mock('#usecases/run.js', () => ({ run: mocks.run }));
vi.mock('#usecases/run-report.js', () => ({ buildRunReport: mocks.buildRunReport }));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
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
    },
  };

  expect(ReportEnvelope.safeParse(output.envelope).success).toBe(true);
  return output;
}

function input(overrides: Partial<RunCommandInput> = {}): RunCommandInput {
  return {
    files: [], headed: false, cacheOnly: false, stale: 'fail', cwd: '/workspace', ...overrides,
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(() => {
  mocks.createSystemClock.mockReturnValue(createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 10));
});

describe('runRunCommand', () => {
  it('propagates a configuration failure as a run-scoped report error', async () => {
    const error = new ConfigInvalidError('Configuration is invalid.');
    const output = reportOutput(2, [{
      scope: 'run', kind: 'usage', code: 'CONFIG_INVALID', message: 'Configuration is invalid.',
    }]);
    mocks.loadConfig.mockRejectedValue(error);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input())).resolves.toEqual(output);

    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({ error }));
    expect(output.envelope.errors).toEqual([expect.objectContaining({
      scope: 'run', code: 'CONFIG_INVALID',
    })]);
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
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn() };
    const discoverTestFiles = vi.fn(async () => []);
    const outcome = { results: [], noTestsFound: false };
    const output = reportOutput(0);
    const grep = /login/;

    mocks.createSystemClock.mockReturnValue(commandClock);
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createBrowserDriverResolver.mockReturnValue(browserDriver);
    mocks.createEnvSecretsProvider.mockReturnValue(secrets);
    mocks.createNoopEventSink.mockReturnValue(events.sink);
    mocks.createAmbercast.mockReturnValue({
      storage,
      layout,
      clock: replayClock,
      discoverTestFiles,
    });
    mocks.run.mockResolvedValue(outcome);
    mocks.buildRunReport.mockReturnValue(output);

    await expect(runRunCommand(input({
      files: ['login.test.md'],
      grep,
      target: 'web',
      headed: true,
      cacheOnly: true,
      aiProviderOverride: 'codex',
    }))).resolves.toEqual(output);

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
      browserDriver,
      secrets,
      events: events.sink,
      discoverTestFiles,
      config: CONFIG,
    }, {
      files: ['/workspace/login.test.md'],
      grep,
      target: 'web',
      cacheOnly: true,
      stale: 'fail',
    });
    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      startedAt: '2026-08-09T00:00:00Z',
      durationMs: 250,
    }));
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('passes caller cancellation into replay', async () => {
    const storage = createInMemoryStorage();
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn() };
    const discoverTestFiles = vi.fn(async () => []);
    const controller = new AbortController();
    const outcome = { results: [], noTestsFound: false };
    const output = reportOutput(0);

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

    await expect(runRunCommand(input({ signal: controller.signal }))).resolves.toEqual(output);

    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }), expect.anything());
  });

  it('normalizes an unexpected replay failure before top-level report construction', async () => {
    const storage = createInMemoryStorage();
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();
    const layout = { planPathFor: vi.fn(), groundingPathFor: vi.fn() };
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

    await expect(runRunCommand(input())).resolves.toEqual(output);

    expect(mocks.buildRunReport).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(UnexpectedCrashError),
    }));
  });

  it('has no AI executor dependency in its own executable source', () => {
    // A mock call count could prove only that this scenario skipped AI. Reading
    // the source proves replay has no dependency to resolve or accidentally invoke.
    const source = readFileSync(new URL('../../../src/runtime/run-command.ts', import.meta.url), 'utf8');
    // Design decision 16 requires the JSDoc to name AiExecutor, so exclude comments.
    const executableSource = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(executableSource).not.toContain('AiExecutor');
    expect(executableSource).not.toContain('AI_EXECUTOR_FACTORIES');
  });
});
