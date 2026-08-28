import { describe, expect, it, vi } from 'vitest';
import {
  GENERATOR_INSTRUCTION_COVERAGE_POLICY_TEMPLATE,
  promptTemplateFingerprint,
} from '#core/ai/prompt-envelope.js';
import {
  PlanDocument,
  type GeneratedPlanResponse,
  type GroundingDocument,
  type JsonValueT,
  type Step,
} from '#core/ir/schema.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import * as planProducerBundle from '#core/ai/plan-producer-bundle.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { AiExecuteRequest } from '#ports/ai.js';
import type { StorageAdapter } from '#ports/storage.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { BatchInterruptionTracker } from '#usecases/batch-interruption.js';
import { validateCommittedInstructionCoverage } from '#usecases/instruction-coverage-policy.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const RESOLVED_TARGETS = { web: { ...TARGETS.web, healReplayIsolation: 'stateful' as const } } as const;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const RESPONSE: GeneratedPlanResponse = { steps: [], ambiguities: [] };
const FIRST_SECRET_REF = '{{secrets.FOO}}';
const SECOND_SECRET_REF = '{{secrets.BAR}}';
const PASSWORD_TARGET = { strategy: 'accessibility', role: 'textbox', name: 'Password' } as const;

const SECRET_GRANT_CITATION_FAILURES = [
  [
    'citation not found',
    {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef: FIRST_SECRET_REF,
        citation: 'This text does not occur in the prompt.',
      }],
      ambiguities: [],
    },
    `${PROMPT}\n@ambercast-secret ${FIRST_SECRET_REF}\n`,
    'citation-not-found',
  ],
  [
    'citation not unique',
    {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete the sign-in flow.',
        instructionCoverage: [{
          id: 'dashboard-reached',
          kind: 'success',
          citation: 'When I submit valid credentials, I reach the dashboard.',
        }],
        verificationIntent: [{
          criterionId: 'dashboard-reached',
          assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
        }],
        secrets: [{ ref: FIRST_SECRET_REF, citation: `@ambercast-secret ${FIRST_SECRET_REF}` }],
      }],
      ambiguities: [],
    },
    `${PROMPT}\n@ambercast-secret ${FIRST_SECRET_REF}\n@ambercast-secret ${FIRST_SECRET_REF}\n`,
    'citation-not-unique',
  ],
  [
    'citation missing its reference',
    {
      steps: [
        {
          id: 'fill-password',
          kind: 'action',
          action: 'fill-secret',
          target: PASSWORD_TARGET,
          secretRef: FIRST_SECRET_REF,
          citation: `@ambercast-secret ${SECOND_SECRET_REF}`,
        },
      ],
      ambiguities: [],
    },
    `${PROMPT}\n@ambercast-secret ${SECOND_SECRET_REF}\n`,
    'citation-missing-ref',
  ],
  [
    'citation unresolved to a grant',
    {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef: FIRST_SECRET_REF,
        citation: `Use ${FIRST_SECRET_REF} only as prose.`,
      }],
      ambiguities: [],
    },
    `${PROMPT}\nUse ${FIRST_SECRET_REF} only as prose.\n`,
    'citation-unresolved',
  ],
  [
    'multiply attributed grant',
    {
      steps: [
        {
          id: 'first-password',
          kind: 'action',
          action: 'fill-secret',
          target: PASSWORD_TARGET,
          secretRef: FIRST_SECRET_REF,
          citation: `@ambercast-secret ${FIRST_SECRET_REF}`,
        },
        {
          id: 'second-password',
          kind: 'action',
          action: 'fill-secret',
          target: PASSWORD_TARGET,
          secretRef: FIRST_SECRET_REF,
          citation: `@ambercast-secret ${FIRST_SECRET_REF}`,
        },
      ],
      ambiguities: [],
    },
    `${PROMPT}\n@ambercast-secret ${FIRST_SECRET_REF}\n`,
    'multiply-attributed-grant',
  ],
  [
    'uncovered grant',
    { steps: [], ambiguities: [] },
    `${PROMPT}\n@ambercast-secret ${FIRST_SECRET_REF}\n`,
    'uncovered-grant',
  ],
] as const satisfies readonly (readonly [string, GeneratedPlanResponse, string, string])[];

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
  readonly exists: string[];
  readonly writes: { readonly path: string; readonly content: string }[];
  reset(): void;
}

function createRecordingStorage(
  fail: { readonly read?: string; readonly write?: string } = {},
): RecordingStorage {
  const backing = createInMemoryStorage();
  const reads: string[] = [];
  const exists: string[] = [];
  const writes: { path: string; content: string }[] = [];

  return {
    reads,
    exists,
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
      async exists(path) {
        exists.push(path);
        return backing.exists(path);
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
      exists.splice(0);
      writes.splice(0);
    },
  };
}

function createScenario(overrides: Partial<GenerateDeps> = {}) {
  const recordingStorage = createRecordingStorage();
  const events = createRecordingEventSink();
  const execute = vi.fn(async (_request: AiExecuteRequest<unknown>) => ({
    data: RESPONSE,
    raw: JSON.stringify(RESPONSE),
  }));
  const deps: GenerateDeps = {
    storage: recordingStorage.storage,
    layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
    aiExecutor: createFakeAiExecutor({ execute }),
    events: events.sink,
    discoverTestFiles: vi.fn(async () => ['login.test.md']),
    config: {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
      targets: RESOLVED_TARGETS,
      defaultTarget: 'web',
      ai: { provider: 'codex', timeoutMs: 100 },
    },
    ...overrides,
  };

  return { deps, events, execute, recordingStorage };
}

function interceptTimeouts(controllersByTimeoutMs: ReadonlyMap<number, AbortController>) {
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs) => {
    const controller = controllersByTimeoutMs.get(timeoutMs);
    if (controller === undefined) {
      throw new Error(`Unexpected deadline timeout: ${timeoutMs}`);
    }
    return controller.signal;
  });
}

function captureComposedTimeoutSignals(timeoutSignals: readonly AbortSignal[]): AbortSignal[] {
  const originalAny = AbortSignal.any;
  const composedTimeoutSignals: AbortSignal[] = [];

  vi.spyOn(AbortSignal, 'any').mockImplementation((signals) => {
    const timeoutSignal = signals.find((signal) => timeoutSignals.includes(signal));
    if (timeoutSignal !== undefined) {
      composedTimeoutSignals.push(timeoutSignal);
    }
    return originalAny.call(AbortSignal, signals);
  });

  return composedTimeoutSignals;
}

