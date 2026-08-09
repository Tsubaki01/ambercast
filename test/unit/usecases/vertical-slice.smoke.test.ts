import { describe, expect, it, vi } from 'vitest';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computePlanDigest } from '#core/ir/digest.js';
import {
  GroundingDocument,
  PlanDocument,
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
    const execute = vi.fn(async () => ({ data: GENERATED_RESPONSE, raw: JSON.stringify(GENERATED_RESPONSE) }));
    await storage.writeText(TEST_PATH, PROMPT);

    const generateDeps: GenerateDeps = {
      storage,
      layout,
      aiExecutor: createFakeAiExecutor({ execute }),
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
    // A cold-start miss (fresh generate() grounding without this pre-seed) is deferred to path B; this test cannot and does not exercise that path.
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
});
