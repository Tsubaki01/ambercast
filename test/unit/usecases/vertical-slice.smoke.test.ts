import { describe, expect, it, vi } from 'vitest';
import { SecretRefUndeclaredError } from '#core/errors/secret-ref-undeclared-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computePlanDigest } from '#core/ir/digest.js';
import {
  GroundingDocument,
  PlanDocument,
  type ElementRef,
  type Fingerprint,
  type GeneratedPlanResponse,
  type JsonValueT,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
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
const RUN_OPTIONS: RunOptions = { files: [TEST_PATH], cacheOnly: false, stale: 'fail' };

describe('fake vertical slice', () => {
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
        algorithm: 'a11y-neighborhood-v1',
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
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor: async () => {
        throw new Error('The fully grounded vertical slice must not resolve an AI executor.');
      },
      events: events.sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
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
    const generatedResponse: GeneratedPlanResponse = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete sign-in.',
        secrets: [secretRef],
      }],
      ambiguities: [],
    };
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    const execute = vi.fn(async () => ({ data: generatedResponse, raw: JSON.stringify(generatedResponse) }));
    await storage.writeText(TEST_PATH, `${PROMPT}\n${secretRef}\n`);

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
    expect(plan.steps).toEqual([expect.objectContaining({ id: 'complete-sign-in', secrets: [secretRef] })]);

    const grounding = GroundingDocument.parse({
      schemaVersion: 1,
      planDigest: computePlanDigest(plan),
      entries: {
        'complete-sign-in': {
          kind: 'ai',
          trace: {
            events: [{ type: 'fill-secret', target: secretTarget, secretRef }],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
          },
        },
      },
    });
    await storage.writeText(
      layout.groundingPathFor(TEST_PATH),
      toCanonicalArtifactText(grounding as unknown as JsonValueT),
    );

    const session = createFakeBrowserSession(new Map());
    const events = createRecordingEventSink();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => {
      throw new Error('Path-C replay must not resolve an AI executor.');
    });
    const runDeps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
      browserDriver: () => createFakeBrowserDriver(() => session),
      secrets: createFakeSecretsProvider(new Map([[secretRef, 'resolved-at-run-time']])),
      resolveAiExecutor,
      events: events.sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
      },
    };

    const outcome = await run(runDeps, RUN_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(session.operations()).toContainEqual({
      type: 'perform',
      action: { type: 'fill-secret', target: secretTarget, value: 'resolved-at-run-time' },
    });
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome.results[0])).not.toContain('resolved-at-run-time');
    expect(await storage.readText(layout.groundingPathFor(TEST_PATH))).not.toContain('resolved-at-run-time');
  });

  // A cold-start miss through path B is intentionally outside this vertical-slice test's scope.
  it('rejects a generated AI-step secret grant that the prompt never declares', async () => {
    const undeclaredSecretRef = '{{secrets.LOGIN_PASSWORD}}';
    const generatedResponse: GeneratedPlanResponse = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete sign-in.',
        secrets: [undeclaredSecretRef],
      }],
      ambiguities: [],
    };
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
    expect(generation.results[0]?.error).toBeInstanceOf(SecretRefUndeclaredError);
    expect(await storage.exists(layout.planPathFor(TEST_PATH))).toBe(false);
    expect(await storage.exists(layout.groundingPathFor(TEST_PATH))).toBe(false);
  });
});
