import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { runCheckCommand } from '#runtime/check-command.js';
import { runGenerateCommand } from '#runtime/generate-command.js';
import { runHealCommand } from '#runtime/heal-command.js';
import { runRunCommand } from '#runtime/run-command.js';

const mocks = vi.hoisted(() => ({
  buildCheckReport: vi.fn(),
  buildGenerateReport: vi.fn(),
  buildHealReport: vi.fn(),
  buildRunReport: vi.fn(),
  check: vi.fn(),
  createAmbercast: vi.fn(),
  createBrowserDriverResolver: vi.fn(),
  createConfirmationAnswerReader: vi.fn(),
  createCryptoRandom: vi.fn(),
  createEnvSecretsProvider: vi.fn(),
  createFsReadStorage: vi.fn(),
  createFsStorage: vi.fn(),
  createFsTestFileDiscovery: vi.fn(),
  createNoopEventSink: vi.fn(),
  createProcessEnvironmentInfo: vi.fn(),
  createSystemClock: vi.fn(),
  createTtyInteractivityCheck: vi.fn(),
  finalizeReportEnvelope: vi.fn(),
  generate: vi.fn(),
  heal: vi.fn(),
  isEmergencyFinalizedEnvelope: vi.fn(),
  loadConfig: vi.fn(),
  resolveAiProvider: vi.fn(),
  run: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('#adapters/ai/registry.js', () => ({
  AI_EXECUTOR_FACTORIES: { claude: vi.fn(), codex: vi.fn() },
}));
vi.mock('#adapters/browser/registry.js', () => ({
  createBrowserDriverResolver: mocks.createBrowserDriverResolver,
}));
vi.mock('#adapters/storage/fs-read-storage.js', () => ({
  createFsReadStorage: mocks.createFsReadStorage,
}));
vi.mock('#adapters/storage/fs-storage.js', () => ({ createFsStorage: mocks.createFsStorage }));
vi.mock('#adapters/system/confirmation-answer-reader.js', () => ({
  createConfirmationAnswerReader: mocks.createConfirmationAnswerReader,
}));
vi.mock('#adapters/system/crypto-random.js', () => ({ createCryptoRandom: mocks.createCryptoRandom }));
vi.mock('#adapters/system/env-secrets-provider.js', () => ({
  createEnvSecretsProvider: mocks.createEnvSecretsProvider,
}));
vi.mock('#adapters/system/noop-event-sink.js', () => ({
  createNoopEventSink: mocks.createNoopEventSink,
}));
vi.mock('#adapters/system/process-environment-info.js', () => ({
  createProcessEnvironmentInfo: mocks.createProcessEnvironmentInfo,
}));
vi.mock('#adapters/system/system-clock.js', () => ({ createSystemClock: mocks.createSystemClock }));
vi.mock('#adapters/system/tty-interactivity.js', () => ({
  createTtyInteractivityCheck: mocks.createTtyInteractivityCheck,
}));
vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#runtime/create-ambercast.js', () => ({ createAmbercast: mocks.createAmbercast }));
vi.mock('#runtime/resolve-ai-provider.js', () => ({ resolveAiProvider: mocks.resolveAiProvider }));
vi.mock('#runtime/test-file-discovery.js', () => ({
  createFsTestFileDiscovery: mocks.createFsTestFileDiscovery,
}));
vi.mock('#usecases/check.js', () => ({ check: mocks.check }));
vi.mock('#usecases/check-report.js', () => ({ buildCheckReport: mocks.buildCheckReport }));
vi.mock('#usecases/generate.js', () => ({ generate: mocks.generate }));
vi.mock('#usecases/generate-report.js', () => ({ buildGenerateReport: mocks.buildGenerateReport }));
vi.mock('#usecases/heal.js', () => ({ heal: mocks.heal }));
vi.mock('#usecases/heal-report.js', () => ({ buildHealReport: mocks.buildHealReport }));
vi.mock('#usecases/report-finalization.js', () => ({
  finalizeReportEnvelope: mocks.finalizeReportEnvelope,
  isEmergencyFinalizedEnvelope: mocks.isEmergencyFinalizedEnvelope,
}));
vi.mock('#usecases/run.js', () => ({ run: mocks.run }));
vi.mock('#usecases/run-report.js', () => ({ buildRunReport: mocks.buildRunReport }));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  projectRoot: '/workspace',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium', healReplayIsolation: 'stateful' } },
  defaultTarget: 'web',
  ai: { provider: 'codex', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: true, updateGroundingCache: false },
  grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
  heal: { caseTimeoutMs: 300_000 },
};

const summary = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
const runRaw = {
  schemaVersion: '3.0' as const,
  command: 'run' as const,
  startedAt: '2026-08-26T00:00:00Z',
  durationMs: 0,
  reportPersistence: 'not-attempted' as const,
  summary,
  errors: [],
  results: [],
};
const healRaw = {
  schemaVersion: '3.0' as const,
  command: 'heal' as const,
  startedAt: '2026-08-26T00:00:00Z',
  durationMs: 0,
  summary,
  errors: [],
  results: [],
};
const checkRaw = {
  schemaVersion: '3.0' as const,
  command: 'check' as const,
  startedAt: '2026-08-26T00:00:00Z',
  durationMs: 0,
  summary,
  errors: [],
  results: [],
};
const generateRaw = {
  schemaVersion: '3.0' as const,
  command: 'generate' as const,
  startedAt: '2026-08-26T00:00:00Z',
  durationMs: 0,
  summary,
  errors: [],
  results: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  const storage = { writeText: mocks.writeText };
  const clock = {
    now: () => new Date('2026-08-26T00:00:00Z'),
    monotonicMs: () => 0,
  };
  mocks.createSystemClock.mockReturnValue(clock);
  mocks.createCryptoRandom.mockReturnValue({ uuid: () => '550e8400-e29b-41d4-a716-446655440000' });
  mocks.createProcessEnvironmentInfo.mockReturnValue({ isCI: () => false });
  mocks.createBrowserDriverResolver.mockReturnValue({});
  mocks.createEnvSecretsProvider.mockReturnValue({});
  mocks.createNoopEventSink.mockReturnValue({ emit: vi.fn() });
  mocks.createTtyInteractivityCheck.mockReturnValue(() => false);
  mocks.createConfirmationAnswerReader.mockReturnValue(vi.fn(async () => 'declined' as const));
  mocks.createFsStorage.mockReturnValue(storage);
  mocks.createFsReadStorage.mockReturnValue({});
  mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
  mocks.createAmbercast.mockReturnValue({
    storage,
    layout: { runReportPathFor: () => '/workspace/tests/.runs/report.json' },
    clock,
    aiExecutor: {},
    discoverTestFiles: async () => [],
  });
  mocks.loadConfig.mockResolvedValue(CONFIG);
  mocks.resolveAiProvider.mockResolvedValue('codex');
  mocks.run.mockResolvedValue({ results: [], noTestsFound: false, listed: [] });
  mocks.heal.mockResolvedValue({
    outcome: { results: [], errors: [], noTestsFound: false, listed: [], skipped: [], interrupted: false },
    commits: new Map(),
  });
  mocks.check.mockResolvedValue({ results: [], errors: [], noTestsFound: false });
  mocks.generate.mockResolvedValue({ results: [], noTestsFound: false });
  mocks.buildRunReport.mockReturnValue({ exitCode: 0, envelope: runRaw });
  mocks.buildHealReport.mockReturnValue({ exitCode: 0, envelope: healRaw });
  mocks.buildCheckReport.mockReturnValue({ exitCode: 0, envelope: checkRaw });
  mocks.buildGenerateReport.mockReturnValue({ exitCode: 0, envelope: generateRaw });
  mocks.finalizeReportEnvelope.mockImplementation((raw) => raw);
  mocks.isEmergencyFinalizedEnvelope.mockReturnValue(false);
  mocks.writeText.mockResolvedValue(undefined);
});

function runInput() {
  return {
    files: [], headed: false, cacheOnly: false, updateCache: false,
    allowEmpty: false, list: false, stale: 'fail' as const, cwd: '/workspace',
  };
}

function healInput() {
  return {
    files: [], dryRun: false, yes: true, allowEmpty: false, list: false, cwd: '/workspace',
  };
}

function checkInput() {
  return { files: [], allowEmpty: false, list: false, cwd: '/workspace' };
}

function generateInput() {
  return {
    files: [], strict: false, force: false, dryRun: false,
    allowEmpty: false, list: false, cwd: '/workspace',
  };
}

describe('runtime finalizer contract', () => {
  it('finalizes the run persisted-success branch exactly once with its raw candidate', async () => {
    await runRunCommand(runInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(
      { ...runRaw, reportPersistence: 'persisted' },
      CONFIG.projectRoot,
    );
  });

  it('finalizes both run candidates when report persistence fails', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('disk full'));

    await runRunCommand(runInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeReportEnvelope).toHaveBeenNthCalledWith(
      1,
      { ...runRaw, reportPersistence: 'persisted' },
      CONFIG.projectRoot,
    );
    expect(mocks.finalizeReportEnvelope).toHaveBeenNthCalledWith(
      2,
      { ...runRaw, reportPersistence: 'failed' },
      CONFIG.projectRoot,
    );
  });

  it('finalizes the run top-level catch branch exactly once with its raw envelope', async () => {
    mocks.loadConfig.mockRejectedValueOnce(new ConfigInvalidError('invalid config'));

    await runRunCommand(runInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(runRaw, '/workspace');
  });

  it('finalizes the heal success branch exactly once with its raw envelope', async () => {
    await runHealCommand(healInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(healRaw, CONFIG.projectRoot);
  });

  it('finalizes the heal error branch exactly once with its raw envelope', async () => {
    mocks.loadConfig.mockRejectedValueOnce(new ConfigInvalidError('invalid config'));

    await runHealCommand(healInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(healRaw, '/workspace');
  });

  it('finalizes the check success branch exactly once with its raw envelope', async () => {
    await runCheckCommand(checkInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(checkRaw, CONFIG.projectRoot);
  });

  it('finalizes the check error branch exactly once with its raw envelope', async () => {
    mocks.loadConfig.mockRejectedValueOnce(new ConfigInvalidError('invalid config'));

    await runCheckCommand(checkInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(checkRaw, '/workspace');
  });

  it('finalizes the generate success branch exactly once with its raw envelope', async () => {
    await runGenerateCommand(generateInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(generateRaw, CONFIG.projectRoot);
  });

  it('finalizes the generate error branch exactly once with its raw envelope', async () => {
    mocks.loadConfig.mockRejectedValueOnce(new ConfigInvalidError('invalid config'));

    await runGenerateCommand(generateInput());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(generateRaw, '/workspace');
  });
});
