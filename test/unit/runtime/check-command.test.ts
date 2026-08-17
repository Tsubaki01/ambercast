import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type { JsonValueT, PlanDocument } from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { ReportEnvelope } from '#report/schema.js';
import { runCheckCommand, type CheckCommandInput } from '#runtime/check-command.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createFsStorage: vi.fn(),
  createFsTestFileDiscovery: vi.fn(),
  check: vi.fn(),
  buildCheckReport: vi.fn(),
}));

vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#adapters/storage/fs-storage.js', () => ({ createFsStorage: mocks.createFsStorage }));
vi.mock('#runtime/test-file-discovery.js', () => ({ createFsTestFileDiscovery: mocks.createFsTestFileDiscovery }));
vi.mock('#usecases/check.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('#usecases/check.js')>(),
  check: mocks.check,
}));
vi.mock('#usecases/check-report.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('#usecases/check-report.js')>(),
  buildCheckReport: mocks.buildCheckReport,
}));

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

function input(overrides: Partial<CheckCommandInput> = {}): CheckCommandInput {
  return { files: [], allowEmpty: false, list: false, cwd: '/workspace', ...overrides };
}

afterEach(() => {
  vi.resetAllMocks();
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
  it('translates a configuration-load failure into a run-scoped report', async () => {
    await useRealCheckComposition();
    mocks.createFsStorage.mockReturnValue(createInMemoryStorage());
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
    const plan: PlanDocument = {
      schemaVersion: 1,
      source: {
        inputsDigest: computeInputsDigest({
          normalizedTestMd: normalizeTestMd(prompt),
          schemaVersion: 1,
          generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
          targetDefinitions: { web: CONFIG.targets.web! },
        }),
      },
      targets: { web: CONFIG.targets.web! },
      steps: [],
    };
    await storage.writeText(testPath, prompt);
    await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
    mocks.createFsStorage.mockReturnValue(storage);
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.createFsTestFileDiscovery.mockReturnValue(async () => []);

    const output = await runCheckCommand(input({ files: ['tests/login.test.md'] }));

    expect(ReportEnvelope.parse(output.envelope)).toMatchObject({
      command: 'check',
      summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
      errors: [],
      results: [{
        id: testPath,
        file: testPath,
        planFile: layout.planPathFor(testPath),
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
      targets: { admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' } },
      defaultTarget: 'admin',
    } as const satisfies ResolvedConfig;
    const outcome = { noTestsFound: true, results: [], errors: [] } as const;
    const report = {
      exitCode: 0 as const,
      envelope: {
        schemaVersion: '1.0' as const,
        command: 'check' as const,
        startedAt: '2026-08-17T00:00:00Z',
        durationMs: 0,
        summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
        errors: [],
        results: [],
      },
    };
    mocks.createFsStorage.mockReturnValue(storage);
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
    mocks.createFsStorage.mockReturnValue(createInMemoryStorage());
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
});
