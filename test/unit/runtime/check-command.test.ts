import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type { JsonValueT, PlanDocument } from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { ReportEnvelope } from '#report/schema.js';
import { runCheckCommand, type CheckCommandInput, type CheckCommandOutput } from '#runtime/check-command.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createFsReadStorage: vi.fn(),
  createFsTestFileDiscovery: vi.fn(),
  check: vi.fn(),
  buildCheckReport: vi.fn(),
  finalizeReportEnvelope: vi.fn(),
  isEmergencyFinalizedEnvelope: vi.fn(),
}));

vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#adapters/storage/fs-read-storage.js', () => ({ createFsReadStorage: mocks.createFsReadStorage }));
vi.mock('#runtime/test-file-discovery.js', () => ({ createFsTestFileDiscovery: mocks.createFsTestFileDiscovery }));
vi.mock('#usecases/check.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('#usecases/check.js')>(),
  check: mocks.check,
}));
vi.mock('#usecases/check-report.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('#usecases/check-report.js')>(),
  buildCheckReport: mocks.buildCheckReport,
}));
vi.mock('#usecases/report-finalization.js', () => ({
  finalizeReportEnvelope: mocks.finalizeReportEnvelope,
  isEmergencyFinalizedEnvelope: mocks.isEmergencyFinalizedEnvelope,
}));

const rawEnvelopeForFinalizedBoundary = {} as ReportEnvelope;
// @ts-expect-error A real command output cannot expose an unfinalized envelope.
const rawCheckCommandOutput: CheckCommandOutput = { exitCode: 0, envelope: rawEnvelopeForFinalizedBoundary };
void rawCheckCommandOutput;

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  projectRoot: '/workspace',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium', healReplayIsolation: 'stateful' } },
  defaultTarget: 'web',
  ai: { provider: 'auto', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
  grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
  heal: { caseTimeoutMs: 300_000 },
};

function input(overrides: Partial<CheckCommandInput> = {}): CheckCommandInput {
  return { files: [], allowEmpty: false, list: false, cwd: '/workspace', ...overrides };
}

afterEach(() => {
  vi.resetAllMocks();
});

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('#usecases/report-finalization.js')>(
    '#usecases/report-finalization.js',
  );
  mocks.finalizeReportEnvelope.mockImplementation(actual.finalizeReportEnvelope);
  mocks.isEmergencyFinalizedEnvelope.mockImplementation(actual.isEmergencyFinalizedEnvelope);
});

async function useRealCheckComposition(): Promise<void> {
  const [{ check: realCheck }, { buildCheckReport: realBuildCheckReport }] = await Promise.all([
    vi.importActual<typeof import('#usecases/check.js')>('#usecases/check.js'),
    vi.importActual<typeof import('#usecases/check-report.js')>('#usecases/check-report.js'),
  ]);
  mocks.check.mockImplementation(realCheck);
  mocks.buildCheckReport.mockImplementation(realBuildCheckReport);
}