function sequentialTimeoutConfig(timeoutMsValues: readonly number[]) {
  let timeoutMsIndex = 0;

  return {
    provider: 'codex' as const,
    get timeoutMs() {
      const timeoutMs = timeoutMsValues[timeoutMsIndex];
      timeoutMsIndex += 1;
      if (timeoutMs === undefined) {
        throw new Error('Unexpected deadline creation.');
      }
      return timeoutMs;
    },
  };
}

async function writePrompt(storage: StorageAdapter, relativePath = 'login.test.md', contents = PROMPT): Promise<string> {
  const path = `${TEST_DIR}/${relativePath}`;
  await storage.writeText(path, contents);
  return path;
}

async function createFreshPlan(
  storage: StorageAdapter,
  testPath: string,
  steps: readonly Step[] = [],
  targetDefinitions: PlanDocument['targets'] = TARGETS,
): Promise<PlanDocument> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const normalizedTestMd = normalizeTestMd(await storage.readText(testPath));
  const inputsDigest = computeInputsDigest({
    normalizedTestMd,
    schemaVersion: 2,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    planProducerBundleFingerprint: planProducerBundle.planProducerBundleFingerprint(),
    targetDefinitions,
  });
  const plan = {
    schemaVersion: 2,
    source: { inputsDigest },
    targets: targetDefinitions,
    steps: [...steps],
  } as unknown as PlanDocument;

  await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
  return plan;
}

async function seedFreshArtifacts(
  storage: StorageAdapter,
  testPath: string,
  steps: readonly Step[] = [],
  targetDefinitions: PlanDocument['targets'] = TARGETS,
): Promise<void> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const plan = await createFreshPlan(storage, testPath, steps, targetDefinitions);
  const grounding: GroundingDocument = { schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {} };

  await storage.writeText(
    layout.groundingPathFor(testPath),
    toCanonicalArtifactText(grounding as unknown as JsonValueT),
  );
}

