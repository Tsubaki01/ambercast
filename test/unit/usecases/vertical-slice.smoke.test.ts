import { describe, expect, it, vi } from 'vitest';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computePlanDigest } from '#core/ir/digest.js';
import {
  GroundingDocument,
  PlanDocument,
  type ElementRef,
  type Fingerprint,
  type GeneratedPlanResponse,
  type JsonValueT,
  type TraceAssert,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { AiActionController } from '#ports/ai.js';
import { check, type CheckDeps, type CheckOptions } from '#usecases/check.js';
import { buildCheckReport } from '#usecases/check-report.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { baseUrlSecretPolicy } from '../../doubles/base-url-secret-policy.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession, elementRefKey } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TEST_PATH = `${TEST_DIR}/login.test.md`;
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const GENERATED_RESPONSE: GeneratedPlanResponse = {
  steps: [
    {
      id: 'fill-email',
      kind: 'action',
      action: 'fill',
      target: { strategy: 'accessibility', role: 'textbox', name: 'Email' },
      value: 'person@example.test',
    },
    {
      id: 'click-submit',
      kind: 'action',
      action: 'click',
      target: { strategy: 'accessibility', role: 'button', name: 'Submit' },
    },
  ],
  ambiguities: [],
};

const GENERATE_OPTIONS: GenerateOptions = {
  files: [TEST_PATH],
  strict: false,
  force: false,
  dryRun: false,
  allowEmpty: false,
  list: false,
};
const RUN_OPTIONS: RunOptions = { files: [TEST_PATH], cacheOnly: false, updateCache: false, allowEmpty: false, list: false, stale: 'fail' };
const CHECK_OPTIONS: CheckOptions = { files: [TEST_PATH], allowEmpty: false, list: false };
const SUCCESS_CITATION = 'When I submit valid credentials, I reach the dashboard.';
const SUCCESS_INTENT = {
  criterionId: 'dashboard-reached',
  assertion: { type: 'assert' as const, check: 'text-visible' as const, text: 'Dashboard' },
};

async function evaluateTerminal(controller: AiActionController, assertion: TraceAssert): Promise<unknown> {
  return (controller as unknown as {
    evaluateAssert(check: TraceAssert, criterionId?: string): Promise<unknown>;
  }).evaluateAssert(assertion, SUCCESS_INTENT.criterionId);
}

function checkDeps(storage: ReturnType<typeof createInMemoryStorage>, layout: ReturnType<typeof createLayoutResolver>): CheckDeps {
  return {
    storage,
    layout,
    discoverTestFiles: async () => [],
    config: {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
      targets: TARGETS,
      defaultTarget: 'web',
      grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
    },
  };
}