describe('runCheckCommand', () => {
  it('returns identities relative to the config-resolved root rather than cwd', async () => {
    const storage = createInMemoryStorage();
    const projectRoot = '/workspace/config-parent';
    const cwd = `${projectRoot}/nested-cwd`;
    const output = {
      exitCode: 5 as const,
      envelope: { schemaVersion: '3.0' as const, command: 'check' as const, startedAt: '2026-08-01T00:00:00Z', durationMs: 1, summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, errors: [], results: [{ id: `${cwd}/tests/login.test.md`, file: `${cwd}/tests/login.test.md`, planFile: `${cwd}/tests/login.ambercast.plan.json`, status: 'fresh', reason: 'fresh' }] },
    };
    mocks.createFsReadStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue({ ...CONFIG, projectRoot, testDir: `${projectRoot}/tests`, runsDir: `${projectRoot}/tests/.runs` });
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
    mocks.check.mockResolvedValue({ results: [], errors: [], noTestsFound: true });
    mocks.buildCheckReport.mockReturnValue(output);

    const returned = await runCheckCommand(input({ cwd }));

    expect(returned.envelope.results).toMatchObject([{
      id: 'nested-cwd/tests/login.test.md',
      file: 'nested-cwd/tests/login.test.md',
      planFile: 'nested-cwd/tests/login.ambercast.plan.json',
    }]);
    expect(returned.envelope.results[0]).not.toMatchObject({ id: `${cwd}/tests/login.test.md` });
    expect(returned.envelope.results[0]).not.toMatchObject({ id: 'tests/login.test.md' });
  });

  it('uses cwd as project root after a successful no-config resolution', async () => {
    const storage = createInMemoryStorage();
    const cwd = '/workspace/no-config-project';
    const config = { ...CONFIG, projectRoot: cwd, testDir: `${cwd}/tests`, runsDir: `${cwd}/tests/.runs` };
    const output = { exitCode: 0 as const, envelope: { schemaVersion: '3.0', command: 'check', startedAt: '2026-08-01T00:00:00Z', durationMs: 1, summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, errors: [], results: [{ id: `${cwd}/tests/login.test.md`, file: `${cwd}/tests/login.test.md`, planFile: `${cwd}/tests/login.ambercast.plan.json`, status: 'fresh', reason: 'fresh' }] } };
    mocks.createFsReadStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
    mocks.check.mockResolvedValue({ results: [], errors: [], noTestsFound: false });
    mocks.buildCheckReport.mockReturnValue(output);

    const returned = await runCheckCommand(input({ cwd }));

    expect(config.projectRoot).toBe(cwd);
    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    expect(mocks.loadConfig.mock.calls[0]?.[0]).not.toHaveProperty('configPathOverride');
    expect(returned.envelope.results).toMatchObject([{
      id: 'tests/login.test.md',
      file: 'tests/login.test.md',
      planFile: 'tests/login.ambercast.plan.json',
    }]);
  });

  it('translates a configuration-load failure into a run-scoped report', async () => {
    await useRealCheckComposition();
    mocks.createFsReadStorage.mockReturnValue(createInMemoryStorage());
    mocks.loadConfig.mockRejectedValue(new ConfigInvalidError('invalid config'));

    await expect(runCheckCommand(input())).resolves.toMatchObject({
      exitCode: 2,
      envelope: {
        command: 'check',
        results: [],
        errors: [{ scope: 'run', code: 'CONFIG_INVALID', message: 'invalid config' }],
      },
    });
  });

  it('composes real layout arithmetic with an in-memory filesystem for a fresh plan', async () => {
    await useRealCheckComposition();
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver(CONFIG);
    const testPath = `${CONFIG.testDir}/login.test.md`;
    const prompt = '# Sign in\n\nI reach the dashboard.\n';
    const plan = {
      schemaVersion: 2,
      source: {
        inputsDigest: computeInputsDigest({
          normalizedTestMd: normalizeTestMd(prompt),
          schemaVersion: 2,
          generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
          targetDefinitions: { web: { baseUrl: CONFIG.targets.web!.baseUrl, browser: CONFIG.targets.web!.browser } },
        }),
      },
      targets: { web: { baseUrl: CONFIG.targets.web!.baseUrl, browser: CONFIG.targets.web!.browser } },
      steps: [],
    } as unknown as PlanDocument;
    await storage.writeText(testPath, prompt);
    await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
    await storage.writeText(layout.groundingPathFor(testPath), toCanonicalArtifactText({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: {},
    }));
    mocks.createFsReadStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);

    const output = await runCheckCommand(input({ files: ['tests/login.test.md'] }));

    expect(ReportEnvelope.parse(output.envelope)).toMatchObject({
      command: 'check',
      summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
      errors: [],
      results: [{
        id: 'tests/login.test.md',
        file: 'tests/login.test.md',
        planFile: 'tests/login.ambercast.plan.json',
        status: 'fresh',
      }],
    });
    expect(output.exitCode).toBe(0);
    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
    expect(mocks.createFsTestFileDiscovery).toHaveBeenCalledOnce();
  });

  it('forwards check policies, target, cancellation, and configuration override through runtime composition', async () => {
    const storage = createInMemoryStorage();
    const discoverTestFiles = vi.fn(async () => []);
    const signal = new AbortController().signal;
    const config = {
      ...CONFIG,
      testDir: '/workspace/overridden-tests',
      runsDir: '/workspace/overridden-tests/.runs',
      targets: { admin: { baseUrl: 'https://admin.example.test', browser: 'chromium', healReplayIsolation: 'stateful' } },
      defaultTarget: 'admin',
    } as const satisfies ResolvedConfig;
    const outcome = { noTestsFound: true, results: [], errors: [] } as const;
    const report = {
      exitCode: 0 as const,
      envelope: {
        schemaVersion: '3.0' as const,
        command: 'check' as const,
        startedAt: '2026-08-17T00:00:00Z',
        durationMs: 0,
        summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
        errors: [],
        results: [],
      },
    };
    mocks.createFsReadStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(config);
    mocks.createFsTestFileDiscovery.mockReturnValue(discoverTestFiles);
    mocks.check.mockResolvedValue(outcome);
    mocks.buildCheckReport.mockReturnValue(report);

    await expect(runCheckCommand(input({
      files: ['ui/login.test.md'],
      target: 'admin',
      allowEmpty: true,
      list: true,
      configPathOverride: 'configs/admin.json',
      cwd: '/workspace/project',
      signal,
    }))).resolves.toEqual(report);

    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace/project',
      configPathOverride: 'configs/admin.json',
    }));
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      storage,
      config,
      discoverTestFiles,
      signal,
    }), {
      files: ['/workspace/project/ui/login.test.md'],
      target: 'admin',
      allowEmpty: true,
      list: true,
    });
    expect(mocks.buildCheckReport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      outcome,
      options: { allowEmpty: true, list: true },
    }));
  });

  it('wraps an unclassified composition failure as an unexpected-crash report', async () => {
    await useRealCheckComposition();
    mocks.createFsReadStorage.mockReturnValue(createInMemoryStorage());
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
    mocks.check.mockRejectedValue(new Error('unclassified failure'));

    const output = await runCheckCommand(input());

    expect(output.exitCode).toBe(3);
    expect(output.envelope.errors).toEqual([expect.objectContaining({
      scope: 'run',
      kind: 'environment',
      code: 'UNEXPECTED_CRASH',
    })]);
  });

  it('finalizes both completed and error reports at the runtime boundary', async () => {
    const completed = {
      exitCode: 0 as const,
      envelope: { schemaVersion: '3.0' as const, command: 'check' as const, startedAt: '2026-08-01T00:00:00Z', durationMs: 0, summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }, errors: [], results: [] },
    };
    mocks.createFsReadStorage.mockReturnValue(createInMemoryStorage());
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
    mocks.check.mockResolvedValue({ results: [], errors: [], noTestsFound: false });
    mocks.buildCheckReport.mockReturnValue(completed);
    mocks.finalizeReportEnvelope.mockImplementation((raw) => raw);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(false);

    await runCheckCommand(input());
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledWith(completed.envelope, '/workspace');
    mocks.finalizeReportEnvelope.mockClear();
    mocks.check.mockRejectedValueOnce(new Error('crash'));
    await runCheckCommand(input());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledWith(expect.objectContaining({ command: 'check' }), '/workspace');
  });

  it.each(['completed', 'error'] as const)('forces exit 3 when %s finalization returns the emergency singleton', async (branch) => {
    const built = {
      exitCode: 0 as const,
      envelope: { schemaVersion: '3.0' as const, command: 'check' as const, startedAt: '2026-08-01T00:00:00Z', durationMs: 0, summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }, errors: [], results: [] },
    };
    mocks.createFsReadStorage.mockReturnValue(createInMemoryStorage());
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);
    mocks.check.mockResolvedValue({ results: [], errors: [], noTestsFound: false });
    mocks.buildCheckReport.mockReturnValue(built);
    if (branch === 'error') {
      mocks.loadConfig.mockRejectedValue(new ConfigInvalidError('invalid config'));
    }
    mocks.finalizeReportEnvelope.mockReturnValue(built.envelope);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(true);

    await expect(runCheckCommand(input())).resolves.toEqual({
      exitCode: 3,
      envelope: built.envelope,
    });
  });
});
