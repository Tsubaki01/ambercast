import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  type GroundingDocument,
  type JsonValueT,
  type PlanDocument,
  type TargetDefinition,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { check, type CheckDeps, type CheckOptions } from '#usecases/check.js';
import { BatchInterruptionTracker } from '#usecases/batch-interruption.js';
import { buildCheckReport } from '#usecases/check-report.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const OPTIONS: CheckOptions = { files: [], allowEmpty: false, list: false };

type TestConfig = CheckDeps['config'];

function createConfig(overrides: Partial<TestConfig> = {}): TestConfig {
  return {
    testDir: TEST_DIR,
    testMatch: ['**/*.test.md'],
    testIgnore: ['**/.runs/**'],
    targets: TARGETS,
    defaultTarget: 'web',
    ...overrides,
  };
}

function freshPlan(prompt = PROMPT, targetDefinitions: Readonly<Record<string, TargetDefinition>> = TARGETS): PlanDocument {
  return {
    schemaVersion: 2,
    source: {
      inputsDigest: computeInputsDigest({
        normalizedTestMd: normalizeTestMd(prompt),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        targetDefinitions,
      }),
    },
    targets: targetDefinitions,
    steps: [],
  } as unknown as PlanDocument;
}

async function writePlan(
  storage: ReturnType<typeof createInMemoryStorage>,
  layout: ReturnType<typeof createLayoutResolver>,
  testPath: string,
  plan = freshPlan(),
): Promise<PlanDocument> {
  await storage.writeText(
    layout.planPathFor(testPath),
    toCanonicalArtifactText(plan as unknown as JsonValueT),
  );
  return plan;
}

async function writeGrounding(
  storage: ReturnType<typeof createInMemoryStorage>,
  layout: ReturnType<typeof createLayoutResolver>,
  testPath: string,
  plan: PlanDocument,
  entries: GroundingDocument['entries'] = {},
  planDigest = computePlanDigest(plan),
): Promise<void> {
  const grounding: GroundingDocument = { schemaVersion: 1, planDigest, entries };
  await storage.writeText(
    layout.groundingPathFor(testPath),
    toCanonicalArtifactText(grounding as unknown as JsonValueT),
  );
}

function createDiscovery(
  testFiles: readonly string[] = [],
  planFiles: readonly string[] = [],
  groundingFiles: readonly string[] = [],
): CheckDeps['discoverTestFiles'] {
  return async ({ testMatch }) => {
    const pattern = testMatch[0];
    if (pattern === '**/*.test.md') {
      return testFiles;
    }
    if (pattern === '**/*.ambercast.plan.json') {
      return planFiles;
    }
    if (pattern === '**/*.ambercast.grounding.json') {
      return groundingFiles;
    }
    throw new Error(`Unexpected test-match pattern: ${pattern}`);
  };
}

function createScenario(overrides: Partial<CheckDeps> = {}) {
  const storage = createInMemoryStorage();
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const deps: CheckDeps = {
    storage,
    layout,
    discoverTestFiles: createDiscovery(),
    config: createConfig(),
    ...overrides,
  };

  return { storage, layout, deps };
}

async function captureTargetFailure(operation: Promise<unknown>): Promise<TargetUnresolvedError> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TargetUnresolvedError);
  if (!(error instanceof TargetUnresolvedError)) {
    throw new Error('Expected check to reject with TargetUnresolvedError.');
  }
  return error;
}