describe('fake vertical slice', () => {
  it('checks a fresh plan produced by generate with its cold grounding cache', async () => {
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    await storage.writeText(TEST_PATH, PROMPT);
    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: GENERATED_RESPONSE, raw: JSON.stringify(GENERATED_RESPONSE) }),
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    };

    await generate(generateDeps, GENERATE_OPTIONS);

    await expect(check(checkDeps(storage, layout), CHECK_OPTIONS)).resolves.toMatchObject({
      results: [{ id: TEST_PATH, status: 'fresh' }],
      errors: [],
      noTestsFound: false,
    });
  });

  it('checks a fresh plan after run updates its grounding cache', async () => {
    const generatedResponse = {
      steps: [{
        id: 'recorded-ai',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        secrets: [],
        instructionCoverage: [{ id: SUCCESS_INTENT.criterionId, kind: 'success', citation: SUCCESS_CITATION }],
        verificationIntent: [SUCCESS_INTENT],
      }],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    await storage.writeText(TEST_PATH, PROMPT);
    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }),
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    };
    await generate(generateDeps, GENERATE_OPTIONS);

    const session = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
    });
    const runDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor: async () => createFakeAiExecutor({
        async executeAgentic(request) {
          await request.controller.perform({ type: 'navigate', url: '/dashboard' });
          await evaluateTerminal(request.controller, { type: 'assert', check: 'text-visible', text: 'Dashboard' });
          return { outcome: 'success' };
        },
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    };

    await expect(run(runDeps, RUN_OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });
    expect(GroundingDocument.parse(JSON.parse(await storage.readText(layout.groundingPathFor(TEST_PATH)))).entries)
      .not.toEqual({});

    await expect(check(checkDeps(storage, layout), CHECK_OPTIONS)).resolves.toMatchObject({
      results: [{ id: TEST_PATH, status: 'fresh' }],
      errors: [],
      noTestsFound: false,
    });
  });

  it('keeps a canonical coverage-bearing grounding fresh and replays it without AI calls', async () => {
    const generatedResponse = {
      steps: [{
        id: 'recorded-ai',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        secrets: [],
        instructionCoverage: [{ id: SUCCESS_INTENT.criterionId, kind: 'success', citation: SUCCESS_CITATION }],
        verificationIntent: [SUCCESS_INTENT],
      }],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    await storage.writeText(TEST_PATH, PROMPT);
    await generate({
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }),
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    }, GENERATE_OPTIONS);

    const recordingSession = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
    });
    const initialRunDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: () => createFakeBrowserDriver(() => recordingSession),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor: async () => createFakeAiExecutor({
        async executeAgentic(request) {
          await request.controller.perform({ type: 'navigate', url: '/dashboard' });
          await evaluateTerminal(request.controller, { type: 'assert', check: 'text-visible', text: 'Dashboard' });
          return { outcome: 'success' };
        },
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    };
    await expect(run(initialRunDeps, RUN_OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    await expect(check(checkDeps(storage, layout), CHECK_OPTIONS)).resolves.toMatchObject({
      results: [{ id: TEST_PATH, status: 'fresh' }],
      errors: [],
      noTestsFound: false,
    });

    const replaySession = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
    });
    const events = createRecordingEventSink();
    const replay = await run({
      ...initialRunDeps,
      browserDriver: () => createFakeBrowserDriver(() => replaySession),
      resolveAiExecutor: async () => {
        throw new Error('The coverage-grounded vertical slice must not resolve an AI executor.');
      },
      events: events.sink,
    }, RUN_OPTIONS);

    expect(replay.results).toMatchObject([{ result: { status: 'passed' } }]);
    expect(replay.results).toHaveLength(1);
    expect(replay.results[0]?.error).toBeUndefined();
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
  });

  it('rejects a noncanonical coverage-bearing grounding consistently in check and run', async () => {
    const generatedResponse = {
      steps: [{
        id: 'recorded-ai',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        secrets: [],
        instructionCoverage: [{ id: SUCCESS_INTENT.criterionId, kind: 'success', citation: SUCCESS_CITATION }],
        verificationIntent: [SUCCESS_INTENT],
      }],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    await storage.writeText(TEST_PATH, PROMPT);
    await generate({
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }),
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    }, GENERATE_OPTIONS);

    const session = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
    });
    const runDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor: async () => createFakeAiExecutor({
        async executeAgentic(request) {
          await request.controller.perform({ type: 'navigate', url: '/dashboard' });
          await evaluateTerminal(request.controller, { type: 'assert', check: 'text-visible', text: 'Dashboard' });
          return { outcome: 'success' };
        },
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    };
    await expect(run(runDeps, RUN_OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    const groundingPath = layout.groundingPathFor(TEST_PATH);
    const grounding = JSON.parse(await storage.readText(groundingPath));
    await storage.writeText(groundingPath, JSON.stringify(grounding, null, 4));

    const checkOutcome = await check(checkDeps(storage, layout), CHECK_OPTIONS);

    expect(checkOutcome).toMatchObject({
      results: [{ id: TEST_PATH, status: 'invalid-grounding' }],
      errors: [],
      noTestsFound: false,
    });
    expect(buildCheckReport({
      startedAt: '2026-08-24T00:00:00Z', durationMs: 1, options: CHECK_OPTIONS, outcome: checkOutcome,
    }).exitCode).toBe(4);

    const outcome = await run(runDeps, RUN_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(outcome.results[0]?.error).toMatchObject({ details: { reason: 'coverage-canonical-invalid' } });
  });

  it('replays a generated plan from pre-seeded grounding without AI calls', async () => {
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    const generateEvents = createRecordingEventSink();
    const execute = vi.fn(async () => ({ data: GENERATED_RESPONSE, raw: JSON.stringify(GENERATED_RESPONSE) }));
    await storage.writeText(TEST_PATH, PROMPT);

    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({ execute }),
      events: generateEvents.sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    };

    await expect(generate(generateDeps, GENERATE_OPTIONS)).resolves.toMatchObject({
      noTestsFound: false,
      results: [{ file: TEST_PATH, status: 'generated', planFile: layout.planPathFor(TEST_PATH) }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(generateEvents.emitted()).toEqual([{ type: 'ai-call' }]);

    const plan = PlanDocument.parse(JSON.parse(await storage.readText(layout.planPathFor(TEST_PATH))));
    expect(GroundingDocument.parse(JSON.parse(await storage.readText(layout.groundingPathFor(TEST_PATH))))).toEqual({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: {},
    });

    const sharedGroundingFixture = plan.steps.map((step, index) => {
      if (!('target' in step)) {
        throw new Error('The generated smoke-test plan must contain only element-bearing steps.');
      }

      const fingerprint: Fingerprint = {
        algorithm: 'a11y-neighborhood-v2',
        hash: String(index + 1).padStart(64, '0'),
      };
      return { stepId: step.id, target: step.target, fingerprint };
    });
    // Path B covers a cold-start grounding miss; this test exercises only pre-seeded grounding.
    const seededGrounding: GroundingDocument = {
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: Object.fromEntries(sharedGroundingFixture.map(({ stepId, fingerprint }) => [
        stepId,
        { kind: 'element' as const, fingerprint },
      ])),
    };
    await storage.writeText(
      layout.groundingPathFor(TEST_PATH),
      toCanonicalArtifactText(seededGrounding as unknown as JsonValueT),
    );

    const session = createFakeBrowserSession(new Map(sharedGroundingFixture.map(({ target, fingerprint }) => [
      elementRefKey(target),
      { exists: true, currentFingerprint: fingerprint },
    ] as const)));
    const events = createRecordingEventSink();
    const runDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor: async () => {
        throw new Error('The fully grounded vertical slice must not resolve an AI executor.');
      },
      events: events.sink,
      discoverTestFiles: async () => [],
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    };

    const outcome = await run(runDeps, RUN_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual(plan.steps.map((step) => ({
      type: 'step-result',
      stepId: step.id,
      via: 'grounding',
    })));
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });

  // A cold-start miss through path B is intentionally outside this vertical-slice test's scope.
  it('replays a generated AI-step secret grant from pre-seeded grounding without AI calls', async () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const secretTarget: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Password' };
    const generatedResponse = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete sign-in.',
        secrets: [{ ref: secretRef, citation: `@ambercast-secret ${secretRef}` }],
        instructionCoverage: [{ id: SUCCESS_INTENT.criterionId, kind: 'success', citation: SUCCESS_CITATION }],
        verificationIntent: [SUCCESS_INTENT],
      }],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    const execute = vi.fn(async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }));
    await storage.writeText(TEST_PATH, `${PROMPT}\n@ambercast-secret ${secretRef}\n`);

    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({ execute }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    };

    const generation = await generate(generateDeps, GENERATE_OPTIONS);

    expect(generation.results).toMatchObject([{ status: 'generated' }]);
    const plan = PlanDocument.parse(JSON.parse(await storage.readText(layout.planPathFor(TEST_PATH))));
    expect(plan.steps).toEqual([expect.objectContaining({
      id: 'complete-sign-in',
      secrets: [{ ref: secretRef, sourceSpan: { startLine: 5, endLine: 5 } }],
    })]);

    const grounding = GroundingDocument.parse({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: {
        'complete-sign-in': {
          kind: 'ai',
          trace: {
            events: [{ type: 'fill-secret', target: secretTarget, secretRef }],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
            verificationCoverage: { [SUCCESS_INTENT.criterionId]: 0 },
          },
        },
      },
    });
    await storage.writeText(
      layout.groundingPathFor(TEST_PATH),
      toCanonicalArtifactText(grounding as unknown as JsonValueT),
    );

    const session = createFakeBrowserSession(new Map([
      [elementRefKey(secretTarget), { exists: true, currentFingerprint: {
        algorithm: 'a11y-neighborhood-v2',
        hash: 'a'.repeat(64),
      } }],
    ]), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
    });
    const events = createRecordingEventSink();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => {
      throw new Error('Path-C replay must not resolve an AI executor.');
    });
    const runDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map([[secretRef, 'resolved-at-run-time']])),
      resolveAiExecutor,
      events: events.sink,
      discoverTestFiles: async () => [],
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    };

    const outcome = await run(runDeps, RUN_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(session.operations()).toContainEqual({
      type: 'fill-secret',
      target: expect.objectContaining({ ref: secretTarget }),
      value: 'resolved-at-run-time',
      policy: baseUrlSecretPolicy(secretRef, TARGETS.web),
    });
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.results[0])).not.toContain('resolved-at-run-time');
    expect(await storage.readText(layout.groundingPathFor(TEST_PATH))).not.toContain('resolved-at-run-time');
  });

  // A cold-start miss through path B is intentionally outside this vertical-slice test's scope.
  it('rejects a generated AI-step secret grant that the prompt never declares', async () => {
    const undeclaredSecretRef = '{{secrets.LOGIN_PASSWORD}}';
    const generatedResponse = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete sign-in.',
        secrets: [{ ref: undeclaredSecretRef, citation: `@ambercast-secret ${undeclaredSecretRef}` }],
        instructionCoverage: [{ id: SUCCESS_INTENT.criterionId, kind: 'success', citation: SUCCESS_CITATION }],
        verificationIntent: [SUCCESS_INTENT],
      }],
      ambiguities: [],
    } as unknown as GeneratedPlanResponse;
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    await storage.writeText(TEST_PATH, PROMPT);
    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({
        execute: async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }),
      }),
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 100 },
      },
    };

    const generation = await generate(generateDeps, GENERATE_OPTIONS);

    expect(generation.results[0]).toMatchObject({ status: 'failed' });
    expect(generation.results[0]?.error).toBeInstanceOf(SecretGrantUnattributableError);
    expect(await storage.exists(layout.planPathFor(TEST_PATH))).toBe(false);
    expect(await storage.exists(layout.groundingPathFor(TEST_PATH))).toBe(false);
  });
});
