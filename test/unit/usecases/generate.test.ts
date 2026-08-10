import { describe, expect, it, vi } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import {
  PlanDocument,
  type GeneratedPlanResponse,
  type GroundingDocument,
  type JsonValueT,
} from '#core/ir/schema.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { SecretRefUndeclaredError } from '#core/errors/secret-ref-undeclared-error.js';
import type { StorageAdapter } from '#ports/storage.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const RESPONSE: GeneratedPlanResponse = { steps: [], ambiguities: [] };
const UNDECLARED_SECRET_REF = '{{secrets.FOO}}';
const PASSWORD_TARGET = { strategy: 'accessibility', role: 'textbox', name: 'Password' } as const;

const UNDECLARED_SECRET_RESPONSES = [
  [
    'fill-secret action',
    {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef: UNDECLARED_SECRET_REF,
      }],
      ambiguities: [],
    },
  ],
  [
    'AI-step secret grant',
    {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete the sign-in flow.',
        secrets: [UNDECLARED_SECRET_REF],
      }],
      ambiguities: [],
    },
  ],
] as const satisfies readonly (readonly [string, GeneratedPlanResponse])[];

const DEFAULT_OPTIONS: GenerateOptions = {
  files: [],
  strict: false,
  force: false,
  dryRun: false,
  allowEmpty: false,
  list: false,
};

interface RecordingStorage {
  readonly storage: StorageAdapter;
  readonly reads: string[];
  readonly writes: { readonly path: string; readonly content: string }[];
  reset(): void;
}

function createRecordingStorage(
  fail: { readonly read?: string; readonly write?: string } = {},
): RecordingStorage {
  const backing = createInMemoryStorage();
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];

  return {
    reads,
    writes,
    storage: {
      ...backing,
      async readText(path) {
        reads.push(path);
        if (path === fail.read) {
          throw new Error(`read failed: ${path}`);
        }
        return backing.readText(path);
      },
      async writeText(path, content) {
        if (path === fail.write) {
          throw new Error(`write failed: ${path}`);
        }
        writes.push({ path, content });
        return backing.writeText(path, content);
      },
    },
    reset() {
      reads.splice(0);
      writes.splice(0);
    },
  };
}

function createScenario(overrides: Partial<GenerateDeps> = {}) {
  const recordingStorage = createRecordingStorage();
  const execute = vi.fn(async () => ({ data: RESPONSE, raw: JSON.stringify(RESPONSE) }));
  const deps: GenerateDeps = {
    storage: recordingStorage.storage,
    layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
    aiExecutor: createFakeAiExecutor({ execute }),
    discoverTestFiles: vi.fn(async () => ['login.test.md']),
    config: {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
      targets: TARGETS,
      defaultTarget: 'web',
      ai: { provider: 'codex', timeoutMs: 100 },
    },
    ...overrides,
  };

  return { deps, execute, recordingStorage };
}

async function writePrompt(storage: StorageAdapter, relativePath = 'login.test.md', contents = PROMPT): Promise<string> {
  const path = `${TEST_DIR}/${relativePath}`;
  await storage.writeText(path, contents);
  return path;
}

async function createFreshPlan(storage: StorageAdapter, testPath: string): Promise<PlanDocument> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const normalizedTestMd = normalizeTestMd(await storage.readText(testPath));
  const inputsDigest = computeInputsDigest({
    normalizedTestMd,
    schemaVersion: 1,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    targetDefinitions: TARGETS,
  });
  const plan: PlanDocument = {
    schemaVersion: 1,
    source: { inputsDigest },
    targets: TARGETS,
    steps: [],
  };

  await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
  return plan;
}

async function seedFreshArtifacts(storage: StorageAdapter, testPath: string): Promise<void> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const plan = await createFreshPlan(storage, testPath);
  const grounding: GroundingDocument = { schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {} };

  await storage.writeText(layout.groundingPathFor(testPath), toCanonicalArtifactText(grounding));
}

