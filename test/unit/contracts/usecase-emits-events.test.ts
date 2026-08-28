import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { planProducerBundleFingerprint } from '#core/ai/plan-producer-bundle.js';
import {
  PlanDocument,
  type GeneratedPlanResponse,
  type GroundingDocument,
  type JsonValueT,
} from '#core/ir/schema.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { registerUsecaseEmitsEventsContract } from '../../contracts/usecase-emits-events.contract.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TEST_PATH = `${TEST_DIR}/login.test.md`;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const GENERATED_RESPONSE: GeneratedPlanResponse = { steps: [], ambiguities: [] };
const GENERATE_OPTIONS: GenerateOptions = {
  files: [TEST_PATH],
  strict: false,
  force: false,
  dryRun: false,
  allowEmpty: false,
  list: false,
};
const RUN_OPTIONS: RunOptions = { files: [TEST_PATH], cacheOnly: false, updateCache: false, allowEmpty: false, list: false, stale: 'fail' };

registerUsecaseEmitsEventsContract([
  {
    name: 'generate',
    async run() {
      const storage = createInMemoryStorage();
      const events = createRecordingEventSink();

      await storage.writeText(TEST_PATH, PROMPT);
      await generate({
        storage,
        layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
        aiExecutor: createFakeAiExecutor({
          execute: async () => ({ data: GENERATED_RESPONSE, raw: JSON.stringify(GENERATED_RESPONSE) }),
        }),
        events: events.sink,
        discoverTestFiles: async () => [],
        config: {
          testDir: TEST_DIR,
          testMatch: ['**/*.test.md'],
          testIgnore: ['**/.runs/**'],
          targets: { web: { ...TARGETS.web, healReplayIsolation: 'stateful' } },
          defaultTarget: 'web',
          ai: { provider: 'codex', timeoutMs: 100 },
        },
      } satisfies GenerateDeps, GENERATE_OPTIONS);

      return { emitted: events.emitted() };
    },
  },
  {
    name: 'run',
    async run() {
      const storage = createInMemoryStorage();
      const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
      const events = createRecordingEventSink();
      const inputsDigest = computeInputsDigest({
        normalizedTestMd: normalizeTestMd(PROMPT),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        planProducerBundleFingerprint: planProducerBundleFingerprint(),
        targetDefinitions: TARGETS,
      });
      const plan = PlanDocument.parse({
        schemaVersion: 2,
        source: { inputsDigest },
        targets: TARGETS,
        steps: [{ id: 'navigate-home', kind: 'action', action: 'navigate', url: '/' }],
      });
      const grounding: GroundingDocument = {
        schemaVersion: 1,
        planDigest: computePlanDigest(plan),
        entries: {},
      };

      await storage.writeText(TEST_PATH, PROMPT);
      await storage.writeText(layout.planPathFor(TEST_PATH), toCanonicalArtifactText(plan as unknown as JsonValueT));
      await storage.writeText(layout.groundingPathFor(TEST_PATH), toCanonicalArtifactText(grounding as unknown as JsonValueT));
      await run({
        storage,
        layout,
        clock: createFixedClock(new Date('2026-08-11T00:00:00.000Z'), 0),
        runId: '2026-08-11T000000Z-550e8400-e29b-41d4-a716-446655440000',
        browserDriver: () => createFakeBrowserDriver(() => createFakeBrowserSession(new Map())),
        secrets: createFakeSecretsProvider(new Map()),
        resolveAiExecutor: async () => {
          throw new Error('The fully grounded replay must not resolve an AI executor.');
        },
        events: events.sink,
        discoverTestFiles: async () => [],
        config: {
          testDir: TEST_DIR,
          testMatch: ['**/*.test.md'],
          testIgnore: ['**/.runs/**'],
          targets: { web: { ...TARGETS.web, healReplayIsolation: 'stateful' } },
          defaultTarget: 'web',
          ai: { provider: 'codex', timeoutMs: 120_000 },
          ci: { heal: false, updateGroundingCache: false },
          grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
        },
        isCI: false,
      } satisfies RunDeps, RUN_OPTIONS);

      return { emitted: events.emitted() };
    },
  },
]);