describe('generate', () => {
  const coveredResponse = {
    steps: [{
      id: 'reach-dashboard',
      kind: 'ai',
      instruction: 'Reach the dashboard.',
      instructionCoverage: [{
        id: 'dashboard-reached',
        kind: 'success',
        citation: 'When I submit valid credentials, I reach the dashboard.',
      }],
      verificationIntent: [{
        criterionId: 'dashboard-reached',
        assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
      }],
    }],
    ambiguities: [],
  } as unknown as GeneratedPlanResponse;

  it('keeps the generated success-span fixture locally re-extractable from its prompt', () => {
    const result = validateCommittedInstructionCoverage([{
      id: 'dashboard-reached',
      kind: 'success',
      sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 },
    }], normalizeTestMd(PROMPT));

    expect(result).toEqual({
      success: true,
      data: [expect.objectContaining({ text: 'When I submit valid credentials, I reach the dashboard.' })],
    });
  });

  it.each([
    ['ordinary', DEFAULT_OPTIONS, 'generated', 2],
    ['forced', { ...DEFAULT_OPTIONS, force: true }, 'generated', 2],
    ['dry-run', { ...DEFAULT_OPTIONS, dryRun: true }, 'would-generate', 0],
  ] as const)(
    'attributes and discards provider-only instruction proof on the %s generation path',
    async (_mode, options, status, expectedWrites) => {
      const raw = JSON.stringify(coveredResponse);
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: coveredResponse, raw }),
        }),
      });
      const testPath = await writePrompt(recordingStorage.storage);
      recordingStorage.reset();

      const outcome = await generate(deps, options);

      expect(outcome.results[0]).toMatchObject({ file: testPath, status });
      expect(recordingStorage.writes).toHaveLength(expectedWrites);
      if (options.dryRun) {
        return;
      }
      const planText = await recordingStorage.storage.readText(deps.layout.planPathFor(testPath));
      const plan = JSON.parse(planText) as Record<string, unknown>;
      expect(plan).toMatchObject({
        schemaVersion: 2,
        steps: [{
          id: 'reach-dashboard',
          kind: 'ai',
          instructionCoverage: [{
            id: 'dashboard-reached',
            kind: 'success',
            sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 },
          }],
        }],
      });
      expect(planText).not.toContain('citation');
      expect(planText).not.toContain('verificationIntent');
      expect(planText).not.toContain('When I submit valid credentials');
    },
  );

  it.each([
    ['missing success intent', [], ['verificationIntent', 'dashboard-reached']],
    ['unknown success intent', [{ criterionId: 'unknown', assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' } }], ['verificationIntent', 0, 'criterionId']],
    ['duplicate success intent', [
      { criterionId: 'dashboard-reached', assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' } },
      { criterionId: 'dashboard-reached', assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' } },
    ], ['verificationIntent', 1, 'criterionId']],
    ['unsupported assertion shape', [{
      criterionId: 'dashboard-reached',
      assertion: { type: 'assert', check: 'element-count', target: PASSWORD_TARGET, min: 0 },
    }], ['verificationIntent', 0, 'assertion']],
    ['terminal url intent', [{ criterionId: 'dashboard-reached', assertion: { type: 'assert', check: 'url-matches', pattern: '/dashboard$' } }], ['verificationIntent', 0, 'assertion']],
  ] as const)(
    'preserves raw response and a path for %s without writing either artifact',
    async (_name, verificationIntent, expectedPath) => {
      const response = {
        ...coveredResponse,
        steps: [{ ...coveredResponse.steps[0], verificationIntent }],
      } as unknown as GeneratedPlanResponse;
      const raw = `RAW:${JSON.stringify(response)}`;
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: response, raw }),
        }),
      });
      await writePrompt(recordingStorage.storage);
      recordingStorage.reset();

      const outcome = await generate(deps, DEFAULT_OPTIONS);
      const error = outcome.results[0]?.error;

      expect(outcome.results[0]).toMatchObject({ status: 'failed' });
      expect(error).toBeInstanceOf(AiResponseInvalidError);
      expect(error).toMatchObject({
        details: {
          raw,
          issues: expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
        },
      });
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it('rejects an action criterion named by terminal intent with raw output, path, and zero writes', async () => {
    const response = {
      ...coveredResponse,
      steps: [{
        id: 'reach-dashboard',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        instructionCoverage: [
          {
            id: 'dashboard-reached',
            kind: 'success',
            citation: 'When I submit valid credentials, I reach the dashboard.',
          },
          { id: 'sign-in-action', kind: 'action', citation: '# Sign in' },
        ],
        verificationIntent: [
          {
            criterionId: 'dashboard-reached',
            assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
          },
          { criterionId: 'sign-in-action', assertion: { type: 'assert', check: 'text-visible', text: 'Sign in' } },
        ],
      }],
    } as unknown as GeneratedPlanResponse;
    const raw = `RAW:${JSON.stringify(response)}`;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw }) }),
    });
    await writePrompt(recordingStorage.storage);
    recordingStorage.reset();

    const outcome = await generate(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(AiResponseInvalidError);
    expect(outcome.results[0]?.error).toMatchObject({
      details: {
        raw,
        issues: expect.arrayContaining([expect.objectContaining({
          path: ['verificationIntent', 1, 'criterionId'],
        })]),
      },
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it('rejects action-only coverage with empty intent while preserving raw/path evidence and zero writes', async () => {
    const response = {
      ...coveredResponse,
      steps: [{
        ...coveredResponse.steps[0],
        instructionCoverage: [{ id: 'sign-in-action', kind: 'action', citation: '# Sign in' }],
        verificationIntent: [],
      }],
    } as unknown as GeneratedPlanResponse;
    const raw = `RAW:${JSON.stringify(response)}`;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw }) }),
    });
    await writePrompt(recordingStorage.storage);
    recordingStorage.reset();

    const outcome = await generate(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(AiResponseInvalidError);
    expect(outcome.results[0]?.error).toMatchObject({
      details: {
        raw,
        issues: expect.arrayContaining([expect.objectContaining({
          path: ['instructionCoverage'],
        })]),
      },
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it.each([
    ['missing', 'This citation is absent.', PROMPT],
    ['ambiguous', 'When I submit valid credentials, I reach the dashboard.', `${PROMPT}When I submit valid credentials, I reach the dashboard.\n`],
  ] as const)('rejects a %s instruction citation with raw/path evidence and zero writes', async (_name, citation, prompt) => {
    const response = {
      ...coveredResponse,
      steps: [{
        ...coveredResponse.steps[0],
        instructionCoverage: [{ id: 'dashboard-reached', kind: 'success', citation }],
      }],
    } as unknown as GeneratedPlanResponse;
    const raw = `RAW:${JSON.stringify(response)}`;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw }) }),
    });
    await writePrompt(recordingStorage.storage, 'login.test.md', prompt);
    recordingStorage.reset();

    const outcome = await generate(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(AiResponseInvalidError);
    expect(outcome.results[0]?.error).toMatchObject({
      details: {
        raw,
        issues: expect.arrayContaining([expect.objectContaining({
          path: ['instructionCoverage', 0, 'citation'],
        })]),
      },
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it.each([
    ['lone high surrogate', '\uD83D'],
    ['lone low surrogate', '\uDE00'],
  ] as const)(
    'rejects a %s provider citation against emoji text with raw/path evidence and zero writes',
    async (_name, citation) => {
      const response = {
        ...coveredResponse,
        steps: [{
          ...coveredResponse.steps[0],
          instructionCoverage: [{ id: 'dashboard-reached', kind: 'success', citation }],
        }],
      } as unknown as GeneratedPlanResponse;
      const raw = `RAW:${JSON.stringify(response)}`;
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw }) }),
      });
      await writePrompt(recordingStorage.storage, 'login.test.md', '# Emoji\n\n😀 Ready\n');
      recordingStorage.reset();

      const outcome = await generate(deps, DEFAULT_OPTIONS);

      expect(outcome.results[0]?.error).toBeInstanceOf(AiResponseInvalidError);
      expect(outcome.results[0]?.error).toMatchObject({
        details: {
          raw,
          issues: expect.arrayContaining([expect.objectContaining({
            path: ['instructionCoverage', 0, 'citation'],
          })]),
        },
      });
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it.each([
    ['text-visible', { type: 'assert', check: 'text-visible', text: 'Dashboard' }],
    ['text-equals', { type: 'assert', check: 'text-equals', target: PASSWORD_TARGET, text: 'Dashboard' }],
    ['element-visible', { type: 'assert', check: 'element-visible', target: PASSWORD_TARGET }],
    ['element-count exact zero', { type: 'assert', check: 'element-count', target: PASSWORD_TARGET, count: 0 }],
  ] as const)('accepts provider terminal intent vocabulary %s', async (_name, assertion) => {
    const response = {
      ...coveredResponse,
      steps: [{
        ...coveredResponse.steps[0],
        verificationIntent: [{ criterionId: 'dashboard-reached', assertion }],
      }],
    } as unknown as GeneratedPlanResponse;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw: JSON.stringify(response) }) }),
    });
    await writePrompt(recordingStorage.storage);

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'generated' }],
    });
  });

  it('prefixes the deterministic generation task with the exact exported generator policy', async () => {
    let request: AiExecuteRequest<unknown> | undefined;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async (nextRequest) => {
          request = nextRequest;
          return { data: coveredResponse, raw: JSON.stringify(coveredResponse) };
        },
      }),
    });
    await writePrompt(recordingStorage.storage);

    await generate(deps, DEFAULT_OPTIONS);

    expect(request?.prompt).toBe(
      `${GENERATOR_INSTRUCTION_COVERAGE_POLICY_TEMPLATE.trim()}\n\nGenerate a deterministic ambercast execution plan.`,
    );
    expect(request?.context).toEqual({
      testMd: normalizeTestMd(PROMPT),
      targets: TARGETS,
    });
    expect(request?.responseSchema).toMatchObject({
      type: 'object',
      properties: {
        steps: expect.objectContaining({ type: 'array' }),
        ambiguities: expect.objectContaining({ type: 'array' }),
      },
    });
  });

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

  it('embeds configured secret-sink origins verbatim in a generated plan target snapshot', async () => {
    const targets = {
      web: {
        baseUrl: 'https://example.test',
        browser: 'chromium' as const,
        secretSinkOrigins: { '{{secrets.app.password}}': ['https://idp.example.test'] },
        healReplayIsolation: 'stateful' as const,
      },
    };
    const { deps, recordingStorage } = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    });
    await writePrompt(recordingStorage.storage);

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'generated' }],
    });

    const plan = PlanDocument.parse(JSON.parse(await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.plan.json`)));
    expect(plan.targets).toEqual({
      web: {
        baseUrl: targets.web.baseUrl,
        browser: targets.web.browser,
        secretSinkOrigins: targets.web.secretSinkOrigins,
      },
    });
  });

  it.each([
    ['default', DEFAULT_OPTIONS],
    ['allow-empty', { ...DEFAULT_OPTIONS, allowEmpty: true }],
    ['list', { ...DEFAULT_OPTIONS, list: true }],
  ] as const)('reports a zero match for %s policy without calling AI', async (_policy, options) => {
    const { deps, execute } = createScenario({ discoverTestFiles: async () => [] });

    await expect(generate(deps, options)).resolves.toEqual({ results: [], noTestsFound: true, interrupted: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('gives list precedence over dry-run, force, and strict without reading prompts or writing artifacts', async () => {
    const { deps, events, execute, recordingStorage } = createScenario({ discoverTestFiles: async () => ['login.test.md'] });

    await expect(generate(deps, { ...DEFAULT_OPTIONS, list: true, dryRun: true, force: true, strict: true }))
      .resolves.toEqual({ results: [{ file: `${TEST_DIR}/login.test.md`, status: 'listed' }], noTestsFound: false, interrupted: false });
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted()).toEqual([]);
    expect(recordingStorage.reads).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
  });

  it('skips a valid canonical fresh plan without calling AI or rewriting artifacts', async () => {
    const { deps, events, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'skipped-fresh', planFile: `${TEST_DIR}/login.ambercast.plan.json` }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted()).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
  });

  it('skips a current-digest covered AI plan only after committed coverage policy accepts it', async () => {
    const { deps, events, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{
      id: 'reach-dashboard',
      kind: 'ai',
      instruction: 'Reach the dashboard.',
      instructionCoverage: [{
        id: 'dashboard-reached',
        kind: 'success',
        sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 },
      }],
    } as unknown as Step]);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'skipped-fresh' }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted()).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
  });

  it.each([
    ['out-of-range span', [{
      id: 'dashboard-reached',
      kind: 'success',
      sourceSpan: { startLine: 99, startColumn: 1, endLine: 99, endColumn: 2 },
    }]],
    ['noncanonical order', [
      {
        id: 'dashboard-reached',
        kind: 'success',
        sourceSpan: { startLine: 3, startColumn: 33, endLine: 3, endColumn: 56 },
      },
      {
        id: 'submit-action',
        kind: 'action',
        sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 32 },
      },
    ]],
    ['duplicate criterion ID', [
      {
        id: 'dashboard-reached',
        kind: 'success',
        sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 5 },
      },
      {
        id: 'dashboard-reached',
        kind: 'success',
        sourceSpan: { startLine: 3, startColumn: 6, endLine: 3, endColumn: 10 },
      },
    ]],
  ] as const)(
    'does not skip a same-digest AI plan with %s and regenerates or previews it',
    async (_name, instructionCoverage) => {
      for (const dryRun of [false, true]) {
        const { deps, events, execute, recordingStorage } = createScenario();
        const testPath = await writePrompt(recordingStorage.storage);
        await seedFreshArtifacts(recordingStorage.storage, testPath, [{
          id: 'reach-dashboard',
          kind: 'ai',
          instruction: 'Reach the dashboard.',
          instructionCoverage,
        } as unknown as Step]);
        recordingStorage.reset();

        await expect(generate(deps, { ...DEFAULT_OPTIONS, dryRun })).resolves.toMatchObject({
          results: [{
            file: testPath,
            status: dryRun ? 'would-generate' : 'generated',
          }],
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(events.emitted()).toEqual([{ type: 'ai-call' }]);
        expect(recordingStorage.writes).toHaveLength(dryRun ? 0 : 2);
      }
    },
  );

  it('regenerates an otherwise fresh plan with an uncovered secret grant', async () => {
    const secretRef = FIRST_SECRET_REF;
    const regeneratedResponse: GeneratedPlanResponse = {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef,
        citation: `@ambercast-secret ${secretRef}`,
      }],
      ambiguities: [],
    };
    const execute = vi.fn(async () => ({ data: regeneratedResponse, raw: JSON.stringify(regeneratedResponse) }));
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `@ambercast-secret ${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'generated' }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps a fresh plan with a fully consumed secret grant without calling AI', async () => {
    const secretRef = FIRST_SECRET_REF;
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `@ambercast-secret ${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: PASSWORD_TARGET,
      secretRef,
      secretGrantSpan: { startLine: 1, endLine: 1 },
    }]);
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'skipped-fresh' }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats a v1-tagged grounding document as stale, rewrites it empty, and keeps the plan fresh', async () => {
    const { deps, execute, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    const plan = await createFreshPlan(recordingStorage.storage, testPath);
    const groundingPath = `${TEST_DIR}/login.ambercast.grounding.json`;
    await recordingStorage.storage.writeText(groundingPath, toCanonicalArtifactText({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: {
        'click-submit': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(64) },
        },
        'still-valid-v2': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: 'b'.repeat(64) },
        },
      },
    } as unknown as JsonValueT));
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ file: testPath, status: 'skipped-fresh' }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(recordingStorage.writes).toEqual([expect.objectContaining({ path: groundingPath })]);
    const rewrittenGrounding = JSON.parse(await recordingStorage.storage.readText(groundingPath)) as {
      readonly schemaVersion: number;
      readonly planDigest: string;
      readonly entries: unknown;
    };
    expect(rewrittenGrounding).toMatchObject({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
    });
    expect(rewrittenGrounding.entries).toStrictEqual({});
  });

  it.each([
    ['a stale plan', { force: false, dryRun: false }, 'generated'],
    ['a fresh plan forced to regenerate', { force: true, dryRun: false }, 'generated'],
    ['a stale plan in dry-run', { force: false, dryRun: true }, 'would-generate'],
    ['a fresh plan forced in dry-run', { force: true, dryRun: true }, 'would-generate'],
  ] as const)('generates or previews %s according to force and dry-run policy', async (_description, policy, status) => {
    const { deps, events, execute, recordingStorage } = createScenario();
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
    expect(events.emitted()).toEqual([{ type: 'ai-call' }]);
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

  it('selects the sole own target when configuration omits defaultTarget', async () => {
    const soleTargets = {
      replacement: { baseUrl: 'https://replacement.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
    };
    const { deps, execute, recordingStorage } = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets: soleTargets,
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    });
    await writePrompt(recordingStorage.storage);

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'generated' }],
    });
    expect(execute).toHaveBeenCalledOnce();
    const context = execute.mock.calls[0]?.[0].context as {
      readonly targets: GenerateDeps['config']['targets'];
    };
    expect(Object.keys(context.targets)).toEqual(['replacement']);
    expect(context.targets.replacement).toEqual({
      baseUrl: soleTargets.replacement.baseUrl,
      browser: soleTargets.replacement.browser,
    });
    expect(context.targets.replacement).not.toHaveProperty('healReplayIsolation');
    const plan = PlanDocument.parse(JSON.parse(
      await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.plan.json`),
    ));
    expect(Object.keys(plan.targets)).toEqual(['replacement']);
    expect(plan.targets).toEqual({
      replacement: {
        baseUrl: soleTargets.replacement.baseUrl,
        browser: soleTargets.replacement.browser,
      },
    });
  });

  it.each([
    [
      'an invalid explicit target',
      {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets: RESOLVED_TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex' as const, timeoutMs: 100 },
      },
      { target: 'missing' },
      'The requested target is not configured.',
      { target: 'missing' },
    ],
    [
      'an ambiguous implicit target',
      {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets: {
          web: RESOLVED_TARGETS.web,
          admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
        },
        ai: { provider: 'codex' as const, timeoutMs: 100 },
      },
      {},
      'A target could not be selected from the configured targets.',
      { target: '(default)', targetNames: ['admin', 'web'] },
    ],
  ] as const)('records two ordered shared failures for %s without downstream work', async (
    _description,
    config,
    optionOverride,
    message,
    details,
  ) => {
    const { deps, events, execute, recordingStorage } = createScenario({
      config,
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    const firstPath = await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    const secondPath = await writePrompt(recordingStorage.storage, 'second.test.md', 'second');
    recordingStorage.reset();

    const outcome = await generate(deps, { ...DEFAULT_OPTIONS, ...optionOverride });

    expect(outcome.results.map(({ file, status }) => ({ file, status }))).toEqual([
      { file: firstPath, status: 'failed' },
      { file: secondPath, status: 'failed' },
    ]);
    for (const result of outcome.results) {
      expect(result.error).toBeInstanceOf(TargetUnresolvedError);
      expect(result.error).toMatchObject({
        kind: 'target-unresolved',
        exitCode: 2,
        message,
        details,
      });
      expect(result.error?.details).toEqual(details);
    }
    expect(recordingStorage.reads).toEqual([firstPath, secondPath]);
    expect(recordingStorage.exists).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted()).toEqual([]);
  });

  it('rejects an inherited explicit target without falling back to a valid own default', async () => {
    const inheritedName = 'inherited-preview';
    const inheritedDefinition = {
      baseUrl: 'https://inherited.example.test',
      browser: 'chromium' as const,
      healReplayIsolation: 'stateful' as const,
    };
    const prototype = Object.fromEntries([[inheritedName, inheritedDefinition]]);
    const targets = Object.assign(
      Object.create(prototype) as Record<string, Readonly<typeof inheritedDefinition>>,
      { web: RESOLVED_TARGETS.web },
    ) as GenerateDeps['config']['targets'];
    expect(Object.hasOwn(targets, 'web')).toBe(true);
    expect(Object.hasOwn(targets, inheritedName)).toBe(false);
    expect(targets[inheritedName]).toBe(inheritedDefinition);

    const { deps, events, execute, recordingStorage } = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    const firstPath = await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    const secondPath = await writePrompt(recordingStorage.storage, 'second.test.md', 'second');
    recordingStorage.reset();

    const outcome = await generate(deps, { ...DEFAULT_OPTIONS, target: inheritedName });

    expect(outcome.results.map(({ file, status }) => ({ file, status }))).toEqual([
      { file: firstPath, status: 'failed' },
      { file: secondPath, status: 'failed' },
    ]);
    for (const result of outcome.results) {
      expect(result.error).toBeInstanceOf(TargetUnresolvedError);
      expect(result.error).toMatchObject({
        kind: 'target-unresolved',
        exitCode: 2,
        message: 'The requested target is not configured.',
      });
      expect(result.error?.details).toEqual({ target: inheritedName });
    }
    expect(recordingStorage.reads).toEqual([firstPath, secondPath]);
    expect(recordingStorage.exists).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted()).toEqual([]);
  });

  it.each([
    ['the configured default', undefined, 'web'],
    ['an explicit override', 'admin', 'admin'],
  ] as const)('uses %s before sending the selected target to AI', async (
    _selection,
    target,
    expectedName,
  ) => {
    const targets = {
      web: RESOLVED_TARGETS.web,
      admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
    };
    const { deps, execute, recordingStorage } = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    });
    await writePrompt(recordingStorage.storage);

    await generate(deps, { ...DEFAULT_OPTIONS, ...(target === undefined ? {} : { target }) });

    expect(execute).toHaveBeenCalledOnce();
    const expectedDefinition = {
      baseUrl: targets[expectedName].baseUrl,
      browser: targets[expectedName].browser,
    };
    const otherName = expectedName === 'web' ? 'admin' : 'web';
    const context = execute.mock.calls[0]?.[0].context as {
      readonly targets: GenerateDeps['config']['targets'];
    };
    expect(Object.keys(context.targets)).toEqual([expectedName]);
    expect(context.targets[expectedName]).toEqual(expectedDefinition);
    expect(context.targets[expectedName]).not.toHaveProperty('healReplayIsolation');
    expect(Object.hasOwn(context.targets, otherName)).toBe(false);
    const plan = PlanDocument.parse(JSON.parse(
      await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.plan.json`),
    ));
    expect(Object.keys(plan.targets)).toEqual([expectedName]);
    expect(plan.targets[expectedName]).toEqual(expectedDefinition);
    expect(Object.hasOwn(plan.targets, otherName)).toBe(false);
  });

  it('regenerates for a changed selected target but ignores an unrelated target change', async () => {
    const selectedChanged = {
      web: { baseUrl: 'https://changed.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
      admin: { baseUrl: 'https://admin.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
    };
    const unrelatedChanged = {
      web: RESOLVED_TARGETS.web,
      admin: { baseUrl: 'https://changed-admin.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const },
    };

    const changedScenario = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets: selectedChanged,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    });
    const changedPath = await writePrompt(changedScenario.recordingStorage.storage);
    await createFreshPlan(changedScenario.recordingStorage.storage, changedPath, [], TARGETS);
    changedScenario.recordingStorage.reset();

    await expect(generate(changedScenario.deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'generated' }],
    });
    expect(changedScenario.execute).toHaveBeenCalledOnce();

    const unrelatedScenario = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: [],
        targets: unrelatedChanged,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    });
    const unrelatedPath = await writePrompt(unrelatedScenario.recordingStorage.storage);
    await createFreshPlan(unrelatedScenario.recordingStorage.storage, unrelatedPath, [], TARGETS);
    unrelatedScenario.recordingStorage.reset();

    await expect(generate(unrelatedScenario.deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'skipped-fresh' }],
    });
    expect(unrelatedScenario.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['provider rejection', new AiExecutorUnavailableError('provider unavailable'), 'ai-executor-unavailable'],
    ['invalid response rejection', new AiResponseInvalidError('invalid response'), 'ai-response-invalid'],
  ] as const)('keeps %s as a failed file and continues to later files', async (_description, error, kind) => {
    const { deps, events, recordingStorage } = createScenario({
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
    expect(events.emitted()).toEqual([{ type: 'ai-call' }, { type: 'ai-call' }]);
  });

  it('wraps a per-call timeout as an unavailable executor failure and continues the batch', async () => {
    const caller = new AbortController();
    const timeoutController = new AbortController();
    const secondTimeoutController = new AbortController();
    const timeoutReason = new Error('controlled local timeout');
    const timeoutSpy = interceptTimeouts(new Map([
      [101, timeoutController],
      [102, secondTimeoutController],
    ]));
    const composedTimeoutSignals = captureComposedTimeoutSignals([
      timeoutController.signal,
      secondTimeoutController.signal,
    ]);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const { deps, recordingStorage } = createScenario({
      signal: caller.signal,
      config: { testDir: TEST_DIR, testMatch: ['**/*.test.md'], testIgnore: [], targets: RESOLVED_TARGETS, defaultTarget: 'web', ai: sequentialTimeoutConfig([101, 102]) },
      aiExecutor: createFakeAiExecutor({
        execute: (request) => {
          if (request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && request.context.testMd === 'first') {
            observedSignal = request.signal;
            markStarted?.();
            return new Promise<never>(() => undefined);
          }
          return { data: RESPONSE, raw: JSON.stringify(RESPONSE) };
        },
      }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    try {
      const running = generate(deps, DEFAULT_OPTIONS);
      await started;
      expect(timeoutSpy).toHaveBeenNthCalledWith(1, 101);
      expect(composedTimeoutSignals[0]).toBe(timeoutController.signal);
      expect(observedSignal).not.toBe(caller.signal);
      expect(observedSignal).not.toBe(timeoutController.signal);
      timeoutController.abort(timeoutReason);

      await expect(running).resolves.toMatchObject({
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
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 102);
      expect(composedTimeoutSignals[1]).toBe(secondTimeoutController.signal);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('preserves a caller TimeoutError rather than attributing it to the local timeout', async () => {
    const caller = new AbortController();
    const timeoutController = new AbortController();
    const callerReason = new DOMException('caller cancelled', 'TimeoutError');
    const localReason = new DOMException('fabricated local timeout', 'TimeoutError');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn((request: { readonly signal?: AbortSignal }) => {
      observedSignal = request.signal;
      markStarted?.();
      return new Promise<never>(() => undefined);
    });
    const { deps, recordingStorage } = createScenario({
      signal: caller.signal,
      aiExecutor: createFakeAiExecutor({ execute }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    try {
      const running = generate(deps, DEFAULT_OPTIONS);
      await started;
      caller.abort(callerReason);
      timeoutController.abort(localReason);

      await expect(running).resolves.toMatchObject({ interrupted: true, results: [{ file: `${TEST_DIR}/first.test.md`, status: 'skipped' }, { file: `${TEST_DIR}/second.test.md`, status: 'skipped' }], noTestsFound: false });
      expect(execute).toHaveBeenCalledOnce();
      expect(observedSignal).not.toBe(caller.signal);
      expect(observedSignal).not.toBe(timeoutController.signal);
      expect(observedSignal?.reason).toBe(callerReason);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('keeps an unrelated TimeoutError-named provider rejection generic', async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    const providerError = new DOMException('provider returned a timeout-shaped failure', 'TimeoutError');
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async (request) => {
          if (request.context !== null && typeof request.context === 'object' && 'testMd' in request.context && request.context.testMd === 'first') {
            throw providerError;
          }
          return { data: RESPONSE, raw: JSON.stringify(RESPONSE) };
        },
      }),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'first.test.md', 'first');
    await writePrompt(recordingStorage.storage, 'second.test.md', 'second');

    try {
      await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
        results: [
          { status: 'failed', error: { kind: 'ai-executor-unavailable', message: 'The AI provider call failed.' } },
          { status: 'generated' },
        ],
      });
      expect(timeoutController.signal.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
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

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toEqual({ results: [{ file: `${TEST_DIR}/first.test.md`, status: 'skipped' }, { file: `${TEST_DIR}/second.test.md`, status: 'skipped' }], noTestsFound: false, interrupted: true });
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

    await expect(running).resolves.toMatchObject({ interrupted: true, results: [{ file: `${TEST_DIR}/first.test.md`, status: 'skipped' }, { file: `${TEST_DIR}/second.test.md`, status: 'skipped' }], noTestsFound: false });
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
        await recordingStorage.storage.writeText(
          groundingPath,
          toCanonicalArtifactText(staleGrounding as unknown as JsonValueT),
        );
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
        await recordingStorage.storage.writeText(
          groundingPath,
          toCanonicalArtifactText(staleGrounding as unknown as JsonValueT),
        );
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

  it('continues to the next file when secret-grant attribution fails for one generated response', async () => {
    const unattributableResponse: GeneratedPlanResponse = {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef: FIRST_SECRET_REF,
        citation: 'This citation is absent from the first prompt.',
      }],
      ambiguities: [],
    };
    const responses: readonly GeneratedPlanResponse[] = [unattributableResponse, RESPONSE];
    let responseIndex = 0;
    const execute = vi.fn(async () => {
      const response = responses[responseIndex];
      responseIndex += 1;
      if (response === undefined) {
        throw new Error('The batch fixture received an unexpected extra AI call.');
      }
      return { data: response, raw: JSON.stringify(response) };
    });
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({ execute }),
      discoverTestFiles: async () => ['unattributable.test.md', 'valid.test.md'],
    });
    await writePrompt(recordingStorage.storage, 'unattributable.test.md', `@ambercast-secret ${FIRST_SECRET_REF}\n`);
    await writePrompt(recordingStorage.storage, 'valid.test.md', 'A prompt without secret grants.\n');
    recordingStorage.reset();

    const outcome = await generate(deps, DEFAULT_OPTIONS);

    expect(outcome.results).toMatchObject([
      { file: `${TEST_DIR}/unattributable.test.md`, status: 'failed' },
      { file: `${TEST_DIR}/valid.test.md`, status: 'generated' },
    ]);
    expect(outcome.results[0]?.error).toBeInstanceOf(SecretGrantUnattributableError);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(SECRET_GRANT_CITATION_FAILURES)(
    'rejects %s before writing generated artifacts',
    async (_description, response, testMd, reason) => {
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: response, raw: JSON.stringify(response) }),
        }),
      });
      const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', testMd);
      recordingStorage.reset();

      const outcome = await generate(deps, DEFAULT_OPTIONS);

      expect(outcome.results[0]).toMatchObject({ file: testPath, status: 'failed' });
      expect(outcome.results[0]?.error).toBeInstanceOf(SecretGrantUnattributableError);
      expect(outcome.results[0]?.error).toMatchObject({ details: { reason } });
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it.each(SECRET_GRANT_CITATION_FAILURES)(
    'rejects %s through the --dry-run path without writing artifacts',
    async (_description, response, testMd, reason) => {
      const { deps, recordingStorage } = createScenario({
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: response, raw: JSON.stringify(response) }),
        }),
      });
      const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', testMd);
      recordingStorage.reset();

      const outcome = await generate(deps, { ...DEFAULT_OPTIONS, dryRun: true });

      expect(outcome.results[0]).toMatchObject({ file: testPath, status: 'failed' });
      expect(outcome.results[0]?.error).toBeInstanceOf(SecretGrantUnattributableError);
      expect(outcome.results[0]?.error).toMatchObject({ details: { reason } });
      expect(recordingStorage.writes).toEqual([]);
    },
  );

  it.each([
    ['generated', DEFAULT_OPTIONS, 'generated'],
    ['dry-run', { ...DEFAULT_OPTIONS, dryRun: true }, 'would-generate'],
  ] as const)('keeps grounded secret usage on the existing %s path', async (_mode, options, status) => {
    const declaredSecretRef = '{{secrets.LOGIN_PASSWORD}}';
    const secondDeclaredSecretRef = '{{secrets.PAYMENT_TOKEN}}';
    const response = {
      steps: [
        {
          id: 'fill-password',
          kind: 'action',
          action: 'fill-secret',
          target: PASSWORD_TARGET,
          secretRef: declaredSecretRef,
          citation: `@ambercast-secret ${declaredSecretRef}`,
        },
        {
          id: 'complete-sign-in',
          kind: 'ai',
          instruction: 'Complete the sign-in flow.',
          instructionCoverage: [{
            id: 'dashboard-reached',
            kind: 'success',
            citation: 'When I submit valid credentials, I reach the dashboard.',
          }],
          verificationIntent: [{
            criterionId: 'dashboard-reached',
            assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
          }],
          secrets: [{ ref: secondDeclaredSecretRef, citation: `@ambercast-secret ${secondDeclaredSecretRef}` }],
        },
      ],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: response, raw: JSON.stringify(response) }),
      }),
    });
    const testPath = await writePrompt(
      recordingStorage.storage,
      'login.test.md',
      `${PROMPT}\n@ambercast-secret ${declaredSecretRef}\n@ambercast-secret ${secondDeclaredSecretRef}\n`,
    );
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

  it('round-trips a generated secret-bearing plan with byte-identical artifact text', async () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const response: GeneratedPlanResponse = {
      steps: [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD_TARGET,
        secretRef,
        citation: `@ambercast-secret ${secretRef}`,
      }],
      ambiguities: [],
    };
    const { deps, recordingStorage } = createScenario({
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: response, raw: JSON.stringify(response) }),
      }),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n@ambercast-secret ${secretRef}\n`);

    const outcome = await generate(deps, DEFAULT_OPTIONS);
    const text = await recordingStorage.storage.readText(deps.layout.planPathFor(testPath));
    const parsed = PlanDocument.parse(JSON.parse(text));

    expect(outcome.results[0]).toMatchObject({ status: 'generated' });
    expect(toCanonicalArtifactText(parsed as unknown as JsonValueT)).toBe(text);
  });

  const producerBundleMeta = {
    fingerprint: expect.any(String),
    components: {
      generatorPromptTemplate: expect.any(String),
      generatorTaskInstruction: expect.any(String),
      generatedPlanResponseSchema: expect.any(String),
      generatedPlanResponseLocalContract: expect.any(String),
      instructionCoveragePolicyRevision: expect.any(Number),
      generatorSecretPolicyRevision: expect.any(Number),
    },
  };

  it.each([
    ['creates the producer bundle when the provider omits generatorMeta', undefined, { planProducerBundle: producerBundleMeta }],
    ['preserves unrelated provider generatorMeta keys', { provider: 'fixture' }, { provider: 'fixture', planProducerBundle: producerBundleMeta }],
    ['overrides a provider-supplied producer bundle', { planProducerBundle: { fingerprint: 'provider-value', providerOwnedField: 'must-not-survive' } }, { planProducerBundle: producerBundleMeta }],
  ] as const)('%s', async (_name, generatorMeta, expectedGeneratorMeta) => {
    const response = { ...RESPONSE, ...(generatorMeta === undefined ? {} : { generatorMeta }) } as GeneratedPlanResponse;
    const { deps, recordingStorage } = createScenario({ aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw: JSON.stringify(response) }) }) });
    const testPath = await writePrompt(recordingStorage.storage);

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ status: 'generated' }] });
    const artifact = JSON.parse(await recordingStorage.storage.readText(deps.layout.planPathFor(testPath))) as { generatorMeta: unknown };
    expect(artifact.generatorMeta).toEqual(expectedGeneratorMeta);
  });

  it('records the same producer fingerprint in generatorMeta and the written inputs digest contract', async () => {
    const { deps, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);

    await generate(deps, DEFAULT_OPTIONS);
    const artifact = JSON.parse(await recordingStorage.storage.readText(deps.layout.planPathFor(testPath))) as { source: { inputsDigest: string }; generatorMeta: { planProducerBundle: { fingerprint: string } } };
    expect(artifact.generatorMeta.planProducerBundle.fingerprint).toBe(planProducerBundle.planProducerBundleFingerprint());
    expect(artifact.source.inputsDigest).toBe(computeInputsDigest({
      normalizedTestMd: normalizeTestMd(PROMPT),
      schemaVersion: 2,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      planProducerBundleFingerprint: artifact.generatorMeta.planProducerBundle.fingerprint,
      targetDefinitions: TARGETS,
    }));
  });

  it('changes the written inputs digest when the producer bundle fingerprint changes', async () => {
    const firstFingerprint = 'a'.repeat(64);
    const secondFingerprint = 'b'.repeat(64);
    const inputs = {
      generatorPromptTemplate: 'template',
      generatorTaskInstruction: 'task',
      generatedPlanResponseSchema: { type: 'object' },
      generatedPlanResponseLocalContract: { type: 'object' },
      instructionCoveragePolicyRevision: 1,
      generatorSecretPolicyRevision: 1,
    };
    const components = {
      generatorPromptTemplate: '1'.repeat(64),
      generatorTaskInstruction: '2'.repeat(64),
      generatedPlanResponseSchema: '3'.repeat(64),
      generatedPlanResponseLocalContract: '4'.repeat(64),
      instructionCoveragePolicyRevision: 1,
      generatorSecretPolicyRevision: 1,
    };
    const inputsSpy = vi.spyOn(planProducerBundle, 'liveProducerBundleInputs').mockReturnValue(inputs);
    const diagnosticsSpy = vi.spyOn(planProducerBundle, 'planProducerBundleComponentDiagnostics').mockReturnValue(components);
    const fingerprintSpy = vi.spyOn(planProducerBundle, 'computePlanProducerBundleFingerprint')
      .mockReturnValueOnce(firstFingerprint)
      .mockReturnValueOnce(secondFingerprint);
    const { deps, recordingStorage } = createScenario();
    const firstPath = await writePrompt(recordingStorage.storage, 'first.test.md');
    const secondPath = await writePrompt(recordingStorage.storage, 'second.test.md');

    await generate(deps, { ...DEFAULT_OPTIONS, files: [firstPath] });
    await generate(deps, { ...DEFAULT_OPTIONS, files: [secondPath] });

    const firstArtifact = JSON.parse(await recordingStorage.storage.readText(deps.layout.planPathFor(firstPath))) as { source: { inputsDigest: string } };
    const secondArtifact = JSON.parse(await recordingStorage.storage.readText(deps.layout.planPathFor(secondPath))) as { source: { inputsDigest: string } };
    expect(firstArtifact.source.inputsDigest).not.toBe(secondArtifact.source.inputsDigest);
    fingerprintSpy.mockRestore();
    diagnosticsSpy.mockRestore();
    inputsSpy.mockRestore();
  });
});