describe('check', () => {
  it('reports a schema-valid Plan v2 with impossible committed instruction provenance as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/invalid-coverage.test.md`;
    await storage.writeText(testPath, PROMPT);
    const plan = {
      ...freshPlan(),
      steps: [{
        id: 'reach-dashboard',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        instructionCoverage: [{
          id: 'dashboard-reached',
          kind: 'success',
          sourceSpan: { startLine: 99, startColumn: 1, endLine: 99, endColumn: 2 },
        }],
      }],
    };
    await storage.writeText(
      layout.planPathFor(testPath),
      toCanonicalArtifactText(plan as unknown as JsonValueT),
    );

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/instruction|coverage|span/i) }],
    });
  });

  it('reports a Plan v2 with locally valid covered provenance and covered grounding as fresh', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/valid-coverage.test.md`;
    await storage.writeText(testPath, PROMPT);
    const plan = {
      ...freshPlan(),
      steps: [{
        id: 'reach-dashboard',
        kind: 'ai',
        instruction: 'Use the UI to complete the scenario.',
        instructionCoverage: [{
          id: 'dashboard-reached',
          kind: 'success',
          sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 },
        }],
      }],
    } as unknown as PlanDocument;
    await writePlan(storage, layout, testPath, plan);
    await writeGrounding(storage, layout, testPath, plan, {
      'reach-dashboard': {
        kind: 'ai',
        trace: {
          events: [],
          verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
          verificationCoverage: { 'dashboard-reached': 0 },
        },
      },
    } as GroundingDocument['entries']);

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'fresh' }],
      errors: [],
    });
  });

  it('discovers nested relative test paths and anchors their findings to the configured test directory', async () => {
    const relativeTestPath = 'ui/login.test.md';
    const testPath = `${TEST_DIR}/${relativeTestPath}`;
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => (
      testMatch[0] === '**/*.test.md' ? [relativeTestPath] : []
    ));
    const { storage, layout, deps } = createScenario({ discoverTestFiles });
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);

    const outcome = await check(deps, OPTIONS);

    expect(discoverTestFiles).toHaveBeenNthCalledWith(1, {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
    });
    expect(outcome.results).toEqual([expect.objectContaining({
      id: testPath,
      file: testPath,
      planFile: layout.planPathFor(testPath),
      status: 'fresh',
    })]);
  });

  it('reports a fresh plan with cold empty grounding', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/cold.test.md`;
    await storage.writeText(testPath, PROMPT);
    const plan = await writePlan(storage, layout, testPath);
    await writeGrounding(storage, layout, testPath, plan);

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, file: testPath, planFile: layout.planPathFor(testPath), status: 'fresh' }],
      errors: [],
      noTestsFound: false,
    });
  });

  it('reports a fresh plan with updated grounding entries', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/updated.test.md`;
    await storage.writeText(testPath, PROMPT);
    const plan = await writePlan(storage, layout, testPath);
    await writeGrounding(storage, layout, testPath, plan, {
      'click-submit': {
        kind: 'element',
        fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) },
      },
    });

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'fresh' }],
    });
  });

  it('keeps a digest-mismatched grounding fresh when the canonical plan matches inputs', async () => {
    const testPath = `${TEST_DIR}/grounding-digest.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], [], ['grounding-digest.ambercast.grounding.json']),
    });
    await storage.writeText(testPath, PROMPT);
    const plan = await writePlan(storage, layout, testPath);
    await writeGrounding(storage, layout, testPath, plan, {}, 'b'.repeat(64));

    const outcome = await check(deps, { ...OPTIONS, files: [testPath] });

    expect(outcome.results).toEqual([expect.objectContaining({ id: testPath, status: 'fresh' })]);
    expect(outcome.results).not.toContainEqual(expect.objectContaining({
      id: testPath,
      status: 'orphaned-grounding',
    }));
  });

  it('keeps invalid JSON in a discovered grounding artifact from demoting a fresh plan', async () => {
    const testPath = `${TEST_DIR}/malformed-grounding.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], [], ['malformed-grounding.ambercast.grounding.json']),
    });
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);
    await storage.writeText(layout.groundingPathFor(testPath), '{not JSON');

    const outcome = await check(deps, { ...OPTIONS, files: [testPath] });

    expect(outcome.results).toEqual([expect.objectContaining({ id: testPath, status: 'fresh' })]);
    expect(outcome.results).not.toContainEqual(expect.objectContaining({
      id: testPath,
      status: 'orphaned-grounding',
    }));
  });

  it('reports a missing expected plan with its expected path and a reason', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/missing.test.md`;
    await storage.writeText(testPath, PROMPT);

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{
        id: testPath,
        file: testPath,
        planFile: layout.planPathFor(testPath),
        status: 'missing-plan',
        reason: expect.any(String),
      }],
    });
  });

  it('reports a prompt-digest mismatch as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/changed-prompt.test.md`;
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);
    await storage.writeText(testPath, `${PROMPT}The requirement changed.\n`);

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/stale/i) }],
    });
  });

  it('reports malformed JSON plans as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/malformed.test.md`;
    await storage.writeText(testPath, PROMPT);
    await storage.writeText(layout.planPathFor(testPath), '{not JSON');

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/JSON/i) }],
    });
  });

  it('reports schema-invalid plans as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/invalid-schema.test.md`;
    await storage.writeText(testPath, PROMPT);
    await storage.writeText(layout.planPathFor(testPath), JSON.stringify({ schemaVersion: 1 }));

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/schema/i) }],
    });
  });

  it('reports valid but non-canonical plan text as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/noncanonical.test.md`;
    await storage.writeText(testPath, PROMPT);
    const plan = freshPlan();
    await storage.writeText(layout.planPathFor(testPath), JSON.stringify(plan, null, 4));

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/canonical/i) }],
    });
  });

  it('reports a schema-valid plan that cannot be canonicalized as stale', async () => {
    const { storage, layout, deps } = createScenario();
    const testPath = `${TEST_DIR}/noncanonicalizable.test.md`;
    await storage.writeText(testPath, PROMPT);
    await storage.writeText(layout.planPathFor(testPath), JSON.stringify({
      ...freshPlan(),
      generatorMeta: { bad: '\uD800' },
    }));

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'stale', reason: 'The plan cannot be canonically verified.' }],
      errors: [],
    });
  });

  it('reports an orphaned plan after selected findings even when literal files narrow selection', async () => {
    const selectedPath = `${TEST_DIR}/selected.test.md`;
    const orphanPath = `${TEST_DIR}/removed.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], ['removed.ambercast.plan.json']),
    });
    await storage.writeText(selectedPath, PROMPT);
    await writePlan(storage, layout, selectedPath);
    await storage.writeText(layout.planPathFor(orphanPath), '{}');

    await expect(check(deps, { ...OPTIONS, files: [selectedPath] })).resolves.toMatchObject({
      results: [
        { id: selectedPath, status: 'fresh' },
        {
          id: orphanPath,
          file: orphanPath,
          planFile: layout.planPathFor(orphanPath),
          status: 'orphaned-plan',
          reason: expect.any(String),
        },
      ],
    });
  });

  it('reports an orphaned grounding with a path-free reason and retains its path only in groundingFile', async () => {
    const orphanPath = `${TEST_DIR}/removed.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], [], ['removed.ambercast.grounding.json']),
    });
    const groundingPath = layout.groundingPathFor(orphanPath);
    await storage.writeText(groundingPath, '{}');

    await expect(check(deps, OPTIONS)).resolves.toMatchObject({
      results: [{
        id: orphanPath,
        file: orphanPath,
        planFile: layout.planPathFor(orphanPath),
        groundingFile: groundingPath,
        status: 'orphaned-grounding',
        reason: 'No corresponding test file exists for this grounding artifact.',
      }],
    });
  });

  it('preserves selected and orphan ordering while counting a mixed batch', async () => {
    const freshPath = `${TEST_DIR}/fresh.test.md`;
    const stalePath = `${TEST_DIR}/stale.test.md`;
    const orphanedPlanPath = `${TEST_DIR}/orphaned-plan.test.md`;
    const orphanedGroundingPath = `${TEST_DIR}/orphaned-grounding.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery(
        [],
        ['orphaned-plan.ambercast.plan.json'],
        ['orphaned-grounding.ambercast.grounding.json'],
      ),
    });
    await storage.writeText(freshPath, PROMPT);
    await writePlan(storage, layout, freshPath);
    await storage.writeText(stalePath, PROMPT);
    await writePlan(storage, layout, stalePath, freshPlan(`${PROMPT}stale`));
    await storage.writeText(layout.planPathFor(orphanedPlanPath), '{}');
    await storage.writeText(layout.groundingPathFor(orphanedGroundingPath), '{}');

    const outcome = await check(deps, { ...OPTIONS, files: [freshPath, stalePath] });

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: freshPath, status: 'fresh' }),
      expect.objectContaining({ id: stalePath, status: 'stale' }),
      expect.objectContaining({ id: orphanedPlanPath, status: 'orphaned-plan' }),
      expect.objectContaining({ id: orphanedGroundingPath, status: 'orphaned-grounding' }),
    ]);
    expect({
      fresh: outcome.results.filter(({ status }) => status === 'fresh').length,
      stale: outcome.results.filter(({ status }) => status === 'stale').length,
      orphanedPlan: outcome.results.filter(({ status }) => status === 'orphaned-plan').length,
      orphanedGrounding: outcome.results.filter(({ status }) => status === 'orphaned-grounding').length,
    }).toEqual({ fresh: 1, stale: 1, orphanedPlan: 1, orphanedGrounding: 1 });
    expect(outcome.errors).toEqual([]);
  });

  it('keeps processing after a prompt read error while retaining two non-fresh results', async () => {
    const missingPath = `${TEST_DIR}/missing.test.md`;
    const failingPath = `${TEST_DIR}/read-fails.test.md`;
    const stalePath = `${TEST_DIR}/stale.test.md`;
    const { storage, layout, deps } = createScenario();
    await storage.writeText(missingPath, PROMPT);
    await storage.writeText(failingPath, PROMPT);
    await storage.writeText(stalePath, PROMPT);
    await writePlan(storage, layout, failingPath);
    await writePlan(storage, layout, stalePath, freshPlan(`${PROMPT}changed`));
    const readText = vi.fn(async (path: string) => {
      if (path === failingPath) {
        throw new Error('prompt read failed');
      }
      return storage.readText(path);
    });

    const outcome = await check({ ...deps, storage: { readText, exists: storage.exists } }, {
      ...OPTIONS,
      files: [missingPath, failingPath, stalePath],
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: missingPath, status: 'missing-plan' }),
      expect.objectContaining({ id: stalePath, status: 'stale' }),
    ]);
    expect(outcome.errors).toEqual([expect.objectContaining({
      file: failingPath,
      error: expect.objectContaining({ kind: 'fs-io-error' }),
    })]);
    expect(outcome.noTestsFound).toBe(false);
  });

  it('keeps non-empty check results and errors byte-identical in list mode', async () => {
    const testPath = `${TEST_DIR}/listed.test.md`;
    const { storage, layout, deps } = createScenario();
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);

    const ordinary = await check(deps, { ...OPTIONS, files: [testPath] });
    const listed = await check(deps, { ...OPTIONS, files: [testPath], list: true });

    expect(JSON.stringify(listed.results)).toBe(JSON.stringify(ordinary.results));
    expect(JSON.stringify(listed.errors)).toBe(JSON.stringify(ordinary.errors));
  });

  it('makes the selected target participate in freshness but ignores unrelated targets', async () => {
    const testPath = `${TEST_DIR}/targets.test.md`;
    const planTargets = {
      web: TARGETS.web,
      admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' },
    } as const;
    const changedSelectedTargets = {
      ...planTargets,
      web: { baseUrl: 'https://changed.example.test', browser: 'chromium' },
    } as const;
    const changedUnrelatedTargets = {
      ...planTargets,
      admin: { baseUrl: 'https://changed-admin.example.test', browser: 'chromium' },
    } as const;
    const { storage, layout } = createScenario();
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath, freshPlan(PROMPT, { web: planTargets.web }));

    await expect(check({
      storage,
      layout,
      discoverTestFiles: createDiscovery(),
      config: createConfig({ targets: changedSelectedTargets, defaultTarget: 'web' }),
    }, { ...OPTIONS, files: [testPath], target: 'web' })).resolves.toMatchObject({
      results: [{ status: 'stale' }],
    });
    await expect(check({
      storage,
      layout,
      discoverTestFiles: createDiscovery(),
      config: createConfig({ targets: changedUnrelatedTargets, defaultTarget: 'web' }),
    }, { ...OPTIONS, files: [testPath], target: 'web' })).resolves.toMatchObject({
      results: [{ status: 'fresh' }],
    });
  });

  it.each([
    ['a non-empty literal selection', [`${TEST_DIR}/login.test.md`]],
    ['an empty selection', []],
  ] as const)('throws the shared exact error for an invalid explicit target with %s', async (
    _selection,
    files,
  ) => {
    const { deps } = createScenario();

    const error = await captureTargetFailure(check(deps, {
      ...OPTIONS,
      files,
      target: 'missing',
    }));

    expect(error).toMatchObject({
      kind: 'target-unresolved',
      exitCode: 2,
      message: 'The requested target is not configured.',
    });
    expect(error.details).toEqual({ target: 'missing' });
  });

  it.each([
    ['an empty selection', []],
    ['a non-empty selection', [`${TEST_DIR}/login.test.md`]],
  ] as const)('rejects the inherited constructor target for %s without default fallback', async (
    _selection,
    files,
  ) => {
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(createDiscovery());
    const config = createConfig();
    expect(Object.hasOwn(config.targets, 'web')).toBe(true);
    expect(config.defaultTarget).toBe('web');
    expect(Object.hasOwn(config.targets, 'constructor')).toBe(false);
    expect(config.targets.constructor).toBe(Object.prototype.constructor);
    const { deps } = createScenario({ config, discoverTestFiles });

    const error = await captureTargetFailure(check(deps, {
      ...OPTIONS,
      files,
      target: 'constructor',
    }));

    expect(error).toMatchObject({
      kind: 'target-unresolved',
      exitCode: 2,
      message: 'The requested target is not configured.',
    });
    expect(error.details).toEqual({ target: 'constructor' });
    expect(discoverTestFiles).not.toHaveBeenCalled();
  });

  it('validates an explicit target before test discovery can reject', async () => {
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async () => {
      throw new Error('test directory is unreadable');
    });
    const { deps } = createScenario({ discoverTestFiles });

    const error = await captureTargetFailure(check(deps, { ...OPTIONS, target: 'missing' }));

    expect(error).toMatchObject({
      kind: 'target-unresolved',
      exitCode: 2,
      message: 'The requested target is not configured.',
    });
    expect(error.details).toEqual({ target: 'missing' });
    expect(discoverTestFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['literal selection', [`${TEST_DIR}/login.test.md`], createDiscovery()],
    ['discovery-derived selection', [], createDiscovery(['login.test.md'])],
  ] as const)('throws the shared ambiguity error for a non-empty %s', async (
    _selection,
    files,
    discovery,
  ) => {
    const { defaultTarget: _defaultTarget, ...ambiguousConfig } = createConfig();
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(discovery);
    const { storage, deps } = createScenario({
      discoverTestFiles,
      config: {
        ...ambiguousConfig,
        targets: {
          web: TARGETS.web,
          admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' },
        },
      },
    });
    const exists = vi.spyOn(storage, 'exists');
    const readText = vi.spyOn(storage, 'readText');

    const error = await captureTargetFailure(check(deps, { ...OPTIONS, files }));

    expect(error).toMatchObject({
      kind: 'target-unresolved',
      exitCode: 2,
      message: 'A target could not be selected from the configured targets.',
    });
    expect(error.details).toEqual({ target: '(default)', targetNames: ['admin', 'web'] });
    expect(discoverTestFiles).toHaveBeenCalledTimes(files.length === 0 ? 1 : 0);
    expect(exists).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it('uses a sole implicit target for freshness when defaultTarget is absent', async () => {
    const testPath = `${TEST_DIR}/implicit.test.md`;
    const soleTargets = {
      replacement: { baseUrl: 'https://replacement.example.test', browser: 'chromium' as const },
    };
    const { defaultTarget: _defaultTarget, ...configWithoutDefault } = createConfig();
    const { storage, layout, deps } = createScenario({
      config: { ...configWithoutDefault, targets: soleTargets },
    });
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath, freshPlan(PROMPT, soleTargets));

    await expect(check(deps, { ...OPTIONS, files: [testPath] })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'fresh' }],
      errors: [],
    });
  });

  it.each([
    ['the configured default', undefined, 'web'],
    ['an explicit override', 'admin', 'admin'],
  ] as const)('uses %s as the only freshness target', async (
    _selection,
    target,
    expectedName,
  ) => {
    const testPath = `${TEST_DIR}/${expectedName}.test.md`;
    const targets = {
      web: TARGETS.web,
      admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' as const },
    };
    const { storage, layout, deps } = createScenario({
      config: createConfig({ targets, defaultTarget: 'web' }),
    });
    await storage.writeText(testPath, PROMPT);
    await writePlan(
      storage,
      layout,
      testPath,
      freshPlan(PROMPT, { [expectedName]: targets[expectedName] }),
    );

    await expect(check(deps, {
      ...OPTIONS,
      files: [testPath],
      ...(target === undefined ? {} : { target }),
    })).resolves.toMatchObject({
      results: [{ id: testPath, status: 'fresh' }],
    });
  });

  it('skips unresolved implicit target resolution for an orphan-only scan', async () => {
    const orphanPath = `${TEST_DIR}/orphan.test.md`;
    const { defaultTarget: _defaultTarget, ...ambiguousConfig } = createConfig();
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], ['orphan.ambercast.plan.json']),
      config: {
        ...ambiguousConfig,
        targets: {
          web: TARGETS.web,
          admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' },
        },
      },
    });
    await storage.writeText(layout.planPathFor(orphanPath), '{}');

    await expect(check(deps, OPTIONS)).resolves.toMatchObject({
      results: [{ id: orphanPath, status: 'orphaned-plan' }],
      noTestsFound: false,
    });
  });

  it('returns a genuine empty outcome when no tests and no orphaned artifacts exist', async () => {
    const { deps } = createScenario();

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true, interrupted: false });
  });

  it('does not call an orphan-only tree a genuine empty outcome', async () => {
    const orphanPath = `${TEST_DIR}/orphan.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], ['orphan.ambercast.plan.json']),
    });
    await storage.writeText(layout.planPathFor(orphanPath), '{}');

    await expect(check(deps, OPTIONS)).resolves.toMatchObject({
      noTestsFound: false,
      results: [{ id: orphanPath, status: 'orphaned-plan' }],
    });
  });

  it('keeps an ignored orphaned-plan directory out of artifact findings', async () => {
    const ignoredPath = `${TEST_DIR}/fixtures/removed.test.md`;
    const { storage, layout, deps } = createScenario({
      config: createConfig({ testIgnore: ['**/.runs/**', '**/fixtures/**'] }),
      discoverTestFiles: async ({ testMatch, testIgnore }) => (
        testMatch[0] === '**/*.ambercast.plan.json' && !testIgnore.includes('**/fixtures/**')
          ? ['fixtures/removed.ambercast.plan.json']
          : []
      ),
    });
    await storage.writeText(layout.planPathFor(ignoredPath), '{}');

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true, interrupted: false });
  });

  it.each([
    ['plan', 'removed.ambercast.plan.json', 'orphaned-plan'],
    ['grounding', 'removed.ambercast.grounding.json', 'orphaned-grounding'],
  ] as const)('removes both self-referential default ignores so orphaned %ss are still discovered', async (
    _artifact,
    artifactFile,
    status,
  ) => {
    const orphanPath = `${TEST_DIR}/removed.test.md`;
    const planArtifact = artifactFile.endsWith('.ambercast.plan.json');
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch, testIgnore: _testIgnore }) => {
      const expectedPattern = planArtifact
        ? '**/*.ambercast.plan.json'
        : '**/*.ambercast.grounding.json';
      return testMatch[0] === expectedPattern ? [artifactFile] : [];
    });
    const { storage, layout, deps } = createScenario({
      config: createConfig({ testIgnore: DEFAULT_RAW_CONFIG.testIgnore }),
      discoverTestFiles,
    });
    await storage.writeText(planArtifact ? layout.planPathFor(orphanPath) : layout.groundingPathFor(orphanPath), '{}');

    const outcome = await check(deps, OPTIONS);

    expect(discoverTestFiles).toHaveBeenCalledWith({
      testDir: TEST_DIR,
      testMatch: [planArtifact ? '**/*.ambercast.plan.json' : '**/*.ambercast.grounding.json'],
      testIgnore: ['**/.runs/**'],
    });
    expect(outcome.results).toEqual([expect.objectContaining({ id: orphanPath, status })]);
  });

  it('keeps the unrelated default .runs ignore during artifact discovery', async () => {
    const orphanPath = `${RUNS_DIR}/removed.test.md`;
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch, testIgnore }) => (
      testMatch[0] === '**/*.ambercast.plan.json' && !testIgnore.includes('**/.runs/**')
        ? ['.runs/removed.ambercast.plan.json']
        : []
    ));
    const { storage, layout, deps } = createScenario({
      config: createConfig({ testIgnore: DEFAULT_RAW_CONFIG.testIgnore }),
      discoverTestFiles,
    });
    await storage.writeText(layout.planPathFor(orphanPath), '{}');

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true, interrupted: false });
    expect(discoverTestFiles).toHaveBeenCalledWith({
      testDir: TEST_DIR,
      testMatch: ['**/*.ambercast.plan.json'],
      testIgnore: ['**/.runs/**'],
    });
  });

  it('records a plan read rejection as a case-scoped FS_IO_ERROR', async () => {
    const testPath = `${TEST_DIR}/plan-read.test.md`;
    const { storage, layout, deps } = createScenario();
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);
    const readText = vi.fn(async (path: string) => {
      if (path === layout.planPathFor(testPath)) {
        throw new Error('plan read failed');
      }
      return storage.readText(path);
    });

    await expect(check({ ...deps, storage: { readText, exists: storage.exists } }, { ...OPTIONS, files: [testPath] }))
      .resolves.toMatchObject({
        results: [],
        errors: [{ file: testPath, error: { kind: 'fs-io-error' } }],
        noTestsFound: false,
      });
  });

  it('records a prompt read rejection as a case-scoped FS_IO_ERROR', async () => {
    const testPath = `${TEST_DIR}/prompt-read.test.md`;
    const { storage, layout, deps } = createScenario();
    await storage.writeText(testPath, PROMPT);
    await writePlan(storage, layout, testPath);
    const readText = vi.fn(async (path: string) => {
      if (path === testPath) {
        throw new Error('prompt read failed');
      }
      return storage.readText(path);
    });

    await expect(check({ ...deps, storage: { readText, exists: storage.exists } }, { ...OPTIONS, files: [testPath] }))
      .resolves.toMatchObject({
        results: [],
        errors: [{ file: testPath, error: { kind: 'fs-io-error' } }],
        noTestsFound: false,
      });
  });

  it.each([
    ['test selection', 1],
    ['plan orphan scan', 2],
    ['grounding orphan scan', 3],
  ] as const)('propagates a %s discovery rejection as a run-scoped failure', async (_name, rejectedCall) => {
    let calls = 0;
    const { deps } = createScenario({
      discoverTestFiles: async () => {
        calls += 1;
        if (calls === rejectedCall) {
          throw new Error('test directory is unreadable');
        }
        return [];
      },
    });

    await expect(check(deps, OPTIONS)).rejects.toThrow('test directory is unreadable');
  });

  it('turns a pre-aborted selected occurrence into a pending skipped row and suppresses orphan discovery', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { deps } = createScenario({ signal: controller.signal });
    const selectedPath = `${TEST_DIR}/login.test.md`;

    await expect(check(deps, { ...OPTIONS, files: [selectedPath] })).resolves.toEqual({
      results: [{ id: selectedPath, file: selectedPath, status: 'skipped' }],
      errors: [],
      noTestsFound: false,
      interrupted: true,
    });
  });

  it('does not inspect orphan phases once pre-aborted selected work has latched interruption', async () => {
    const selectedPath = `${TEST_DIR}/selected.test.md`;
    const orphanedPlanPath = `${TEST_DIR}/deleted-plan.test.md`;
    const orphanedGroundingPath = `${TEST_DIR}/deleted-grounding.test.md`;
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { storage, layout, deps } = createScenario({
      signal: controller.signal,
      discoverTestFiles: createDiscovery(
        [],
        ['deleted-plan.ambercast.plan.json'],
        ['deleted-grounding.ambercast.grounding.json'],
      ),
    });
    await storage.writeText(selectedPath, PROMPT);
    await writePlan(storage, layout, selectedPath);
    await storage.writeText(layout.planPathFor(orphanedPlanPath), '{}');
    await storage.writeText(layout.groundingPathFor(orphanedGroundingPath), '{}');

    const outcome = await check(deps, { ...OPTIONS, files: [selectedPath] });

    expect(outcome.results).toEqual([{ id: selectedPath, file: selectedPath, status: 'skipped' }]);
    expect(outcome.errors).toEqual([]);
    expect(outcome.noTestsFound).toBe(false);
    expect(outcome.interrupted).toBe(true);
  });

  it('retains completed findings and stops before a later stale file after cancellation', async () => {
    const freshPath = `${TEST_DIR}/fresh.test.md`;
    const stalePath = `${TEST_DIR}/stale.test.md`;
    const controller = new AbortController();
    const { storage, layout, deps } = createScenario({ signal: controller.signal });
    await storage.writeText(freshPath, PROMPT);
    await writePlan(storage, layout, freshPath);
    await storage.writeText(stalePath, PROMPT);
    await writePlan(storage, layout, stalePath, freshPlan(`${PROMPT}changed`));
    const readText = vi.fn(async (path: string) => {
      const content = await storage.readText(path);
      if (path === freshPath) {
        controller.abort(new Error('stop after fresh'));
      }
      return content;
    });

    await expect(check({ ...deps, storage: { readText, exists: storage.exists } }, {
      ...OPTIONS,
      files: [freshPath, stalePath],
    })).resolves.toMatchObject({
      results: [{ id: freshPath, status: 'fresh' }, { id: stalePath, status: 'skipped' }],
      errors: [],
      noTestsFound: false,
    });
  });

  it.each(['stale', 'missing-plan', 'orphaned-plan', 'orphaned-grounding'] as const)(
    'keeps %s exclusively in results rather than case errors',
    async (status) => {
      const testPath = `${TEST_DIR}/${status}.test.md`;
      const { storage, layout, deps } = createScenario();
      let options: CheckOptions = { ...OPTIONS, files: [testPath] };
      let caseDeps = deps;

      if (status === 'stale') {
        await storage.writeText(testPath, PROMPT);
        await writePlan(storage, layout, testPath, freshPlan(`${PROMPT}changed`));
      } else if (status === 'missing-plan') {
        await storage.writeText(testPath, PROMPT);
      } else if (status === 'orphaned-plan') {
        await storage.writeText(layout.planPathFor(testPath), '{}');
        options = OPTIONS;
        caseDeps = { ...deps, discoverTestFiles: createDiscovery([], [`${status}.ambercast.plan.json`]) };
      } else {
        await storage.writeText(layout.groundingPathFor(testPath), '{}');
        options = OPTIONS;
        caseDeps = { ...deps, discoverTestFiles: createDiscovery([], [], [`${status}.ambercast.grounding.json`]) };
      }

      await expect(check(caseDeps, options)).resolves.toMatchObject({
        results: [{ id: testPath, status }],
        errors: [],
      });
    },
  );

  it.each([
    ['plan', ['first.ambercast.plan.json', 'second.ambercast.plan.json'], [], `${TEST_DIR}/first.test.md`, `${TEST_DIR}/second.test.md`, 'orphaned-plan'],
    ['grounding', [], ['first.ambercast.grounding.json', 'second.ambercast.grounding.json'], `${TEST_DIR}/first.test.md`, `${TEST_DIR}/second.test.md`, 'orphaned-grounding'],
  ] as const)('stops the %s orphan loop after an interrupted inspection without further storage reads', async (_phase, plans, groundings, first, second, status) => {
    const controller = new AbortController();
    const storage = createInMemoryStorage();
    const exists = vi.fn(async (path: string) => {
      if (path === first) controller.abort(new Error('stop'));
      return false;
    });
    const { deps } = createScenario({
      signal: controller.signal,
      storage: { ...storage, exists },
      discoverTestFiles: createDiscovery([], plans, groundings),
    });

    const outcome = await check(deps, OPTIONS);

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: first, status }),
      { id: second, file: second, status: 'skipped' },
    ]);
    expect(exists).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenCalledWith(first);
    expect(outcome.interrupted).toBe(true);
  });

  it.each([
    ['fresh with cold grounding', 'cold'],
    ['fresh with updated grounding', 'updated'],
    ['stale plan', 'stale'],
    ['missing plan', 'missing'],
    ['orphaned plan', 'orphaned-plan'],
    ['orphaned grounding', 'orphaned-grounding'],
  ] as const)('never writes storage during %s inspection', async (_name, scenario) => {
    const backing = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    const writes = { text: 0, binary: 0, directory: 0 };
    const storage = {
      ...backing,
      async writeText(path: string, text: string): Promise<void> {
        writes.text += 1;
        return backing.writeText(path, text);
      },
      async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
        writes.binary += 1;
        return backing.writeBinary(path, bytes);
      },
      async ensureDir(path: string): Promise<void> {
        writes.directory += 1;
        return backing.ensureDir(path);
      },
    };
    const testPath = `${TEST_DIR}/readonly.test.md`;
    let plan: PlanDocument | undefined;
    let discoverTestFiles = createDiscovery();

    if (scenario === 'cold' || scenario === 'updated' || scenario === 'stale') {
      await backing.writeText(testPath, PROMPT);
      plan = await writePlan(backing, layout, testPath);
    } else if (scenario === 'missing') {
      await backing.writeText(testPath, PROMPT);
    }

    if (scenario === 'cold') {
      if (plan === undefined) {
        throw new Error('Cold-grounding fixtures need a plan.');
      }
      await writeGrounding(backing, layout, testPath, plan);
    } else if (scenario === 'updated') {
      if (plan === undefined) {
        throw new Error('Updated-grounding fixtures need a plan.');
      }
      await writeGrounding(backing, layout, testPath, plan, {
        step: { kind: 'element', fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) } },
      });
    } else if (scenario === 'stale') {
      await backing.writeText(layout.planPathFor(testPath), JSON.stringify(freshPlan(), null, 4));
    } else if (scenario === 'missing') {
      // The fixture intentionally has no companion plan.
    } else if (scenario === 'orphaned-plan') {
      await backing.writeText(layout.planPathFor(`${TEST_DIR}/deleted.test.md`), '{}');
      discoverTestFiles = createDiscovery([], ['deleted.ambercast.plan.json']);
    } else {
      await backing.writeText(layout.groundingPathFor(`${TEST_DIR}/deleted.test.md`), '{}');
      discoverTestFiles = createDiscovery([], [], ['deleted.ambercast.grounding.json']);
    }
    writes.text = 0;
    writes.binary = 0;
    writes.directory = 0;

    await check({
      storage,
      layout,
      discoverTestFiles,
      config: createConfig(),
    }, scenario.startsWith('orphaned') ? OPTIONS : { ...OPTIONS, files: [testPath] });

    expect(writes).toEqual({ text: 0, binary: 0, directory: 0 });
  });

  it('pins the read-only CheckDeps dependency surface at compile time', () => {
    expectTypeOf<keyof CheckDeps>().toEqualTypeOf<
      'storage' | 'layout' | 'discoverTestFiles' | 'config' | 'signal'
    >();
  });
});

