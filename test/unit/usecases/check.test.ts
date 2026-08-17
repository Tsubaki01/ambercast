import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
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
    schemaVersion: 1,
    source: {
      inputsDigest: computeInputsDigest({
        normalizedTestMd: normalizeTestMd(prompt),
        schemaVersion: 1,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        targetDefinitions,
      }),
    },
    targets: targetDefinitions,
    steps: [],
  };
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

describe('check', () => {
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
      results: [{ id: testPath, status: 'stale', reason: expect.stringMatching(/canonical/i) }],
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

  it('reports an orphaned grounding with the expected plan path and grounding path in its reason', async () => {
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
        status: 'orphaned-grounding',
        reason: expect.stringContaining(groundingPath),
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

  it('throws for an unresolved explicit target with a non-empty selection', async () => {
    const { deps } = createScenario();

    await expect(check(deps, { ...OPTIONS, files: [`${TEST_DIR}/login.test.md`], target: 'missing' }))
      .rejects.toMatchObject({ kind: 'target-unresolved' });
  });

  it('throws for an unresolved explicit target with an empty selection', async () => {
    const { deps } = createScenario();

    await expect(check(deps, { ...OPTIONS, target: 'missing' })).rejects.toMatchObject({ kind: 'target-unresolved' });
  });

  it.each([
    ['an empty selection', []],
    ['a non-empty selection', [`${TEST_DIR}/login.test.md`]],
  ] as const)('rejects the inherited constructor target for %s', async (_selection, files) => {
    const { deps } = createScenario({ config: createConfig({ targets: {} }) });

    await expect(check(deps, { ...OPTIONS, files, target: 'constructor' }))
      .rejects.toMatchObject({ kind: 'target-unresolved' });
  });

  it('validates an explicit target before test discovery can reject', async () => {
    const discoverTestFiles = vi.fn<CheckDeps['discoverTestFiles']>(async () => {
      throw new Error('test directory is unreadable');
    });
    const { deps } = createScenario({ discoverTestFiles });

    await expect(check(deps, { ...OPTIONS, target: 'missing' }))
      .rejects.toMatchObject({ kind: 'target-unresolved' });
    expect(discoverTestFiles).not.toHaveBeenCalled();
  });

  it('throws for an unresolved implicit target with a non-empty selection', async () => {
    const { defaultTarget: _defaultTarget, ...ambiguousConfig } = createConfig();
    const { deps } = createScenario({
      config: {
        ...ambiguousConfig,
        targets: {
          web: TARGETS.web,
          admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' },
        },
      },
    });

    await expect(check(deps, { ...OPTIONS, files: [`${TEST_DIR}/login.test.md`] }))
      .rejects.toMatchObject({ kind: 'target-unresolved' });
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

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true });
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

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true });
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

    await expect(check(deps, OPTIONS)).resolves.toEqual({ results: [], errors: [], noTestsFound: true });
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

  it('stops before the first selected file when cancellation is already requested', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { deps } = createScenario({ signal: controller.signal });

    await expect(check(deps, { ...OPTIONS, files: [`${TEST_DIR}/login.test.md`] })).resolves.toEqual({
      results: [],
      errors: [],
      noTestsFound: false,
    });
  });

  it('continues the independent ordered orphan scan after pre-aborted selected work', async () => {
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

    expect(outcome.results).toEqual([
      expect.objectContaining({ id: orphanedPlanPath, status: 'orphaned-plan' }),
      expect.objectContaining({ id: orphanedGroundingPath, status: 'orphaned-grounding' }),
    ]);
    expect(outcome.results).not.toContainEqual(expect.objectContaining({ id: selectedPath }));
    expect(outcome.errors).toEqual([]);
    expect(outcome.noTestsFound).toBe(false);
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
      results: [{ id: freshPath, status: 'fresh' }],
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