describe('generate interruption contract', () => {
  it('deduplicates pre-aborted non-list occurrences into one identity-only skipped row without starting I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, recordingStorage } = createScenario({ signal: controller.signal });

    const outcome = await generate(deps, { ...DEFAULT_OPTIONS, files: [`${TEST_DIR}/same.test.md`, `${TEST_DIR}/same.test.md`] });

    expect(outcome.interrupted).toBe(true);
    expect(outcome.results).toEqual([
      { file: `${TEST_DIR}/same.test.md`, status: 'skipped' },
    ]);
    expect(recordingStorage.reads).toEqual([]);
  });

  it('keeps list mode atomic for an already aborted signal and exposes a false interruption fact', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, recordingStorage } = createScenario({ signal: controller.signal });

    const outcome = await generate(deps, { ...DEFAULT_OPTIONS, files: [`${TEST_DIR}/a.test.md`, `${TEST_DIR}/b.test.md`], list: true });

    expect(outcome.interrupted).toBe(false);
    expect(outcome.results).toEqual([
      { file: `${TEST_DIR}/a.test.md`, status: 'listed' },
      { file: `${TEST_DIR}/b.test.md`, status: 'listed' },
    ]);
    expect(recordingStorage.reads).toEqual([]);
  });

  it('skips the interrupted provider work and pending suffix without later I/O or AI', async () => {
    const controller = new AbortController();
    let releaseFirst: ((value: { data: GeneratedPlanResponse; raw: string }) => void) | undefined;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const execute = vi.fn(() => new Promise<{ data: GeneratedPlanResponse; raw: string }>((resolve) => {
      releaseFirst = resolve;
      started?.();
    }));
    const { deps, recordingStorage } = createScenario({
      signal: controller.signal,
      aiExecutor: createFakeAiExecutor({ execute }),
      discoverTestFiles: vi.fn(async () => ['first.test.md', 'second.test.md', 'third.test.md']),
    });
    const first = await writePrompt(recordingStorage.storage, 'first.test.md');
    const second = await writePrompt(recordingStorage.storage, 'second.test.md');
    const third = await writePrompt(recordingStorage.storage, 'third.test.md');
    recordingStorage.reset();

    const running = generate(deps, DEFAULT_OPTIONS);
    await firstStarted;
    controller.abort();
    releaseFirst?.({ data: RESPONSE, raw: JSON.stringify(RESPONSE) });

    await expect(running).resolves.toMatchObject({
      interrupted: true,
      results: [
        { file: first, status: 'skipped' },
        { file: second, status: 'skipped' },
        { file: third, status: 'skipped' },
      ],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(recordingStorage.reads).toEqual(expect.arrayContaining([first]));
    expect(recordingStorage.reads.filter((path) => path === second || path === third)).toEqual([]);
  });

  it('keeps a pending duplicate occurrence as its own skipped row after the first occurrence becomes terminal', async () => {
    const controller = new AbortController();
    const path = `${TEST_DIR}/same.test.md`;
    const recordingStorage = createRecordingStorage();
    const storage: StorageAdapter = {
      ...recordingStorage.storage,
      async writeText(writtenPath, content) {
        await recordingStorage.storage.writeText(writtenPath, content);
        if (writtenPath === `${TEST_DIR}/same.ambercast.plan.json`) controller.abort();
      },
    };
    const { deps } = createScenario({
      signal: controller.signal,
      storage,
      discoverTestFiles: vi.fn(async () => ['same.test.md', 'same.test.md']),
    });
    await writePrompt(storage, 'same.test.md');
    recordingStorage.reset();

    await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      interrupted: true,
      results: [
        { file: path, status: 'generated' },
        { file: path, status: 'skipped' },
      ],
    });
  });

  it('cancels an in-flight provider request without writing artifacts and skips its pending work', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const execute = vi.fn((request: AiExecuteRequest<unknown>) => new Promise<never>((_resolve, reject) => {
      const signal = request.signal;
      if (signal === undefined) throw new Error('Expected provider cancellation signal.');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started?.();
    }));
    const { deps, recordingStorage } = createScenario({
      signal: controller.signal,
      aiExecutor: createFakeAiExecutor({ execute }),
      discoverTestFiles: vi.fn(async () => ['first.test.md', 'second.test.md']),
    });
    const first = await writePrompt(recordingStorage.storage, 'first.test.md');
    const second = await writePrompt(recordingStorage.storage, 'second.test.md');
    recordingStorage.reset();

    const running = generate(deps, DEFAULT_OPTIONS);
    await firstStarted;
    controller.abort(new Error('stop'));

    await expect(running).resolves.toMatchObject({
      interrupted: true,
      results: [
        { file: first, status: 'skipped' },
        { file: second, status: 'skipped' },
      ],
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it.each(['normal return', 'discovery rejection'] as const)('disposes the interruption tracker from generate finally after %s', async (mode) => {
    const dispose = vi.spyOn(BatchInterruptionTracker.prototype, 'dispose');
    const controller = new AbortController();
    const { deps, recordingStorage } = createScenario({
      signal: controller.signal,
      discoverTestFiles: mode === 'normal return'
        ? vi.fn(async () => ['login.test.md'])
        : vi.fn(async () => { throw new Error('discovery failed'); }),
    });
    if (mode === 'normal return') await writePrompt(recordingStorage.storage);

    if (mode === 'normal return') {
      await expect(generate(deps, DEFAULT_OPTIONS)).resolves.toBeDefined();
    } else {
      await expect(generate(deps, DEFAULT_OPTIONS)).rejects.toThrow('discovery failed');
    }
    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });
});