describe('check interruption contract', () => {
  it('retains raw-abort phase continuation for an empty selected phase and reports the final interruption fact', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps } = createScenario({ signal: controller.signal, discoverTestFiles: createDiscovery([], [], ['orphan.ambercast.grounding.json']) });

    const outcome = await check(deps, OPTIONS);

    expect(outcome.interrupted).toBe(true);
    expect(outcome.noTestsFound).toBe(false);
    expect(outcome.results).toEqual([expect.objectContaining({ status: 'skipped', id: expect.any(String), file: expect.any(String) })]);
  });

  it.each([
    ['pre-aborted empty selection and empty plan still inspect grounding', [], [], ['deleted.ambercast.grounding.json'], ['tests', 'plans', 'grounding'], false, true],
    ['pre-aborted empty plan and grounding stay a genuine zero match', [], [], [], ['tests', 'plans', 'grounding'], true, false],
    ['latched plan work suppresses grounding discovery', [], ['deleted.ambercast.plan.json'], ['deleted.ambercast.grounding.json'], ['tests', 'plans'], false, true],
  ] as const)('%s with exact phase calls and noTestsFound result', async (_name, tests, plans, groundings, expectedCalls, noTestsFound, interrupted) => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => {
      if (testMatch[0] === '**/*.test.md') { calls.push('tests'); return tests; }
      if (testMatch[0] === '**/*.ambercast.plan.json') { calls.push('plans'); return plans; }
      calls.push('grounding');
      return groundings;
    });
    const { deps } = createScenario({ signal: controller.signal, discoverTestFiles });

    const outcome = await check(deps, OPTIONS);

    expect(calls).toEqual(expectedCalls);
    expect(outcome.noTestsFound).toBe(noTestsFound);
    expect(outcome.interrupted).toBe(interrupted);
  });

  it('atomically registers every grounding response before evaluating an abort and keeps each skipped identity ordered', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => {
      if (testMatch[0] === '**/*.test.md') { calls.push('tests'); return []; }
      if (testMatch[0] === '**/*.ambercast.plan.json') { calls.push('plans'); return []; }
      calls.push('grounding');
      controller.abort();
      return ['first.ambercast.grounding.json', 'second.ambercast.grounding.json'];
    });
    const { deps } = createScenario({ signal: controller.signal, discoverTestFiles });

    const outcome = await check(deps, OPTIONS);

    expect(calls).toEqual(['tests', 'plans', 'grounding']);
    expect(outcome.interrupted).toBe(true);
    expect(outcome.results).toEqual([
      expect.objectContaining({ id: `${TEST_DIR}/first.test.md`, status: 'skipped' }),
      expect.objectContaining({ id: `${TEST_DIR}/second.test.md`, status: 'skipped' }),
    ]);
  });

  it('keeps healthy plan and grounding inspections terminal without emitting rows or suppressing grounding discovery', async () => {
    const calls: string[] = [];
    const exists = vi.fn(async () => true);
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => {
      if (testMatch[0] === '**/*.test.md') { calls.push('tests'); return []; }
      if (testMatch[0] === '**/*.ambercast.plan.json') { calls.push('plans'); return ['healthy.ambercast.plan.json']; }
      calls.push('grounding');
      return ['healthy.ambercast.grounding.json'];
    });
    const { deps } = createScenario({ storage: { ...createInMemoryStorage(), exists }, discoverTestFiles });

    const outcome = await check(deps, OPTIONS);

    expect(calls).toEqual(['tests', 'plans', 'grounding']);
    expect(exists).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ results: [], errors: [], noTestsFound: true, interrupted: false });
  });

  it('retains plan and grounding orphan rows for one identity while summarizing it once', async () => {
    const identity = `${TEST_DIR}/deleted.test.md`;
    const { deps } = createScenario({
      discoverTestFiles: createDiscovery([], ['deleted.ambercast.plan.json'], ['deleted.ambercast.grounding.json']),
    });

    const outcome = await check(deps, OPTIONS);
    const report = buildCheckReport({
      startedAt: '2026-08-17T00:00:00Z', durationMs: 1, options: { allowEmpty: false, list: false }, outcome,
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: identity, status: 'orphaned-plan' }),
      expect.objectContaining({ id: identity, status: 'orphaned-grounding' }),
    ]);
    expect(report.envelope.summary).toEqual({ total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 });
  });

  it('keeps a terminal orphan and a pending same-identity sibling as separate rows, then promotes their summary to skipped', async () => {
    const controller = new AbortController();
    const identity = `${TEST_DIR}/deleted.test.md`;
    const calls: string[] = [];
    const exists = vi.fn(async () => {
      controller.abort();
      return false;
    });
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => {
      if (testMatch[0] === '**/*.test.md') { calls.push('tests'); return []; }
      if (testMatch[0] === '**/*.ambercast.plan.json') { calls.push('plans'); return ['deleted.ambercast.plan.json', 'deleted.ambercast.plan.json']; }
      calls.push('grounding');
      throw new Error('grounding discovery must be suppressed after interruption');
    });
    const { deps } = createScenario({ signal: controller.signal, storage: { ...createInMemoryStorage(), exists }, discoverTestFiles });

    const outcome = await check(deps, OPTIONS);
    const report = buildCheckReport({
      startedAt: '2026-08-17T00:00:00Z', durationMs: 1, options: { allowEmpty: false, list: false }, outcome,
    });

    expect(calls).toEqual(['tests', 'plans']);
    expect(exists).toHaveBeenCalledOnce();
    expect(outcome.results).toEqual([
      expect.objectContaining({ id: identity, status: 'orphaned-plan' }),
      { id: identity, file: identity, status: 'skipped' },
    ]);
    expect(outcome.interrupted).toBe(true);
    expect(report.exitCode).toBe(3);
    expect(report.envelope.summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 });
    expect(report.envelope.errors).toEqual([expect.objectContaining({ scope: 'run', code: 'INTERRUPTED' })]);
  });

  it('retains a selected case error and a later orphan finding with the same public identity, then summarizes that identity once as errored', async () => {
    const testPath = `${TEST_DIR}/same.test.md`;
    const { storage, layout, deps } = createScenario({
      discoverTestFiles: createDiscovery([], ['same.ambercast.plan.json']),
    });
    await storage.writeText(testPath, PROMPT);
    await storage.writeText(layout.planPathFor(testPath), '{invalid JSON');

    const readText = vi.fn(async (path: string) => {
      if (path === layout.planPathFor(testPath)) throw new Error('read failure');
      return storage.readText(path);
    });
    const exists = vi.fn(async (path: string) => path === layout.planPathFor(testPath));
    const outcome = await check({ ...deps, storage: { readText, exists } }, { ...OPTIONS, files: [testPath] });

    expect(outcome.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: testPath, status: 'orphaned-plan' }),
    ]));
    expect(outcome.errors).toEqual(expect.arrayContaining([expect.objectContaining({ file: testPath })]));
  });

  it('retains the terminal selected result, skips only its pending selected suffix, and suppresses later orphan discovery after abort during selected work', async () => {
    const controller = new AbortController();
    const first = `${TEST_DIR}/first.test.md`;
    const second = `${TEST_DIR}/second.test.md`;
    const storage = createInMemoryStorage();
    const exists = vi.fn(async (path: string) => {
      if (path === `${TEST_DIR}/first.ambercast.plan.json`) {
        controller.abort();
      }
      return false;
    });
    const discover = vi.fn<CheckDeps['discoverTestFiles']>(async () => {
      throw new Error('later orphan discovery must be suppressed');
    });
    const { deps } = createScenario({ signal: controller.signal, storage: { ...storage, exists }, discoverTestFiles: discover });

    const outcome = await check(deps, { ...OPTIONS, files: [first, second] });

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: first, status: 'missing-plan' }),
      { id: second, file: second, status: 'skipped' },
    ]);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
    expect(outcome.interrupted).toBe(true);
  });

  it.each([
    ['plan orphan', ['deleted.ambercast.plan.json'], [], `${TEST_DIR}/deleted.test.md`, 'orphaned-plan'],
    ['grounding orphan', [], ['deleted.ambercast.grounding.json'], `${TEST_DIR}/deleted.test.md`, 'orphaned-grounding'],
  ] as const)('keeps the current %s inspection terminal when abort arrives during it, without inspecting a later artifact', async (_name, plans, groundings, identity, status) => {
    const controller = new AbortController();
    const storage = createInMemoryStorage();
    const exists = vi.fn(async (path: string) => {
      if (path === identity) controller.abort();
      return false;
    });
    const calls: string[] = [];
    const discover = vi.fn<CheckDeps['discoverTestFiles']>(async ({ testMatch }) => {
      if (testMatch[0] === '**/*.test.md') { calls.push('tests'); return []; }
      if (testMatch[0] === '**/*.ambercast.plan.json') { calls.push('plans'); return plans; }
      calls.push('grounding');
      return groundings;
    });
    const { deps } = createScenario({ signal: controller.signal, storage: { ...storage, exists }, discoverTestFiles: discover });

    const outcome = await check(deps, OPTIONS);

    expect(outcome.results).toEqual([expect.objectContaining({ id: identity, status })]);
    expect(exists).toHaveBeenCalledOnce();
    expect(outcome.interrupted).toBe(true);
    expect(calls).toEqual(status === 'orphaned-plan' ? ['tests', 'plans'] : ['tests', 'plans', 'grounding']);
  });

  it('keeps selected case-error and later plan-orphan rows sharing an identity without a terminal-mark collision', async () => {
    const testPath = `${TEST_DIR}/same.test.md`;
    const planPath = `${TEST_DIR}/same.ambercast.plan.json`;
    const storage = createInMemoryStorage();
    const readText = vi.fn(async (path: string) => {
      if (path === planPath) throw new Error('read failure');
      return storage.readText(path);
    });
    const exists = vi.fn(async (path: string) => path === planPath);
    const { deps } = createScenario({
      storage: { ...storage, readText, exists },
      discoverTestFiles: createDiscovery([], ['same.ambercast.plan.json']),
    });

    const outcome = await check(deps, { ...OPTIONS, files: [testPath] });

    expect(outcome.errors).toEqual([expect.objectContaining({ file: testPath })]);
    expect(outcome.results).toEqual([expect.objectContaining({ id: testPath, status: 'orphaned-plan' })]);
    expect(buildCheckReport({
      startedAt: '2026-08-17T00:00:00Z', durationMs: 1, options: { allowEmpty: false, list: false }, outcome,
    }).envelope.summary).toEqual({ total: 1, passed: 0, failed: 0, errored: 1, skipped: 0 });
  });

  it.each(['normal return', 'discovery rejection'] as const)('disposes the tracker in check finally after %s', async (mode) => {
    const dispose = vi.spyOn(BatchInterruptionTracker.prototype, 'dispose');
    const discover = mode === 'normal return'
      ? createDiscovery()
      : vi.fn<CheckDeps['discoverTestFiles']>(async () => { throw new Error('discovery failed'); });
    const { deps } = createScenario({ discoverTestFiles: discover });

    if (mode === 'normal return') {
      await expect(check(deps, OPTIONS)).resolves.toBeDefined();
    } else {
      await expect(check(deps, OPTIONS)).rejects.toThrow('discovery failed');
    }
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });
});