describe('generate', () => {
  it('uses configured discovery when files are absent and reports deterministic discovered paths', async () => {
    const { deps, recordingStorage } = createScenario({ discoverTestFiles: async () => ['a.test.md', 'z.test.md'] });
    await writePrompt(recordingStorage.storage, 'a.test.md');
    await writePrompt(recordingStorage.storage, 'z.test.md');
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      noTestsFound: false,
      results: [
        { file: `${TEST_DIR}/a.test.md`, status: 'generated' },
        { file: `${TEST_DIR}/z.test.md`, status: 'generated' },
      ],
    });
  });

  it.each([
    ['default', DEFAULT_OPTIONS],
    ['allow-empty', { ...DEFAULT_OPTIONS, allowEmpty: true }],
    ['list', { ...DEFAULT_OPTIONS, list: true }],
  ] as const)('reports a zero match for %s policy without calling AI', async (_policy, options) => {
    const { deps, execute } = createScenario({ discoverTestFiles: async () => [] });

    await expect(generate(deps, options)).resolves.toEqual({ results: [], noTestsFound: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives list precedence over dry-run, force, and strict without reading prompts or writing artifacts', async () => {
    const { deps, execute, recordingStorage } = createScenario({ discoverTestFiles: async () => ['login.test.md'] });

    await expect(generate(deps, { ...DEFAULT_OPTIONS, list: true, dryRun: true, force: true, strict: true }))
      .resolves.toEqual({ results: [{ file: `${TEST_DIR}/login.test.md`, status: 'listed' }], noTestsFound: false });
    expect(execute).not.toHaveBeenCalled();
    expect(recordingStorage.reads).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
  });

  it('skips a valid canonical fresh plan without calling AI or rewriting artifacts', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'skipped-fresh', planFile: `${TEST_DIR}/login.ambercast.plan.json` }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(recordingStorage.writes).toEqual([]);
  });

  it.each([
    ['a stale plan', { force: false, dryRun: false }, 'generated'],
    ['a fresh plan forced to regenerate', { force: true, dryRun: false }, 'generated'],
    ['a stale plan in dry-run', { force: false, dryRun: true }, 'would-generate'],
    ['a fresh plan forced in dry-run', { force: true, dryRun: true }, 'would-generate'],
  ] as const)('generates or previews %s according to force and dry-run policy', async (_description, policy, status) => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    if (policy.force) {
      await seedFreshArtifacts(recordingStorage.storage, testPath);
    } else {
      await recordingStorage.storage.writeText(`${TEST_DIR}/login.ambercast.plan.json`, '{ malformed');
    }
    recordingStorage.reset();

    await expect(generate(deps, { ...DEFAULT_OPTIONS, ...policy })).resolves.toMatchObject({
      results: [{ file: testPath, status }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recordingStorage.writes.length).toBe(policy.dryRun ? 0 : 2);
  });

  it('regenerates a schema-valid plan whose inputs digest is stale', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    const freshPlan = await createFreshPlan(recordingStorage.storage, testPath);
    await recordingStorage.storage.writeText(
      `${TEST_DIR}/login.ambercast.plan.json`,
      toCanonicalArtifactText({ ...freshPlan, source: { inputsDigest: 'f'.repeat(64) } } as JsonValueT),
    );
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ status: 'generated' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('regenerates a schema-invalid existing plan instead of treating its matching-looking file as fresh', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    const freshPlan = await createFreshPlan(recordingStorage.storage, testPath);
    await recordingStorage.storage.writeText(`${TEST_DIR}/login.ambercast.plan.json`, JSON.stringify({
      ...freshPlan,
      steps: [{ id: 'missing-kind' }],
    }, null, 2));
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ file: testPath, status: 'generated' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('regenerates a same-digest plan that is valid but not canonically serialized', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await createFreshPlan(recordingStorage.storage, testPath);
    const planPath = `${TEST_DIR}/login.ambercast.plan.json`;
    const canonical = await recordingStorage.storage.readText(planPath);
    await recordingStorage.storage.writeText(planPath, `${JSON.stringify(JSON.parse(canonical), null, 4)}\n`);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ status: 'generated' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('honors fresh status during dry-run unless force explicitly requests a preview', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath);
    recordingStorage.reset();

    await expect(generate(deps, { ...DEFAULT_OPTIONS, dryRun: true })).resolves.toMatchObject({
      results: [{ status: 'skipped-fresh' }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown explicit target', { target: 'missing' }],
    ['absent target when configuration has no default', {}],
  ] as const)('records %s as a per-file target-unresolved failure', async (_description, optionOverride) => {
    const { deps, execute, recordingStorage } = createScenario({
      config: { testDir: TEST_DIR, testMatch: ['**/*.test.md'], testIgnore: [], targets: TARGETS, ai: { provider: 'codex', timeoutMs: 100 } },
    });
    await writePrompt(recordingStorage.storage);

    await expect(generate(deps, { ...DEFAULT_OPTIONS, ...optionOverride })).resolves.toMatchObject({
      results: [{ status: 'failed', error: { kind: 'target-unresolved' } }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['provider rejection', new AiExecutorUnavailableError('provider unavailable'), 'ai-executor-unavailable'],
    ['invalid response rejection', new AiResponseInvalidError('invalid response'), 'ai-response-invalid'],
  ] as const)('keeps %s as a failed file and continues to later files', async (_description, error, kind) => {
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async (request) => {
          if (request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && String(request.context.testMd).includes('first')) {
            throw error;
          }
          return { data: RESPONSE, raw: JSON.stringify(RESPONSE) };
        },
      }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [
        { file: `${TEST_DIR}/first.test.md`, status: 'failed', error: { kind } },
        { file: `${TEST_DIR}/second.test.md`, status: 'generated' },
      ],
    });
  });

  it('wraps a per-call timeout as an unavailable executor failure and continues the batch', async () => {
    const { deps, recordingStorage } = createScenario({
      config: { testDir: TEST_DIR, testMatch: ['**/*.test.md'], testIgnore: [], targets: TARGETS, defaultTarget: 'web', ai: { provider: 'codex', timeoutMs: 1 } },
      aiExecutor: createFakeAiExecutor({
        execute: (request) => request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && request.context.testMd === 'first'
          ? new Promise(() => undefined)
          : { data: RESPONSE, raw: JSON.stringify(RESPONSE) },
      }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [
        {
          status: 'failed',
          error: {
            kind: 'ai-executor-unavailable',
            message: 'The AI provider did not respond within the configured timeout.',
          },
        },
        { status: 'generated' },
      ],
    });
  });

  it('classifies a non-abort adapter failure as unavailable without claiming that the call timed out', async () => {
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async (request) => {
          if (request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && request.context.testMd === 'first') {
            throw new Error('temporary schema write failed');
          }
          return { data: RESPONSE, raw: JSON.stringify(RESPONSE) };
        },
      }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [
        {
          status: 'failed',
          error: {
            kind: 'ai-executor-unavailable',
            message: 'The AI provider call failed.',
          },
        },
        { status: 'generated' },
      ],
    });
  });

  it('returns collected results without starting a file when the caller has already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped generation');
    const { deps, execute, recordingStorage } = createScenario({ signal: controller.signal, discoverTestFiles: async () => ['first.test.md', 'second.test.md'] });
    await writePrompt(recordingStorage.storage, 'first.test.md');
    await writePrompt(recordingStorage.storage, 'second.test.md');
    recordingStorage.reset();
    controller.abort(reason);

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toEqual({ results: [], noTestsFound: false });
    expect(execute).not.toHaveBeenCalled();
    expect(recordingStorage.reads).toEqual([]);
  });

  it('returns collected partial results when the caller aborts a pending AI call and never starts the second file', async () => {
    const controller = new AbortController();
    const reason = new Error('stop after first AI call starts');
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let resolveFirst: ((value: { data: GeneratedPlanResponse; raw: string }) => void) | undefined;
    const firstResponse = new Promise<{ data: GeneratedPlanResponse; raw: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const execute = vi.fn(() => {
      signalStarted?.();
      return firstResponse;
    });
    const recordingStorage = createRecordingStorage();
    const { deps } = createScenario({
      signal: controller.signal,
      aiExecutor: createFakeAiExecutor({ execute }),
      storage: recordingStorage.storage,
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md');
    await writePrompt(recordingStorage.storage, 'second.test.md');
    recordingStorage.reset();

    const running = generate(deps, DEFAULT_OPTIONS);
    await started;
    controller.abort(reason);

    await expect(running).resolves.toEqual({ results: [], noTestsFound: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recordingStorage.reads).toContain(`${TEST_DIR}/first.test.md`);
    expect(recordingStorage.reads).not.toContain(`${TEST_DIR}/second.test.md`);
    resolveFirst?.({ data: RESPONSE, raw: JSON.stringify(RESPONSE) });
  });

  it('converts prompt-read, plan-write, and grounding-write failures to classified per-file failures', async () => {
    const testPath = `${TEST_DIR}/login.test.md`;
    for (const failure of ['read', 'plan', 'grounding'] as const) {
      const storage = createRecordingStorage({
        ...(failure === 'read' ? { read: testPath } : {}),
        ...(failure === 'plan' ? { write: `${TEST_DIR}/login.ambercast.plan.json` } : {}),
        ...(failure === 'grounding' ? { write: `${TEST_DIR}/login.ambercast.grounding.json` } : {}),
      });
      if (failure !== 'read') {
        await writePrompt(storage.storage);
      }
      const { deps } = createScenario({ storage: storage.storage });

      await expect(generate(deps, { ...DEFAULT_OPTIONS, files: [testPath] })).resolves.toMatchObject({
        results: [{ status: 'failed', error: { kind: 'fs-io-error' } }],
      });
    }
  });

  it.each(['missing', 'malformed', 'digest-mismatched'] as const)(
    'repairs a %s grounding cache for a fresh plan without regenerating it',
    async (groundingState) => {
      const { deps, execute, recordingStorage } = createScenario();
      const testPath = await writePrompt(recordingStorage.storage);
      await createFreshPlan(recordingStorage.storage, testPath);
      const groundingPath = `${TEST_DIR}/login.ambercast.grounding.json`;
      if (groundingState === 'malformed') {
        await recordingStorage.storage.writeText(groundingPath, '{ malformed');
      }
      if (groundingState === 'digest-mismatched') {
        const staleGrounding: GroundingDocument = { schemaVersion: 1, planDigest: 'f'.repeat(64), entries: {} };
        await recordingStorage.storage.writeText(groundingPath, toCanonicalArtifactText(staleGrounding));
      }
      recordingStorage.reset();

      await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ status: 'skipped-fresh' }] });
      expect(execute).not.toHaveBeenCalled();
      expect(recordingStorage.writes).toEqual([expect.objectContaining({ path: groundingPath })]);
    },
  );

  it.each(['missing', 'malformed', 'digest-mismatched'] as const)(
    'does not repair a %s grounding cache while dry-running a fresh plan',
    async (groundingState) => {
      const { deps, execute, recordingStorage } = createScenario();
      const testPath = await writePrompt(recordingStorage.storage);
      await createFreshPlan(recordingStorage.storage, testPath);
      const groundingPath = `${TEST_DIR}/login.ambercast.grounding.json`;
      if (groundingState === 'malformed') {
        await recordingStorage.storage.writeText(groundingPath, '{ malformed');
      }
      if (groundingState === 'digest-mismatched') {
        const staleGrounding: GroundingDocument = { schemaVersion: 1, planDigest: 'f'.repeat(64), entries: {} };
        await recordingStorage.storage.writeText(groundingPath, toCanonicalArtifactText(staleGrounding));
      }
      recordingStorage.reset();

      await expect(generate(deps, { ...DEFAULT_OPTIONS, dryRun: true })).resolves.toMatchObject({
        results: [{ status: 'skipped-fresh' }],
      });
      expect(execute).not.toHaveBeenCalled();
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it('leaves the written plan after grounding write failure, then repairs grounding without another AI call', async () => {
    const recordingStorage = createRecordingStorage();
    const planPath = `${TEST_DIR}/login.ambercast.plan.json`;
    const groundingPath = `${TEST_DIR}/login.ambercast.grounding.json`;
    let failGroundingWrite = true;
    const storage: StorageAdapter = {
      ...recordingStorage.storage,
      async writeText(path, content) {
        if (path === groundingPath && failGroundingWrite) {
          failGroundingWrite = false;
          throw new Error('grounding write failed once');
        }
        await recordingStorage.storage.writeText(path, content);
      },
    };
    const { deps, execute } = createScenario({ storage });
    await writePrompt(storage);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'failed', error: { kind: 'fs-io-error' } }],
    });
    expect(PlanDocument.safeParse(JSON.parse(await storage.readText(planPath))).success).toBe(true);
    await expect(storage.exists(groundingPath)).resolves.toBe(false);

    recordingStorage.reset();
    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ status: 'skipped-fresh' }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recordingStorage.writes).toEqual([expect.objectContaining({ path: groundingPath })]);
  });

  it('preserves provider ambiguities for generated and previewed plans regardless of strict policy', async () => {
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: { steps: [], ambiguities: ['unclear target'] }, raw: '{...}' }) }),
    });
    await writePrompt(recordingStorage.storage);

    await expect(generate(deps, { ...DEFAULT_OPTIONS, strict: true })).resolves.toMatchObject({
      results: [{ status: 'generated', ambiguities: ['unclear target'] }],
    });
    await expect(generate(deps, { ...DEFAULT_OPTIONS, dryRun: true, strict: false, force: true })).resolves.toMatchObject({
      results: [{ status: 'would-generate', ambiguities: ['unclear target'] }],
    });
  });

  it.each([
    ['generated', { ...DEFAULT_OPTIONS }],
    ['dry-run', { ...DEFAULT_OPTIONS, dryRun: true }],
  ] as const)('rejects a literal secret in %s response ambiguities before exposing or writing it', async (_mode, options) => {
    const secret = 'sk-live-secret-in-ambiguity';
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: { steps: [], ambiguities: [secret] }, raw: '{...}' }),
      }),
    });
    await writePrompt(recordingStorage.storage);
    recordingStorage.reset();

    await expect(generate(deps, options)).resolves.toMatchObject({
      results: [{ status: 'failed', error: { kind: 'secret-literal-rejected' } }],
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it('rejects literal secrets before either artifact write and continues with the next file', async () => {
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async (request) => request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && request.context.testMd === 'unsafe'
          ? { data: { steps: [], ambiguities: [], generatorMeta: { token: 'sk-live-secret-value' } }, raw: '{...}' }
          : { data: RESPONSE, raw: '{...}' },
      }),
      discoverTestFiles: async () => ['unsafe.test.md', 'safe.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'unsafe.test.md', 'unsafe');
    await writePrompt(recordingStorage.storage, 'safe.test.md', 'safe');
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [
        { file: `${TEST_DIR}/unsafe.test.md`, status: 'failed', error: { kind: 'secret-literal-rejected' } },
        { file: `${TEST_DIR}/safe.test.md`, status: 'generated' },
      ],
    });
    expect(recordingStorage.writes.map(({ path }) => path)).not.toContain(`${TEST_DIR}/unsafe.ambercast.plan.json`);
    expect(recordingStorage.writes.map(({ path }) => path)).not.toContain(`${TEST_DIR}/unsafe.ambercast.grounding.json`);
  });

  it.each(UNDECLARED_SECRET_RESPONSES)(
    'rejects an ungrounded %s before writing generated artifacts',
    async (_description, response) => {
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: response, raw: JSON.stringify(response) }),
        }),
      });
      const testPath = await writePrompt(recordingStorage.storage);
      recordingStorage.reset();

      const outcome = await generate(deps, DEFAULT_OPTIONS);

      expect(outcome.results[0]).toMatchObject({ file: testPath, status: 'failed' });
      expect(outcome.results[0]?.error).toBeInstanceOf(SecretRefUndeclaredError);
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it.each(UNDECLARED_SECRET_RESPONSES)(
    'rejects an ungrounded %s through the --dry-run path without writing artifacts',
    async (_description, response) => {
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: response, raw: JSON.stringify(response) }),
        }),
      });
      const testPath = await writePrompt(recordingStorage.storage);
      recordingStorage.reset();

      const outcome = await generate(deps, { ...DEFAULT_OPTIONS, dryRun: true });

      expect(outcome.results[0]).toMatchObject({ file: testPath, status: 'failed' });
      expect(outcome.results[0]?.error).toBeInstanceOf(SecretRefUndeclaredError);
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it.each([
    ['generated', DEFAULT_OPTIONS, 'generated'],
    ['dry-run', { ...DEFAULT_OPTIONS, dryRun: true }, 'would-generate'],
  ] as const)('keeps grounded secret usage on the existing %s path', async (_mode, options, status) => {
    const declaredSecretRef = '{{secrets.LOGIN_PASSWORD}}';
    const response: GeneratedPlanResponse = {
      steps: [
        {
          id: 'fill-password',
          kind: 'action',
          action: 'fill-secret',
          target: PASSWORD_TARGET,
          secretRef: declaredSecretRef,
        },
        {
          id: 'complete-sign-in',
          kind: 'ai',
          instruction: 'Complete the sign-in flow.',
          secrets: [declaredSecretRef],
        },
      ],
      ambiguities: [],
    };
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: response, raw: JSON.stringify(response) }),
      }),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${declaredSecretRef}\n`);
    recordingStorage.reset();

    const outcome = await generate(deps, options);

    expect(outcome.results[0]).toMatchObject({ file: testPath, status });
    expect(recordingStorage.writes).toHaveLength(options.dryRun ? 0 : 2);
  });

  it('classifies duplicate assembled plan step IDs as a final PlanDocument validation failure', async () => {
    const duplicateResponse: GeneratedPlanResponse = {
      steps: [
        { id: 'open-home', kind: 'action', action: 'navigate', url: 'https://example.test/one' },
        { id: 'open-home', kind: 'action', action: 'navigate', url: 'https://example.test/two' },
      ],
      ambiguities: [],
    };
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: duplicateResponse, raw: JSON.stringify(duplicateResponse) }),
      }),
    });
    await writePrompt(recordingStorage.storage);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'failed', error: { kind: 'ai-response-invalid' } }],
    });
    expect(recordingStorage.writes).toEqual([]);
  });
});
