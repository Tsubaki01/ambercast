import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretRefUndeclaredError } from '#core/errors/secret-ref-undeclared-error.js';
import { SecretUnresolvedError } from '#core/errors/secret-unresolved-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  GroundingDocument,
  type ElementRef,
  type Fingerprint,
  type JsonValueT,
  type PlanDocument,
  type Step,
  type TraceAssert,
  type TraceEntry,
  type TraceRecord,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { AiAgenticRequest } from '#ports/ai.js';
import type { BrowserDriver, BrowserEngine, BrowserSession, PerformableAction } from '#ports/browser.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock } from '#ports/system.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { buildRunReport } from '#usecases/run-report.js';
import { OBSERVED_NOTE, RunResult } from '#report/schema.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import {
  createFakeBrowserSession,
  elementRefKey,
  type FakeBrowserSessionEntry,
} from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const MULTI_TARGETS = {
  web: { baseUrl: 'https://example.test', browser: 'chromium' },
  staging: { baseUrl: 'https://staging.example.test', browser: 'chromium' },
} as const;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(64) };
const DIFFERENT_FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'b'.repeat(64) };
const EMAIL: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Email' };
const PASSWORD: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Password' };
const SUBMIT: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const DEFAULT_OPTIONS: RunOptions = { files: [], cacheOnly: false, stale: 'fail' };

interface RecordingStorage {
  readonly storage: StorageAdapter;
  readonly reads: string[];
  readonly exists: string[];
  readonly writes: Array<{ readonly path: string; readonly text: string }>;
}

interface Scenario {
  readonly deps: RunDeps;
  readonly browserDriver: ReturnType<typeof vi.fn<(engine: BrowserEngine) => BrowserDriver>>;
  readonly events: ReturnType<typeof createRecordingEventSink>;
  readonly recordingStorage: RecordingStorage;
  readonly sessionFactory: ReturnType<typeof vi.fn<() => BrowserSession>>;
  readonly resolveAiExecutor: ReturnType<typeof vi.fn<RunDeps['resolveAiExecutor']>>;
}

function createRecordingStorage(): RecordingStorage {
  const backing = createInMemoryStorage();
  const reads: string[] = [];
  const exists: string[] = [];
  const writes: Array<{ readonly path: string; readonly text: string }> = [];

  return {
    reads,
    exists,
    writes,
    storage: {
      ...backing,
      async readText(path) {
        reads.push(path);
        return backing.readText(path);
      },
      async exists(path) {
        exists.push(path);
        return backing.exists(path);
      },
      async writeText(path, text) {
        writes.push({ path, text });
        return backing.writeText(path, text);
      },
    },
  };
}

function createScenario(overrides: Partial<RunDeps> = {}): Scenario {
  const recordingStorage = createRecordingStorage();
  const events = createRecordingEventSink();
  const sessionFactory = vi.fn<() => BrowserSession>(() => createFakeBrowserSession(new Map()));
  const driver = createFakeBrowserDriver(sessionFactory);
  const browserDriver = vi.fn<(engine: BrowserEngine) => BrowserDriver>(() => driver);
  const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => {
    throw new Error('The scenario did not permit an AI fallback.');
  });
  const deps: RunDeps = {
    storage: recordingStorage.storage,
    layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
    clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
    runId: '2026-08-09T000000Z-550e8400-e29b-41d4-a716-446655440000',
    browserDriver,
    secrets: createFakeSecretsProvider(new Map()),
    resolveAiExecutor,
    events: events.sink,
    discoverTestFiles: vi.fn(async () => ['login.test.md']),
    config: {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
      targets: TARGETS,
      defaultTarget: 'web',
    },
    ...overrides,
  };

  return { deps, browserDriver, events, recordingStorage, sessionFactory, resolveAiExecutor };
}

function elementGrounding(stepIds: readonly string[]): GroundingDocument['entries'] {
  return Object.fromEntries(stepIds.map((id) => [id, { kind: 'element', fingerprint: FINGERPRINT }])) as GroundingDocument['entries'];
}

function liveEntries(
  refs: readonly ElementRef[],
  currentFingerprint: Fingerprint = FINGERPRINT,
): Map<string, FakeBrowserSessionEntry> {
  return new Map(refs.map((ref) => [elementRefKey(ref), { exists: true, currentFingerprint }]));
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
  const normalizedTestMd = normalizeTestMd(await storage.readText(testPath));
  const inputsDigest = computeInputsDigest({
    normalizedTestMd,
    schemaVersion: 1,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    targetDefinitions,
  });
  const plan: PlanDocument = {
    schemaVersion: 1,
    source: { inputsDigest },
    targets: targetDefinitions,
    steps: [...steps],
  };
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });

  await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
  return plan;
}

async function seedFreshArtifacts(
  storage: StorageAdapter,
  testPath: string,
  steps: readonly Step[] = [],
  entries: GroundingDocument['entries'] = {},
): Promise<PlanDocument> {
  const plan = await createFreshPlan(storage, testPath, steps);
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const grounding: GroundingDocument = {
    schemaVersion: 1,
    planDigest: computePlanDigest(plan),
    entries,
  };

  await storage.writeText(layout.groundingPathFor(testPath), toCanonicalArtifactText(grounding as unknown as JsonValueT));
  return plan;
}

function trace(events: readonly TraceEntry[], verification: readonly TraceAssert[]): TraceRecord {
  return { events: [...events], verification: [...verification] };
}

function aiGrounding(traceRecord: TraceRecord): GroundingDocument['entries'] {
  return { 'recorded-ai': { kind: 'ai', trace: traceRecord } };
}

function passingText(text: string): TraceAssert {
  return { type: 'assert', check: 'text-visible', text };
}

function aiCalls(events: ReturnType<typeof createRecordingEventSink>): readonly { readonly type: 'ai-call'; readonly stepId: string }[] {
  return events.emitted().filter((event): event is { readonly type: 'ai-call'; readonly stepId: string } => event.type === 'ai-call');
}

function pathBAccessibilityTree(statusName = 'Resolution status'): JsonValueT {
  return {
    role: 'root',
    name: '',
    children: [{
      role: 'main',
      name: 'Application',
      children: [
        {
          role: 'form',
          name: 'Sign in',
          children: [
            { role: 'textbox', name: 'Email', children: [] },
            { role: 'button', name: 'Submit', children: [] },
          ],
        },
        { role: 'status', name: statusName, children: [] },
      ],
    }],
  };
}

function pathBSnapshot(statusName?: string): { readonly accessibilityTree: JsonValueT; readonly screenshot: Uint8Array } {
  return {
    accessibilityTree: pathBAccessibilityTree(statusName),
    screenshot: new Uint8Array([1, 2, 3]),
  };
}

function pathBFingerprint(tree: JsonValueT = pathBAccessibilityTree()): Fingerprint {
  const fingerprint = computeAccessibilityFingerprint(tree, SUBMIT);
  if (fingerprint === undefined) {
    throw new Error('The Path-B fixture must contain exactly one Submit button.');
  }

  return fingerprint;
}

async function readGrounding(storage: StorageAdapter, testPath: string): Promise<GroundingDocument> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  return GroundingDocument.parse(JSON.parse(await storage.readText(layout.groundingPathFor(testPath))));
}

function aiStep(
  id = 'recorded-ai',
  secrets?: Extract<Step, { kind: 'ai' }>['secrets'],
): Extract<Step, { kind: 'ai' }> {
  return {
    id,
    kind: 'ai',
    instruction: 'Complete the sign-in flow and verify the dashboard.',
    ...(secrets === undefined ? {} : { secrets: [...secrets] }),
  };
}

function expectStopgapOutcome(
  outcome: Awaited<ReturnType<typeof run>>,
  abortingStepId: string,
  skippedStepId: string,
  completedStepId?: string,
): void {
  expect(outcome.results).toHaveLength(1);
  expect(outcome.results[0]?.error).toBeUndefined();
  expect(outcome.results[0]?.result).toMatchObject({
    status: 'error',
    steps: [
      ...(completedStepId === undefined ? [] : [{ id: completedStepId, status: 'passed' }]),
      { id: abortingStepId, status: 'error', kind: 'environment' },
      { id: skippedStepId, status: 'skipped' },
    ],
  });
}

describe('run', () => {
  it('reports a missing plan as exit-4 failure before resolving a browser driver', async () => {
    const { deps, browserDriver, recordingStorage } = createScenario();
    await writePrompt(recordingStorage.storage);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(MissingPlanError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'missing-plan', exitCode: 4 });
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it.each([
    ['parseable non-canonical JSON', async (storage: StorageAdapter, testPath: string) => {
      await createFreshPlan(storage, testPath);
      const planPath = `${TEST_DIR}/login.ambercast.plan.json`;
      const canonical = await storage.readText(planPath);
      await storage.writeText(planPath, `${JSON.stringify(JSON.parse(canonical), null, 4)}\n`);
    }],
    ['unparseable JSON', async (storage: StorageAdapter) => {
      await storage.writeText(`${TEST_DIR}/login.ambercast.plan.json`, '{ malformed');
    }],
    ['schema-invalid JSON', async (storage: StorageAdapter) => {
      await storage.writeText(`${TEST_DIR}/login.ambercast.plan.json`, JSON.stringify({ schemaVersion: 1, steps: [{ id: 'missing-kind' }] }));
    }],
  ] as const)('reports %s as an integrity violation before resolving a browser driver', async (_description, arrangePlan) => {
    const { deps, browserDriver, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await arrangePlan(recordingStorage.storage, testPath);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'integrity-violation', exitCode: 4 });
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('reports a canonical plan with an old inputs digest as stale before resolving a browser driver', async () => {
    const { deps, browserDriver, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    const plan = await createFreshPlan(recordingStorage.storage, testPath);
    await recordingStorage.storage.writeText(
      `${TEST_DIR}/login.ambercast.plan.json`,
      toCanonicalArtifactText({ ...plan, source: { inputsDigest: 'f'.repeat(64) } } as unknown as JsonValueT),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(StaleIrError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'stale-ir', exitCode: 4 });
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it.each([
    [
      'fill-secret action',
      [{
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD,
        secretRef: '{{secrets.FOO}}',
      }] satisfies readonly Step[],
      'fill-password',
    ],
    [
      'AI-step secret grant',
      [aiStep('complete-sign-in', ['{{secrets.FOO}}'])] satisfies readonly Step[],
      'complete-sign-in',
    ],
  ] as const)('rejects a pre-existing ungrounded %s before launching a browser', async (_description, steps, stepId) => {
    const { deps, browserDriver, recordingStorage } = createScenario();
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(SecretRefUndeclaredError);
    if (outcome.results[0]?.error instanceof SecretRefUndeclaredError) {
      expect(outcome.results[0].error.details).toStrictEqual({ secretRef: '{{secrets.FOO}}', stepId });
    }
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('replays normally when every fill-secret and AI-step grant is declared by the prompt', async () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]));
    const browserDriver = vi.fn(() => createFakeBrowserDriver(() => session));
    const { deps, recordingStorage } = createScenario({
      browserDriver,
      secrets: createFakeSecretsProvider(new Map([[secretRef, 'resolved-at-run-time']])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
        aiStep('recorded-ai', [secretRef]),
      ],
      {
        ...elementGrounding(['fill-password']),
        ...aiGrounding(trace([], [passingText('Dashboard')])),
      },
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(browserDriver).toHaveBeenCalledTimes(1);
  });

  it('keeps a plan fresh for its default target and rejects the same plan for another configured target', async () => {
    const { deps, browserDriver, recordingStorage } = createScenario({
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: MULTI_TARGETS,
        defaultTarget: 'web',
      },
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await createFreshPlan(recordingStorage.storage, testPath, [], { web: MULTI_TARGETS.web });

    const defaultTargetOutcome = await run(deps, DEFAULT_OPTIONS);
    const overriddenTargetOutcome = await run(deps, { ...DEFAULT_OPTIONS, target: 'staging' });

    expect(defaultTargetOutcome.results[0]?.result.status).toBe('passed');
    expect(defaultTargetOutcome.results[0]?.error).toBeUndefined();
    expect(overriddenTargetOutcome.results[0]?.error).toBeInstanceOf(StaleIrError);
    expect(overriddenTargetOutcome.results[0]?.error).toMatchObject({ kind: 'stale-ir', exitCode: 4 });
    expect(browserDriver).toHaveBeenCalledTimes(1);
  });

  it('reports a source prompt read failure as a pre-dispatch filesystem error', async () => {
    const { deps, browserDriver, recordingStorage } = createScenario();
    await writePrompt(recordingStorage.storage);
    vi.spyOn(recordingStorage.storage, 'readText').mockRejectedValueOnce(new Error('prompt volume unavailable'));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(FsIoError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'fs-io-error', exitCode: 3 });
    expect(outcome.results[0]?.result).toMatchObject({ status: 'error', steps: [] });
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('resolves the target before attempting plan work that follows digest computation', async () => {
    const { deps, browserDriver, recordingStorage } = createScenario({
      config: { testDir: TEST_DIR, testMatch: ['**/*.test.md'], testIgnore: [], targets: TARGETS },
    });
    const testPath = await writePrompt(recordingStorage.storage);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, target: 'not-configured' });

    expect(outcome.results[0]?.error).toBeInstanceOf(TargetUnresolvedError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'target-unresolved', exitCode: 2 });
    expect(recordingStorage.reads).toEqual([testPath]);
    expect(recordingStorage.exists).toEqual([]);
    expect(browserDriver).not.toHaveBeenCalled();
  });

  it('replays multiple grounded steps without emitting an AI-call event', async () => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(liveEntries([SUBMIT, EMAIL]), { onClose: closed });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      { id: 'fill-email', kind: 'action', action: 'fill', target: EMAIL, value: 'person@example.test' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['click-submit', 'fill-email']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result).toMatchObject({ status: 'passed' });
    expect(events.emitted()).toEqual([
      { type: 'step-start', stepId: 'click-submit' },
      { type: 'step-result', stepId: 'click-submit', via: 'grounding' },
      { type: 'step-start', stepId: 'fill-email' },
      { type: 'step-result', stepId: 'fill-email', via: 'grounding' },
    ]);
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('materializes every action variant through BrowserSession.perform', async () => {
    const performed: PerformableAction[] = [];
    const session = createFakeBrowserSession(liveEntries([SUBMIT, EMAIL, PASSWORD]), {
      onPerform(action) {
        performed.push(action);
      },
    });
    const secretRef = '{{secrets.auth.password}}';
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, 'not-in-the-plan']])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    const steps: Step[] = [
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      { id: 'open-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' },
      { id: 'press-enter', kind: 'action', action: 'press', target: EMAIL, key: 'Enter' },
      { id: 'fill-email', kind: 'action', action: 'fill', target: EMAIL, value: 'person@example.test' },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
    ];
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      steps,
      elementGrounding(['click-submit', 'press-enter', 'fill-email', 'fill-password']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(performed).toEqual([
      { type: 'click', target: SUBMIT },
      { type: 'navigate', url: '/dashboard' },
      { type: 'press', target: EMAIL, key: 'Enter' },
      { type: 'fill', target: EMAIL, value: 'person@example.test' },
      { type: 'fill-secret', target: PASSWORD, value: 'not-in-the-plan' },
    ]);
  });

  it('rejects a cross-origin deterministic navigate before it reaches the browser', async () => {
    const session = createFakeBrowserSession(new Map());
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'leave-target', kind: 'action', action: 'navigate', url: 'https://evil.test/phish' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
  });

  it('rejects a same-origin-looking blob: deterministic navigate before it reaches the browser', async () => {
    const session = createFakeBrowserSession(new Map());
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'leave-target', kind: 'action', action: 'navigate', url: 'blob:https://example.test/guard-test' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const error = outcome.results[0]?.error;

    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(error?.message).toBe('A navigation URL must use the replay target\'s HTTP(S) scheme.');
    expect(session.operations()).toEqual([]);
  });

  it('allows same-origin absolute and relative deterministic navigate URLs', async () => {
    const session = createFakeBrowserSession(new Map());
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'open-same-origin', kind: 'action', action: 'navigate', url: 'https://example.test/ok' },
      { id: 'open-relative', kind: 'action', action: 'navigate', url: '/relative' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'navigate', url: 'https://example.test/ok' } },
      { type: 'perform', action: { type: 'navigate', url: '/relative' } },
    ]);
  });

  it('classifies an unresolvable deterministic navigate URL as an integrity violation', async () => {
    const session = createFakeBrowserSession(new Map());
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'open-malformed', kind: 'action', action: 'navigate', url: 'https://[::1' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
  });

  it('does not retain a captured hostname in a rejected deterministic navigate result', async () => {
    const capturedHost = 'SENTINEL-HOST';
    const session = createFakeBrowserSession(liveEntries([EMAIL]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: capturedHost, value: 'unused' }]]),
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'capture-host', kind: 'capture', target: EMAIL, variable: 'captured' },
        { id: 'leave-target', kind: 'action', action: 'navigate', url: 'https://{{run.captured}}.evil.test' },
      ],
      elementGrounding(['capture-host']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const serializedResult = JSON.stringify(outcome.results[0]);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(serializedResult).not.toContain(capturedHost);
    expect(serializedResult).not.toContain(capturedHost.toLowerCase());
  });

  it('captures text and interpolates it in the middle of a later action value', async () => {
    const performed: PerformableAction[] = [];
    const session = createFakeBrowserSession(liveEntries([EMAIL, SUBMIT]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: 'Ari', value: 'wrong-mode' }]]),
      onPerform(action) {
        performed.push(action);
      },
    });
    const captureValue = vi.spyOn(session, 'captureValue');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'capture-name', kind: 'capture', target: EMAIL, variable: 'name' },
      { id: 'fill-greeting', kind: 'action', action: 'fill', target: SUBMIT, value: 'Hello, {{run.name}}!' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['capture-name', 'fill-greeting']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(captureValue).toHaveBeenCalledWith(EMAIL, 'text');
    expect(performed).toEqual([{ type: 'fill', target: SUBMIT, value: 'Hello, Ari!' }]);
  });

  it.each([
    ['an uncaptured single-segment reference', 'before {{run.missing}} after'],
    ['a multi-segment reference', 'before {{run.profile.name}} after'],
  ] as const)('aborts %s before consulting grounding and closes the session', async (_description, value) => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(liveEntries([EMAIL]), { onClose: closed });
    const resolveGrounded = vi.spyOn(session, 'resolveGrounded');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'before-reference', kind: 'action', action: 'navigate', url: '/before' },
      { id: 'fill-reference', kind: 'action', action: 'fill', target: EMAIL, value },
      { id: 'after-reference', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['fill-reference']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expectStopgapOutcome(outcome, 'fill-reference', 'after-reference', 'before-reference');
    expect(resolveGrounded).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('resolves a fill-secret immediately before perform without exposing the secret to the plan', async () => {
    const calls: string[] = [];
    const secretRef = '{{secrets.auth.password}}';
    const secrets = createFakeSecretsProvider(new Map([[secretRef, 'resolved-at-run-time']]));
    const resolve = vi.spyOn(secrets, 'resolve').mockImplementation((ref) => {
      calls.push(`secret:${ref}`);
      return 'resolved-at-run-time';
    });
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform() {
        calls.push('perform');
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    const steps: Step[] = [{ id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef }];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['fill-password']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolve).toHaveBeenCalledWith(secretRef);
    expect(calls).toEqual([`secret:${secretRef}`, 'perform']);
  });

  it('fails closed for an unresolved fill-secret without calling perform and closes the session', async () => {
    const closed = vi.fn();
    const perform = vi.fn();
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), { onPerform: perform, onClose: closed });
    const secretRef = '{{secrets.auth.password}}';
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map()),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    const steps: Step[] = [
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'after-password', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['fill-password']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(SecretUnresolvedError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'secret-unresolved', exitCode: 2 });
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      steps: [
        { id: 'fill-password', status: 'error', kind: 'environment' },
        { id: 'after-password', status: 'skipped' },
      ],
    });
    expect(perform).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('records an assertion failure as results-only evidence and skips later steps', async () => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(liveEntries([SUBMIT]), {
      assertOutcome: { passed: false, message: 'Submit was not visible.' },
      onClose: closed,
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'assert-submit', kind: 'assert', check: 'element-visible', target: SUBMIT },
      { id: 'after-assertion', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['assert-submit']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    // error-code-correspondence.test.ts owns the invariant that assertion-failed
    // is never serialized through reportError(); replay therefore retains no
    // classified error for this result-only failure.
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'failed',
      steps: [
        { id: 'assert-submit', type: 'assert', status: 'failed', kind: 'assertion' },
        { id: 'after-assertion', status: 'skipped' },
      ],
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('aborts a browser-launch failure before any step has execution evidence', async () => {
    const sessionFactory = vi.fn<() => BrowserSession>(() => createFakeBrowserSession(new Map()));
    const driver = createFakeBrowserDriver(sessionFactory);
    const launch = vi.spyOn(driver, 'launch').mockRejectedValue(new BrowserLaunchFailedError('Chromium could not launch.'));
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => driver),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'open-home', kind: 'action', action: 'navigate', url: '/' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(BrowserLaunchFailedError);
    expect(outcome.results[0]?.result).toMatchObject({ status: 'error', steps: [] });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it('uses the unclassified case-abort stopgap for a cold AI step in cache-only mode and closes the session', async () => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(new Map(), { onClose: closed });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'before-ai', kind: 'action', action: 'navigate', url: '/before' },
      { id: 'recorded-ai', kind: 'ai', instruction: 'Open the account settings.' },
      { id: 'after-ai', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expectStopgapOutcome(outcome, 'recorded-ai', 'after-ai', 'before-ai');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an absent grounding entry', {} as GroundingDocument['entries'], new Map<string, FakeBrowserSessionEntry>(), false],
    ['an element-not-found grounding miss', elementGrounding(['click-submit']), new Map<string, FakeBrowserSessionEntry>(), true],
    ['a fingerprint-mismatch grounding miss', elementGrounding(['click-submit']), liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), true],
  ] as const)('uses the unclassified case-abort stopgap for %s in cache-only mode and closes the session', async (_description, entries, live, resolvesGrounding) => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(live, { onClose: closed });
    const resolveGrounded = vi.spyOn(session, 'resolveGrounded');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'before-grounding', kind: 'action', action: 'navigate', url: '/before' },
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      { id: 'after-grounding', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, entries);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expectStopgapOutcome(outcome, 'click-submit', 'after-grounding', 'before-grounding');
    if (resolvesGrounding) {
      expect(resolveGrounded).toHaveBeenCalledWith(SUBMIT, FINGERPRINT);
    } else {
      expect(resolveGrounded).not.toHaveBeenCalled();
    }
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no grounding file', async (storage: StorageAdapter, testPath: string, steps: readonly Step[]) => {
      await createFreshPlan(storage, testPath, steps);
    }],
    ['malformed grounding JSON', async (storage: StorageAdapter, testPath: string, steps: readonly Step[]) => {
      await seedFreshArtifacts(storage, testPath, steps, elementGrounding(['click-submit']));
      await storage.writeText(`${TEST_DIR}/login.ambercast.grounding.json`, '{ malformed');
    }],
    ['a grounding document with a stale plan digest', async (storage: StorageAdapter, testPath: string, steps: readonly Step[]) => {
      await seedFreshArtifacts(storage, testPath, steps, elementGrounding(['click-submit']));
      await storage.writeText(
        `${TEST_DIR}/login.ambercast.grounding.json`,
        toCanonicalArtifactText({
          schemaVersion: 1,
          planDigest: 'f'.repeat(64),
          entries: elementGrounding(['click-submit']),
        } as unknown as JsonValueT),
      );
    }],
  ] as const)('degrades %s to the cache-only grounding-miss case-abort stopgap', async (_description, arrangeGrounding) => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(liveEntries([SUBMIT]), { onClose: closed });
    const resolveGrounded = vi.spyOn(session, 'resolveGrounded');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'before-grounding', kind: 'action', action: 'navigate', url: '/before' },
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      { id: 'after-grounding', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await arrangeGrounding(recordingStorage.storage, testPath, steps);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expectStopgapOutcome(outcome, 'click-submit', 'after-grounding', 'before-grounding');
    expect(resolveGrounded).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('uses the unclassified case-abort stopgap for an unclassified browser-session error and closes the session', async () => {
    const closed = vi.fn();
    const session = createFakeBrowserSession(liveEntries([SUBMIT]), {
      onPerform(action) {
        if (action.type === 'click') {
          throw new Error('detached element');
        }
      },
      onClose: closed,
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const steps: Step[] = [
      { id: 'before-browser-error', kind: 'action', action: 'navigate', url: '/before' },
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      { id: 'after-browser-error', kind: 'action', action: 'navigate', url: '/after' },
    ];
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, elementGrounding(['click-submit']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expectStopgapOutcome(outcome, 'click-submit', 'after-browser-error', 'before-browser-error');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('continues a sibling case after a browser-launch failure', async () => {
    const firstDriver = createFakeBrowserDriver(() => createFakeBrowserSession(new Map()));
    vi.spyOn(firstDriver, 'launch').mockRejectedValue(new BrowserLaunchFailedError('first case cannot launch'));
    const secondClosed = vi.fn();
    const secondDriver = createFakeBrowserDriver(() => createFakeBrowserSession(new Map(), { onClose: secondClosed }));
    const drivers = [firstDriver, secondDriver];
    const browserDriver = vi.fn<(engine: BrowserEngine) => BrowserDriver>(() => drivers.shift()!);
    const { deps, recordingStorage } = createScenario({
      browserDriver,
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
    });
    const firstPath = await writePrompt(recordingStorage.storage, 'first.test.md');
    const secondPath = await writePrompt(recordingStorage.storage, 'second.test.md');
    await seedFreshArtifacts(recordingStorage.storage, firstPath, [{ id: 'open-first', kind: 'action', action: 'navigate', url: '/first' }]);
    await seedFreshArtifacts(recordingStorage.storage, secondPath, [{ id: 'open-second', kind: 'action', action: 'navigate', url: '/second' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.map(({ result }) => result.status)).toEqual(['error', 'passed']);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'browser-launch-failed' });
    expect(secondClosed).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling later cases after caller cancellation while retaining a completed case', async () => {
    const controller = new AbortController();
    const firstClosed = vi.fn(() => controller.abort(new Error('stop after first case')));
    const sessionFactory = vi.fn<() => BrowserSession>(() => createFakeBrowserSession(new Map(), { onClose: firstClosed }));
    const { deps, recordingStorage, sessionFactory: defaultFactory } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(sessionFactory)),
      discoverTestFiles: async () => ['first.test.md', 'second.test.md'],
      signal: controller.signal,
    });
    const firstPath = await writePrompt(recordingStorage.storage, 'first.test.md');
    const secondPath = await writePrompt(recordingStorage.storage, 'second.test.md');
    await seedFreshArtifacts(recordingStorage.storage, firstPath, [{ id: 'open-first', kind: 'action', action: 'navigate', url: '/first' }]);
    await seedFreshArtifacts(recordingStorage.storage, secondPath, [{ id: 'open-second', kind: 'action', action: 'navigate', url: '/second' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.result).toMatchObject({ file: firstPath, status: 'passed' });
    expect(firstClosed).toHaveBeenCalledTimes(1);
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(defaultFactory).not.toHaveBeenCalled();
  });

  it('measures one case with the injected monotonic clock', async () => {
    const fixed = createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 100);
    const monotonicMs = vi.fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(137);
    const clock: Clock = { ...fixed, monotonicMs };
    const { deps, recordingStorage } = createScenario({
      clock,
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map()))),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'open-home', kind: 'action', action: 'navigate', url: '/' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(monotonicMs).toHaveBeenCalledTimes(2);
    expect(outcome.results[0]?.result.durationMs).toBe(37);
  });

  it('applies grep to discovered POSIX-relative paths before reading an excluded prompt', async () => {
    const { deps, recordingStorage } = createScenario({
      discoverTestFiles: async () => ['matching/login.test.md', 'other/skip.test.md'],
    });
    const matchingPath = await writePrompt(recordingStorage.storage, 'matching/login.test.md');
    await seedFreshArtifacts(recordingStorage.storage, matchingPath, [{ id: 'open-login', kind: 'action', action: 'navigate', url: '/' }]);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, grep: /^matching\// });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.result).toMatchObject({ file: matchingPath, status: 'passed' });
    expect(recordingStorage.reads).not.toContain(`${TEST_DIR}/other/skip.test.md`);
  });

  it('applies grep to literal paths in their POSIX-relative form', async () => {
    const { deps, recordingStorage } = createScenario();
    const matchingPath = await writePrompt(recordingStorage.storage, 'matching/login.test.md');
    const excludedPath = await writePrompt(recordingStorage.storage, 'other/skip.test.md');
    await seedFreshArtifacts(recordingStorage.storage, matchingPath, [{ id: 'open-login', kind: 'action', action: 'navigate', url: '/' }]);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, files: [matchingPath, excludedPath], grep: /^matching\// });

    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.result).toMatchObject({ file: matchingPath, status: 'passed' });
    expect(recordingStorage.reads).not.toContain(excludedPath);
  });

  it('reports no tests found when discovery resolves no prompt files', async () => {
    const { deps } = createScenario({ discoverTestFiles: async () => [] });

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.noTestsFound).toBe(true);
    expect(outcome.results).toEqual([]);
  });
});

describe('run agentic fallback pipeline', () => {
  it('records one cold-start AI call, persists its unresolved trace, then replays it without an AI call or write', async () => {
    const firstSession = createFakeBrowserSession(new Map());
    const secondSession = createFakeBrowserSession(new Map());
    const sessions = [firstSession, secondSession];
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/dashboard' });
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => sessions.shift()!)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    recordingStorage.writes.length = 0;

    const coldStart = await run(deps, DEFAULT_OPTIONS);

    const expectedTrace = trace(
      [{ type: 'navigate', url: '/dashboard' }],
      [passingText('Dashboard')],
    );
    expect(coldStart.results[0]?.result).toMatchObject({ status: 'passed' });
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'recorded-ai' }]);
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(executor.agenticRequests[0]).toMatchObject({
      allowedSecretRefs: [],
      allowedRunRefs: [],
    });
    expect(executor.agenticRequests[0]).not.toHaveProperty('priorTrace');
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({
      'recorded-ai': { kind: 'ai', trace: expectedTrace },
    });
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      { type: 'step-result', stepId: 'recorded-ai', via: 'ai-resolve' },
    ]);

    const callsBeforeReplay = aiCalls(events).length;
    const writesBeforeReplay = recordingStorage.writes.length;
    const groundingBeforeReplay = await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`);
    const replay = await run(deps, DEFAULT_OPTIONS);

    expect(replay.results[0]?.result).toMatchObject({ status: 'passed' });
    expect(aiCalls(events).slice(callsBeforeReplay)).toEqual([]);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(recordingStorage.writes.slice(writesBeforeReplay)).toEqual([]);
    expect(await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`)).toBe(groundingBeforeReplay);
    expect(secondSession.operations()).toEqual([
      { type: 'perform', action: { type: 'navigate', url: '/dashboard' } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
    expect(events.emitted().filter((event) => event.type === 'step-result').at(-1)).toEqual({
      type: 'step-result',
      stepId: 'recorded-ai',
      via: 'trace-replay',
    });
  });

  it('replays TraceFill run references with each run\'s freshly captured value without mutating grounding', async () => {
    const firstSession = createFakeBrowserSession(liveEntries([EMAIL]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: 'TOKEN-A', value: 'unused' }]]),
    });
    const secondSession = createFakeBrowserSession(liveEntries([EMAIL]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: 'TOKEN-B', value: 'unused' }]]),
    });
    const sessions = [firstSession, secondSession];
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => sessions.shift()!)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
        aiStep(),
      ],
      {
        ...elementGrounding(['capture-token']),
        ...aiGrounding(trace(
          [{ type: 'fill', target: EMAIL, value: 'token: {{run.token}}' }],
          [passingText('Dashboard')],
        )),
      },
    );

    const firstRun = await run(deps, DEFAULT_OPTIONS);
    const writesBeforeSecondRun = recordingStorage.writes.length;
    const groundingBeforeSecondRun = await recordingStorage.storage.readText(
      `${TEST_DIR}/login.ambercast.grounding.json`,
    );
    const secondRun = await run(deps, DEFAULT_OPTIONS);

    expect(firstRun.results[0]?.result.status).toBe('passed');
    expect(secondRun.results[0]?.result.status).toBe('passed');
    expect(firstSession.operations()).toContainEqual({
      type: 'perform',
      action: { type: 'fill', target: EMAIL, value: 'token: TOKEN-A' },
    });
    expect(secondSession.operations()).toContainEqual({
      type: 'perform',
      action: { type: 'fill', target: EMAIL, value: 'token: TOKEN-B' },
    });
    expect(recordingStorage.writes.slice(writesBeforeSecondRun)).toEqual([]);
    expect(await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`)).toBe(
      groundingBeforeSecondRun,
    );
  });

  it('rejects a cross-origin fresh agentic navigate before it reaches the browser', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: 'https://evil.test/phish' });
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
  });

  it('uses exactly one agentic fallback for a behavioral trace miss and passes the unresolved prior trace', async () => {
    const priorTrace = trace(
      [{ type: 'navigate', url: '/cached-route' }],
      [passingText('Cached dashboard')],
    );
    const session = createFakeBrowserSession(new Map(), { assertOutcomes: [
      { passed: false, message: 'The cached dashboard is absent.' },
      { passed: true, message: 'The refreshed dashboard is visible.' },
    ] });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'press', target: SUBMIT, key: 'Enter' });
        await request.controller.evaluateAssert(passingText('Refreshed dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(priorTrace));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result).toMatchObject({ status: 'passed' });
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'recorded-ai' }]);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(executor.agenticRequests[0]?.priorTrace).toEqual(priorTrace);
    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'navigate', url: '/cached-route' } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Cached dashboard' } },
      { type: 'perform', action: { type: 'press', target: SUBMIT, key: 'Enter' } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Refreshed dashboard' } },
    ]);
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      { type: 'step-result', stepId: 'recorded-ai', via: 'ai-resolve' },
    ]);
  });

  it.each([
    ['a rejected cached action', (session: ReturnType<typeof createFakeBrowserSession>) => {
      let calls = 0;
      vi.spyOn(session, 'perform').mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('cached target detached');
        }
      });
    }],
    ['a false cached assertion', () => undefined],
    ['a non-integrity cached assertion rejection', (session: ReturnType<typeof createFakeBrowserSession>) => {
      vi.spyOn(session, 'evaluateAssert').mockRejectedValueOnce(new Error('browser evaluation failed'));
    }],
  ] as const)('treats %s as a behavioral path-C miss rather than an integrity failure', async (_description, arrange) => {
    const priorTrace = trace([{ type: 'navigate', url: '/cached' }], [passingText('Cached')]);
    const session = createFakeBrowserSession(new Map(), { assertOutcomes: [
      { passed: false, message: 'Cached assertion failed.' },
      { passed: true },
    ] });
    arrange(session);
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(passingText('Recovered'));
        return { outcome: 'success' };
      },
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(priorTrace));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'recorded-ai' }]);
    expect(executor.agenticRequests[0]?.priorTrace).toEqual(priorTrace);
  });

  it('stops a cancelled trace replay before resolving an agentic fallback', async () => {
    const abortController = new AbortController();
    const abortReason = new Error('Stop trace replay.');
    const session = createFakeBrowserSession(new Map(), {
      onPerform() {
        abortController.abort(abortReason);
        throw abortReason;
      },
    });
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
      signal: abortController.signal,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep()],
      aiGrounding(trace([{ type: 'navigate', url: '/cached' }], [passingText('Cached')])),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      steps: [{ id: 'recorded-ai', status: 'error', kind: 'environment' }],
    });
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
  });

  it('suppresses a behavioral trace fallback in cache-only mode without resolving an AI executor', async () => {
    const session = createFakeBrowserSession(new Map(), {
      assertOutcome: { passed: false, message: 'The cached page changed.' },
    });
    const { deps, events, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep()],
      aiGrounding(trace([], [passingText('Cached dashboard')])),
    );

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      steps: [{ id: 'recorded-ai', status: 'error', kind: 'environment' }],
    });
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
    expect(session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Cached dashboard' } },
    ]);
  });
});

describe('run path-B element recovery', () => {
  it('keeps a fingerprint hit deterministic and never resolves an AI executor', async () => {
    const session = createFakeBrowserSession(liveEntries([SUBMIT]));
    const { deps, events, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );
    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      { type: 'step-result', stepId: 'click-submit', via: 'grounding' },
    ]);
  });

  it('re-resolves an element miss with exactly one AI call, persists the fresh fingerprint, and marks the result ai-resolve', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_VALUE';
    const expectedFingerprint = pathBFingerprint();
    const snapshot = pathBSnapshot(`The password field contains ${secretValue}.`);
    const session = createFakeBrowserSession(new Map([
      [elementRefKey(PASSWORD), { exists: true, currentFingerprint: FINGERPRINT }],
      [elementRefKey(SUBMIT), { exists: true, currentFingerprint: DIFFERENT_FINGERPRINT }],
    ]), { snapshot });
    const executor = createFakeAiExecutor({
      execute: () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'fill-password-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
        { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      ],
      elementGrounding(['fill-password-secret', 'click-submit']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'click-submit' }]);
    expect(executor.structuredRequests).toHaveLength(1);
    const requestContext = executor.structuredRequests[0]?.context as {
      readonly target: ElementRef;
      readonly snapshot: { readonly accessibilityTree: JsonValueT };
    };
    expect(requestContext.target).toStrictEqual(SUBMIT);
    expect(requestContext.snapshot).toStrictEqual({
      accessibilityTree: pathBAccessibilityTree(`The password field contains ${secretRef}.`),
    });
    expect(executor.structuredRequests[0]?.prompt).toBe(
      'Confirm whether the supplied locator still identifies the intended element.',
    );
    const responseSchema = executor.structuredRequests[0]?.responseSchema as unknown as {
      readonly additionalProperties: boolean;
      readonly properties: Readonly<Record<string, { readonly type: string }>>;
      readonly required: readonly string[];
    };
    expect(responseSchema).toMatchObject({
      additionalProperties: false,
      properties: { confirmed: { type: 'boolean' } },
      required: ['confirmed'],
    });
    expect(responseSchema.properties).toStrictEqual({ confirmed: { type: 'boolean' } });
    expect(JSON.stringify(executor.structuredRequests[0]?.responseSchema)).not.toContain('fingerprint');
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({
      'fill-password-secret': { kind: 'element', fingerprint: FINGERPRINT },
      'click-submit': { kind: 'element', fingerprint: expectedFingerprint },
    });
    expect(session.operations()).toEqual([
      { type: 'resolve-grounded', target: PASSWORD, fingerprint: FINGERPRINT },
      { type: 'perform', action: { type: 'fill-secret', target: PASSWORD, value: secretValue } },
      { type: 'resolve-grounded', target: SUBMIT, fingerprint: FINGERPRINT },
      { type: 'snapshot-for-resolution' },
      { type: 'perform', action: { type: 'click', target: SUBMIT } },
    ]);
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      { type: 'step-result', stepId: 'fill-password-secret', via: 'grounding' },
      { type: 'step-result', stepId: 'click-submit', via: 'ai-resolve' },
    ]);
  });

  it('flushes a refreshed fingerprint even when the original action subsequently fails', async () => {
    const expectedFingerprint = pathBFingerprint();
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), {
      snapshot: pathBSnapshot(),
      onPerform() {
        throw new Error('The refreshed target detached before click.');
      },
    });
    const executor = createFakeAiExecutor({
      execute: () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'click-submit' }]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({
      'click-submit': { kind: 'element', fingerprint: expectedFingerprint },
    });
  });

  it.each([
    ['a schema-invalid re-resolution response', 'The AI response did not match the confirmation schema.'],
    ['an AI refusal to confirm the authored locator', 'The AI cannot confirm the locator on this page.'],
  ] as const)('fails closed for %s without performing or replacing the previous fingerprint', async (_description, message) => {
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), { snapshot: pathBSnapshot() });
    const executor = createFakeAiExecutor({
      execute: () => {
        throw new AiResponseInvalidError(message, { raw: '{"status":"unconfirmed"}', issues: [] });
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(AiResponseInvalidError);
    expect(session.operations()).toEqual([
      { type: 'resolve-grounded', target: SUBMIT, fingerprint: FINGERPRINT },
      { type: 'snapshot-for-resolution' },
    ]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(elementGrounding(['click-submit']));
  });

  it('computes, confirms, and persists on a genuine cold start without resolving stored grounding', async () => {
    const expectedFingerprint = pathBFingerprint();
    const session = createFakeBrowserSession(new Map(), { snapshot: pathBSnapshot() });
    const resolveGrounded = vi.spyOn(session, 'resolveGrounded');
    const executor = createFakeAiExecutor({
      execute: () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveGrounded).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'click-submit' }]);
    expect(executor.structuredRequests).toHaveLength(1);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({
      'click-submit': { kind: 'element', fingerprint: expectedFingerprint },
    });
  });

  it.each([
    ['an absent target', {
      role: 'root', name: '', children: [{ role: 'main', name: 'Application', children: [] }],
    }, 'The supplied locator has no matching element in the current accessibility evidence.'],
    ['ambiguous targets', {
      role: 'root', name: '', children: [{
        role: 'form', name: 'Sign in', children: [
          { role: 'button', name: 'Submit', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    }, 'The supplied locator matches more than one element in the current accessibility evidence and cannot be trusted.'],
  ])('does not call AI before failing closed for %s in captured evidence', async (_description, accessibilityTree, explanation) => {
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), {
      snapshot: { accessibilityTree, screenshot: new Uint8Array() },
    });
    const executor = createFakeAiExecutor();
    const { deps, events, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
        { id: 'after-click', kind: 'action', action: 'navigate', url: '/after' },
      ],
      elementGrounding(['click-submit']),
    );
    const groundingBefore = await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expectStopgapOutcome(outcome, 'click-submit', 'after-click');
    expect(outcome.results[0]?.result.explanation).toBe(explanation);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.structuredRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
    expect(recordingStorage.writes).toEqual([]);
    expect(await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`)).toBe(groundingBefore);
    expect(session.operations()).toEqual([
      { type: 'resolve-grounded', target: SUBMIT, fingerprint: FINGERPRINT },
      { type: 'snapshot-for-resolution' },
    ]);
  });

  it('honors a confirmation denial and persists no locally recomputed fingerprint', async () => {
    const locallyComputedFingerprint = pathBFingerprint();
    expect(locallyComputedFingerprint).toMatchObject({ algorithm: 'a11y-neighborhood-v1' });
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), { snapshot: pathBSnapshot() });
    const executor = createFakeAiExecutor({
      execute: () => ({ data: { confirmed: false }, raw: '{"confirmed":false}' }),
    });
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );
    const groundingBefore = await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(outcome.results[0]?.result.explanation).toBe('The AI could not confirm that the supplied locator identifies the intended element.');
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(executor.structuredRequests).toHaveLength(1);
    expect(aiCalls(events)).toEqual([{ type: 'ai-call', stepId: 'click-submit' }]);
    expect(recordingStorage.writes).toEqual([]);
    expect(await recordingStorage.storage.readText(`${TEST_DIR}/login.ambercast.grounding.json`)).toBe(groundingBefore);
    expect(session.operations().filter((operation) => operation.type === 'perform')).toEqual([]);
  });

  it('persists the unredacted neighborhood fingerprint when a secret appears in the target parent', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_VALUE';
    const rawTree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: `Sign in ${secretValue}`,
        children: [
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };
    const redactedTree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: `Sign in ${secretRef}`,
        children: [
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };
    const rawFingerprint = pathBFingerprint(rawTree);
    const redactedFingerprint = pathBFingerprint(redactedTree);
    expect(rawFingerprint).not.toEqual(redactedFingerprint);
    const session = createFakeBrowserSession(new Map([
      [elementRefKey(PASSWORD), { exists: true, currentFingerprint: FINGERPRINT }],
      [elementRefKey(SUBMIT), { exists: true, currentFingerprint: DIFFERENT_FINGERPRINT }],
    ]), {
      snapshot: { accessibilityTree: rawTree, screenshot: new Uint8Array() },
    });
    const executor = createFakeAiExecutor({
      execute: () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'fill-password-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
        { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
      ],
      elementGrounding(['fill-password-secret', 'click-submit']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect((executor.structuredRequests[0]?.context as {
      readonly snapshot: { readonly accessibilityTree: JsonValueT };
    }).snapshot.accessibilityTree).toStrictEqual(redactedTree);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries['click-submit']).toEqual({
      kind: 'element',
      fingerprint: rawFingerprint,
    });
  });

  it('fails closed under cache-only for a well-formed legacy-shaped fingerprint', async () => {
    const correctedFingerprint = pathBFingerprint();
    const session = createFakeBrowserSession(liveEntries([SUBMIT], correctedFingerprint));
    const { deps, events, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      { 'click-submit': { kind: 'element', fingerprint: FINGERPRINT } },
    );

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
    expect(session.operations()).toEqual([
      { type: 'resolve-grounded', target: SUBMIT, fingerprint: FINGERPRINT },
    ]);
  });

  it('leaves the prior fingerprint untouched when the path-B snapshot fails before any AI request', async () => {
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT));
    vi.spyOn(session, 'snapshotForResolution').mockRejectedValueOnce(new Error('The browser could not capture evidence.'));
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.structuredRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(elementGrounding(['click-submit']));
  });

  it('suppresses an element-miss fallback in cache-only mode with exactly zero AI calls', async () => {
    const session = createFakeBrowserSession(new Map());
    const { deps, events, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
    );

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, cacheOnly: true });

    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result.status).toBe('error');
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
    expect(session.operations()).toEqual([]);
  });
});

describe('run path-C pre-scan', () => {
  it.each([
    [
      'an ungranted secret reference in events after a valid action',
      trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.other.password}}' },
        ],
        [passingText('Verified')],
      ),
    ],
    [
      'an ungranted run reference in events after a valid action',
      trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'navigate', url: '/users/{{run.ungranted}}' },
        ],
        [passingText('Verified')],
      ),
    ],
    [
      'a malformed run reference in events after a valid action',
      trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'navigate', url: '/users/{{run.unclosed' },
        ],
        [passingText('Verified')],
      ),
    ],
    [
      'an ungranted run reference in verification after a valid assertion',
      trace(
        [{ type: 'navigate', url: '/valid-first' }],
        [passingText('Verified'), passingText('User {{run.ungranted}}')],
      ),
    ],
    [
      'a malformed run reference in verification after a valid assertion',
      trace(
        [{ type: 'navigate', url: '/valid-first' }],
        [passingText('Verified'), passingText('User {{run.unclosed')],
      ),
    ],
  ] as const)('rejects %s before any browser or executor operation', async (_description, priorTrace) => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(priorTrace));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.agenticRequests).toEqual([]);
    expect(executor.structuredRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
  });

  it('rejects a cross-origin trace navigate before an earlier same-origin action can run', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep()],
      aiGrounding(trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'navigate', url: 'https://evil.test/phish' },
        ],
        [passingText('Verified')],
      )),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
  });

  it('rejects a same-origin-looking blob: trace navigate before any browser action can run', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep()],
      aiGrounding(trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'navigate', url: 'blob:https://example.test/guard-test' },
        ],
        [passingText('Verified')],
      )),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const error = outcome.results[0]?.error;

    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(error?.message).toBe('A navigation URL must use the replay target\'s HTTP(S) scheme.');
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
  });

  it('rejects an opaque-origin trace navigate before any browser action can run', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep()],
      aiGrounding(trace(
        [
          { type: 'navigate', url: '/valid-first' },
          { type: 'navigate', url: 'data:text/html,opaque-origin' },
        ],
        [passingText('Verified')],
      )),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const error = outcome.results[0]?.error;

    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(error?.message).toBe('A navigation URL must use the replay target\'s HTTP(S) scheme.');
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
  });

  it('rejects an ungranted run reference in a trace before a later capture could grant it', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    const priorTrace = trace(
      [{ type: 'navigate', url: '/valid-first' }, { type: 'navigate', url: '/users/{{run.later}}' }],
      [passingText('Verified')],
    );
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      aiStep(),
      { id: 'capture-later', kind: 'capture', target: EMAIL, variable: 'later' },
    ], aiGrounding(priorTrace));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(aiCalls(events)).toEqual([]);
  });

  it('treats an allowed but unresolved secret during replay as an integrity failure without agentic fallback', async () => {
    const secretRef = '{{secrets.auth.required}}';
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
      secrets: createFakeSecretsProvider(new Map()),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep('recorded-ai', [secretRef])],
      aiGrounding(trace([{ type: 'fill-secret', target: PASSWORD, secretRef }], [passingText('Verified')])),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toMatchObject({ kind: 'secret-unresolved' });
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.agenticRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
  });

  it.each([
    ['navigate URL before fill-secret', (secretRef: string, secretValue: string) => trace(
      [
        { type: 'navigate', url: `/account/${secretValue}/settings` },
        { type: 'fill-secret', target: PASSWORD, secretRef },
      ],
      [passingText('Dashboard')],
    )],
    ['navigate URL', (secretRef: string, secretValue: string) => trace(
      [
        { type: 'fill-secret', target: PASSWORD, secretRef },
        { type: 'navigate', url: `/account/${secretValue}/settings` },
      ],
      [passingText('Dashboard')],
    )],
    ['fill value', (secretRef: string, secretValue: string) => trace(
      [
        { type: 'fill-secret', target: PASSWORD, secretRef },
        { type: 'fill', target: EMAIL, value: `token=${secretValue}` },
      ],
      [passingText('Dashboard')],
    )],
    ['assertion text', (secretRef: string, secretValue: string) => trace(
      [{ type: 'fill-secret', target: PASSWORD, secretRef }],
      [{ type: 'assert', check: 'text-visible', text: `Welcome ${secretValue}.` }],
    )],
    ['assertion text equals', (secretRef: string, secretValue: string) => trace(
      [{ type: 'fill-secret', target: PASSWORD, secretRef }],
      [{ type: 'assert', check: 'text-equals', target: PASSWORD, text: `Welcome ${secretValue}.` }],
    )],
    ['assertion URL pattern', (secretRef: string, secretValue: string) => trace(
      [{ type: 'fill-secret', target: PASSWORD, secretRef }],
      [{ type: 'assert', check: 'url-matches', pattern: `/account/${secretValue}/.*` }],
    )],
  ] as const)('rejects a materialized secret literal in a prior trace %s before replay begins', async (_description, buildTrace) => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
    const secretValue = 'sk-AMBERCAST_SECRET_DUMMY';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]));
    const executor = createFakeAiExecutor();
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep('recorded-ai', [secretRef])],
      aiGrounding(buildTrace(secretRef, secretValue)),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.agenticRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
  });

  it('rejects an unsafe trace before a replay miss could hand it to an AI adapter as priorTrace', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
    const secretValue = 'sk-AMBERCAST_SECRET_DUMMY';
    const priorTrace = trace(
      [
        { type: 'fill-secret', target: PASSWORD, secretRef },
        { type: 'navigate', url: `/account/${secretValue}/settings` },
      ],
      [passingText('Cached dashboard')],
    );
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcomes: [{ passed: false, message: 'Cached dashboard changed.' }, { passed: true }],
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(passingText('Fresh dashboard'));
        return { outcome: 'success' };
      },
    });
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [aiStep('recorded-ai', [secretRef])],
      aiGrounding(priorTrace),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(session.operations()).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(executor.agenticRequests).toEqual([]);
    expect(aiCalls(events)).toEqual([]);
  });
});

describe('run agentic wrapper state machine', () => {
  it('writes a trace with a single trailing passed assertion and retains earlier actions as events', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/settings' });
        await request.controller.evaluateAssert(passingText('Settings'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);

    await expect(run(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(trace(
      [{ type: 'navigate', url: '/settings' }],
      [passingText('Settings')],
    )));
  });

  it('writes every final passed assertion as verification when the trailing run has length greater than one', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/dashboard' });
        await request.controller.evaluateAssert(passingText('Dashboard'));
        await request.controller.evaluateAssert(passingText('Signed in as Ari'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(trace(
      [{ type: 'navigate', url: '/dashboard' }],
      [passingText('Dashboard'), passingText('Signed in as Ari')],
    )));
  });

  it.each([
    ['a snapshot', async (request: AiAgenticRequest) => request.controller.snapshotForResolution(), [{ passed: true }, { passed: true }] as const],
    ['a failed assertion', async (request: AiAgenticRequest) => request.controller.evaluateAssert(passingText('Intermediate miss')), [
      { passed: true },
      { passed: false, message: 'Intermediate miss.' },
      { passed: true },
    ] as const],
  ] as const)('resets a passed-assert run after %s and retains only the later terminal assertion as verification', async (_description, interrupt, assertOutcomes) => {
    const session = createFakeBrowserSession(new Map(), { assertOutcomes });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/dashboard' });
        await request.controller.evaluateAssert(passingText('Earlier dashboard'));
        await interrupt(request);
        await request.controller.evaluateAssert(passingText('Terminal dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(trace(
      [
        { type: 'navigate', url: '/dashboard' },
        passingText('Earlier dashboard'),
      ],
      [passingText('Terminal dashboard')],
    )));
  });

  it.each([
    ['a perform after an earlier passed assertion', async (request: AiAgenticRequest) => {
      await request.controller.perform({ type: 'navigate', url: '/dashboard' });
      await request.controller.evaluateAssert(passingText('Dashboard'));
      await request.controller.perform({ type: 'press', target: SUBMIT, key: 'Enter' });
    }],
    ['only a bare perform', async (request: AiAgenticRequest) => {
      await request.controller.perform({ type: 'navigate', url: '/dashboard' });
    }],
    ['zero observations', async () => undefined],
  ] as const)('rejects a nominal agentic success with %s instead of writing grounding', async (_description, script) => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await script(request);
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      steps: [{ id: 'recorded-ai', status: 'error', kind: 'environment' }],
    });
    expect(recordingStorage.writes).toEqual([]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({});
  });

  it.each([
    ['a terminal snapshot', async (request: AiAgenticRequest) => request.controller.snapshotForResolution()],
    ['a terminal failed assertion', async (request: AiAgenticRequest) => request.controller.evaluateAssert(passingText('Not yet visible'))],
  ] as const)('allows %s on a cold start without writing an empty grounding entry', async (_description, terminalObservation) => {
    const session = createFakeBrowserSession(new Map(), {
      assertOutcome: { passed: false, message: 'Not yet visible.' },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await terminalObservation(request);
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recordingStorage.writes).toEqual([]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({});
  });

  it.each([
    ['a terminal snapshot', async (request: AiAgenticRequest) => request.controller.snapshotForResolution(), [{ passed: false, message: 'Cached trace missed.' }] as const],
    ['a terminal failed assertion', async (request: AiAgenticRequest) => request.controller.evaluateAssert(passingText('Fresh miss')), [
      { passed: false, message: 'Cached trace missed.' },
      { passed: false, message: 'Fresh miss.' },
    ] as const],
  ] as const)('deletes a stale replay trace when fallback ends with %s and no new replayable trace', async (_description, terminalObservation, assertOutcomes) => {
    const staleTrace = trace([], [passingText('Cached trace')]);
    const session = createFakeBrowserSession(new Map(), { assertOutcomes });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await terminalObservation(request);
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(staleTrace));
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recordingStorage.writes).toHaveLength(1);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual({});
  });

  it('overwrites a behavioral-miss trace with fresh terminal verification rather than merging journals', async () => {
    const staleTrace = trace([{ type: 'navigate', url: '/stale' }], [passingText('Stale')]);
    const session = createFakeBrowserSession(new Map(), { assertOutcomes: [
      { passed: false, message: 'Stale trace missed.' },
      { passed: true },
    ] });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/fresh' });
        await request.controller.evaluateAssert(passingText('Fresh'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(staleTrace));

    await expect(run(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ result: { status: 'passed' } }] });

    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(trace(
      [{ type: 'navigate', url: '/fresh' }],
      [passingText('Fresh')],
    )));
  });

  it.each([
    ['a provider outcome of failure', async (_request: AiAgenticRequest) => ({ outcome: 'failure' as const })],
    ['a provider rejection', async () => {
      throw new Error('The provider transport disconnected.');
    }],
    ['cancellation after partial observations', async (request: AiAgenticRequest, controller: AbortController) => {
      controller.abort(new Error('Stop the agentic call.'));
      return { outcome: 'success' as const };
    }],
  ] as const)('discards partial journal observations and leaves prior grounding untouched after %s', async (_description, finish) => {
    const staleTrace = trace([], [passingText('Cached trace')]);
    const abortController = new AbortController();
    const session = createFakeBrowserSession(new Map(), { assertOutcomes: [
      { passed: false, message: 'Cached trace missed.' },
      { passed: true },
    ] });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/partial' });
        await request.controller.evaluateAssert(passingText('Partial success'));
        return finish(request, abortController);
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
      signal: abortController.signal,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()], aiGrounding(staleTrace));
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(recordingStorage.writes).toEqual([]);
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(staleTrace));
  });
});

describe('run deterministic redaction boundary', () => {
  it('redacts a path-A fill-secret value from a later text-equals assertion failure', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_PATH_A}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_PATH_A_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: `The visible account is ${secretValue}.` },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-path-a-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'assert-path-a-account', kind: 'assert', check: 'text-equals', target: PASSWORD, text: 'Signed in' },
    ], elementGrounding(['fill-path-a-secret', 'assert-path-a-account']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result).toMatchObject({
      status: 'failed',
      explanation: `The visible account is ${secretRef}.`,
      steps: [
        { id: 'fill-path-a-secret', status: 'passed' },
        { id: 'assert-path-a-account', status: 'failed', kind: 'assertion' },
      ],
    });
  });

  it('redacts a deterministic IntegrityViolationError from both the case result and rendered report', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_INTEGRITY}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_INTEGRITY_VALUE';
    const rawMessage = `Deterministic action rejected ${secretValue}.`;
    const redactedMessage = `Deterministic action rejected ${secretRef}.`;
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new IntegrityViolationError(rawMessage, {
            materializedSecret: secretValue,
            observed: [secretValue],
          }, {
            cause: new Error(`Underlying browser diagnostic contains ${secretValue}.`),
          });
        }
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-integrity-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'throw-integrity-error', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding(['fill-integrity-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const caseOutcome = outcome.results[0];
    const report = buildRunReport({
      startedAt: '2026-08-10T00:00:00Z',
      durationMs: 0,
      outcome,
    });

    expect({
      explanation: caseOutcome?.result.explanation,
      errorMessage: caseOutcome?.error?.message,
      reportMessage: report.envelope.errors[0]?.message,
      details: caseOutcome?.error?.details,
      cause: caseOutcome?.error?.cause,
    }).toStrictEqual({
      explanation: redactedMessage,
      errorMessage: redactedMessage,
      reportMessage: redactedMessage,
      details: { materializedSecret: secretRef, observed: [secretRef] },
      cause: undefined,
    });
  });

  it('omits a function-valued detail before its own toJSON can serialize a resolved secret', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_UNSUPPORTED_DETAIL}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_UNSUPPORTED_DETAIL_VALUE';
    const unsupportedValue = Object.assign(
      () => undefined,
      { toJSON: () => secretValue },
    );
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new IntegrityViolationError('Deterministic action rejected an unsupported diagnostic value.', {
            unsupportedValue,
          });
        }
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-unsupported-detail-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'throw-unsupported-detail-error', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding(['fill-unsupported-detail-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error?.details).toStrictEqual({
      unsupportedValue: '[unsupported-value-omitted]',
    });
    expect(JSON.stringify(outcome.results[0])).not.toContain(secretValue);
  });

  it('omits a cyclic detail reference without throwing while classifying the error', async () => {
    const cyclicDetails: Record<string, unknown> = {};
    cyclicDetails.self = cyclicDetails;
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new IntegrityViolationError('Deterministic action rejected cyclic diagnostics.', cyclicDetails);
        }
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'throw-cyclic-detail-error', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding([]));

    const runOutcome = run(deps, DEFAULT_OPTIONS);

    await expect(runOutcome).resolves.toMatchObject({
      results: [{ result: { status: 'error' } }],
    });
    const outcome = await runOutcome;
    expect(outcome.results[0]?.error?.details).toStrictEqual({
      self: '[unsupported-value-omitted]',
    });
  });

  it('omits details beyond the defensive redaction-depth limit without throwing', async () => {
    const deeplyNestedDetails: Record<string, unknown> = {};
    let current: Record<string, unknown> | unknown[] = deeplyNestedDetails;
    for (let depth = 0; depth < 25; depth += 1) {
      const next: Record<string, unknown> | unknown[] = depth % 2 === 0 ? {} : [];
      if (Array.isArray(current)) {
        current.push(next);
      } else {
        current.child = next;
      }
      current = next;
    }

    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new IntegrityViolationError('Deterministic action rejected deeply nested diagnostics.', deeplyNestedDetails);
        }
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'throw-deep-detail-error', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding([]));

    const runOutcome = run(deps, DEFAULT_OPTIONS);

    await expect(runOutcome).resolves.toMatchObject({
      results: [{ result: { status: 'error' } }],
    });
    const outcome = await runOutcome;
    let redactedDetail: unknown = outcome.results[0]?.error?.details;
    for (let depth = 0; depth <= 20; depth += 1) {
      expect(redactedDetail).toBeTypeOf('object');
      redactedDetail = Array.isArray(redactedDetail)
        ? redactedDetail[0]
        : (redactedDetail as Record<string, unknown>).child;
    }
    expect(redactedDetail).toBe('[unsupported-value-omitted]');
  });

  it('retains the fixed generic explanation for a plain deterministic Error without inspecting its secret-bearing message', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_GENERIC}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_GENERIC_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new Error(`Plain browser error exposed ${secretValue}.`);
        }
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-generic-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'throw-generic-error', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding(['fill-generic-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]).toMatchObject({
      result: {
        status: 'error',
        explanation: 'The browser session could not complete this case and no deterministic fallback is available.',
      },
    });
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result.explanation).not.toContain(secretValue);
  });

  it('retains rotating path-A and first-pipeline secret values for a second independent AI pipeline', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_ROTATING_ACROSS_PIPELINES}}';
    const secretValues = [
      'AMBERCAST_SECRET_DUMMY_ROTATING_ACROSS_PIPELINES_FIRST_VALUE',
      'AMBERCAST_SECRET_DUMMY_ROTATING_ACROSS_PIPELINES_SECOND_VALUE',
    ] as const;
    let resolutionIndex = 0;
    const resolve = vi.fn((ref: string) => {
      expect(ref).toBe(secretRef);
      const value = secretValues[resolutionIndex];
      resolutionIndex += 1;
      return value;
    });
    let secondPipelineDiagnostic: string | undefined;
    let agenticInvocation = 0;
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcomes: [
        { passed: true, message: 'The first AI pipeline completed.' },
        {
          passed: true,
          message: `The second AI pipeline observed ${secretValues[0]} before ${secretValues[1]}.`,
        },
        {
          passed: false,
          message: `The final deterministic assertion observed ${secretValues[0]} before ${secretValues[1]}.`,
        },
      ],
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        if (agenticInvocation === 0) {
          agenticInvocation += 1;
          await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
          await request.controller.evaluateAssert(passingText('First AI pipeline verification'));
          return { outcome: 'success' };
        }

        if (agenticInvocation === 1) {
          agenticInvocation += 1;
          const outcome = await request.controller.evaluateAssert(passingText('Second AI pipeline diagnostic'));
          secondPipelineDiagnostic = outcome.message;
          return { outcome: 'success' };
        }

        throw new Error('The scenario permits exactly two agentic executions.');
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: { resolve },
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-path-a-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      aiStep('resolve-rotated-secret', [secretRef]),
      aiStep('observe-rotated-secrets'),
      { id: 'assert-after-pipelines', kind: 'assert', check: 'text-equals', target: PASSWORD, text: 'Signed in' },
    ], elementGrounding(['fill-path-a-secret', 'assert-after-pipelines']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(executor.agenticRequests).toHaveLength(2);
    expect(executor.agenticRequests[0]?.controller).not.toBe(executor.agenticRequests[1]?.controller);
    expect(secondPipelineDiagnostic).toBe(`The second AI pipeline observed ${secretRef} before ${secretRef}.`);
    expect(outcome.results[0]?.result.explanation).toBe(`The final deterministic assertion observed ${secretRef} before ${secretRef}.`);
  });

  it('retains a trace-replay secret for a later deterministic assertion failure', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_TRACE_REPLAY}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_TRACE_REPLAY_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcomes: [
        { passed: true, message: 'Cached trace verification passed.' },
        { passed: false, message: `Later deterministic observation contains ${secretValue}.` },
      ],
    });
    const { deps, recordingStorage, resolveAiExecutor } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      aiStep('replay-secret-trace', [secretRef]),
      { id: 'assert-after-trace-replay', kind: 'assert', check: 'text-equals', target: PASSWORD, text: 'Signed in' },
    ], {
      'replay-secret-trace': {
        kind: 'ai',
        trace: trace(
          [{ type: 'fill-secret', target: PASSWORD, secretRef }],
          [passingText('Cached trace verification')],
        ),
      },
      ...elementGrounding(['assert-after-trace-replay']),
    });

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(outcome.results[0]?.result.explanation).toBe(`Later deterministic observation contains ${secretRef}.`);
  });
});

describe('run agentic materialization boundary', () => {
  it('redacts secret and run values from an agentic resolution snapshot and omits screenshot bytes', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_SNAPSHOT}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_SNAPSHOT_VALUE';
    const runValue = 'RUN_SNAPSHOT_VALUE';
    const snapshot = {
      accessibilityTree: {
        role: 'document',
        [`Secret label ${secretValue}`]: {
          name: `Visible ${secretValue} beside ${runValue}.`,
          children: [{
            role: 'text',
            name: 'Public content',
            count: 3,
            checked: false,
            nested: { empty: '', enabled: true },
          }],
        },
      },
      screenshot: new Uint8Array([4, 5, 6]),
    };
    let resolutionSnapshot: Awaited<ReturnType<AiAgenticRequest['controller']['snapshotForResolution']>> | undefined;
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue, value: '' }]]),
      snapshot,
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        resolutionSnapshot = await request.controller.snapshotForResolution();
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      aiStep('agentic-snapshot', [secretRef]),
    ], elementGrounding(['capture-token']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    if (resolutionSnapshot === undefined) {
      throw new Error('The agentic executor did not receive a resolution snapshot.');
    }
    expect(resolutionSnapshot).toStrictEqual({
      accessibilityTree: {
        role: 'document',
        [`Secret label ${secretRef}`]: {
          name: `Visible ${secretRef} beside {{run.token}}.`,
          children: [{
            role: 'text',
            name: 'Public content',
            count: 3,
            checked: false,
            nested: { empty: '', enabled: true },
          }],
        },
      },
    });
  });

  it('redacts overlapping secret and run values from grounding, results, errors, details, and events after proving each surface is populated', async () => {
    const secretRef = '{{secrets.auth.token}}';
    const secretValue = 'SECRET-RUN-SENTINEL';
    const runValue = 'RUN-SENTINEL';
    let adapterMessage: string | undefined;
    const successfulSession = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue, value: '' }]]),
      assertOutcome: { passed: true, message: `Observed ${secretValue} beside ${runValue}.` },
    });
    const successfulExecutor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        const assertion = await request.controller.evaluateAssert({
          type: 'assert',
          check: 'text-visible',
          text: '{{run.token}}',
        });
        adapterMessage = assertion.message;
        return { outcome: 'success' };
      },
    });
    const successful = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => successfulSession)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => successfulExecutor,
    });
    const successfulPath = await writePrompt(
      successful.recordingStorage.storage,
      'login.test.md',
      `${PROMPT}\n${secretRef}\n`,
    );
    await seedFreshArtifacts(successful.recordingStorage.storage, successfulPath, [
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      aiStep('recorded-ai', [secretRef]),
    ], elementGrounding(['capture-token']));

    const successfulOutcome = await run(successful.deps, DEFAULT_OPTIONS);
    const successfulGroundingText = await successful.recordingStorage.storage.readText(
      `${TEST_DIR}/login.ambercast.grounding.json`,
    );

    expect((await readGrounding(successful.recordingStorage.storage, successfulPath)).entries['recorded-ai']).toMatchObject({
      kind: 'ai',
      trace: { events: [{ type: 'fill-secret', secretRef }], verification: [passingText('{{run.token}}')] },
    });
    expect(adapterMessage).toBe(`Observed ${secretRef} beside {{run.token}}.`);
    expect(successfulOutcome.results[0]?.result).toMatchObject({
      status: 'passed',
      steps: [
        { id: 'capture-token', status: 'passed' },
        { id: 'recorded-ai', status: 'passed' },
      ],
    });
    expect(aiCalls(successful.events)).toEqual([{ type: 'ai-call', stepId: 'recorded-ai' }]);
    expect(successful.events.emitted().filter((event) => event.type === 'step-result' && event.stepId === 'recorded-ai')).toEqual([
      { type: 'step-result', stepId: 'recorded-ai', via: 'ai-resolve' },
    ]);

    const failingSession = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue, value: '' }]]),
      onPerform(action) {
        if (action.type === 'fill') {
          throw new IntegrityViolationError(`Browser rejected ${secretValue} and ${runValue}.`, {
            secret: secretValue,
            run: runValue,
          });
        }
      },
    });
    const failingExecutor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        await request.controller.perform({ type: 'fill', target: EMAIL, value: '{{run.token}}' });
        return { outcome: 'success' };
      },
    });
    const failing = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => failingSession)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => failingExecutor,
    });
    const failingPath = await writePrompt(
      failing.recordingStorage.storage,
      'login.test.md',
      `${PROMPT}\n${secretRef}\n`,
    );
    await seedFreshArtifacts(failing.recordingStorage.storage, failingPath, [
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      aiStep('recorded-ai', [secretRef]),
    ], elementGrounding(['capture-token']));

    const failingOutcome = await run(failing.deps, DEFAULT_OPTIONS);
    const failure = failingOutcome.results[0]?.error;

    expect(failure).toBeInstanceOf(IntegrityViolationError);
    expect(failure?.message).toBe(`Browser rejected ${secretRef} and {{run.token}}.`);
    expect(failure?.details).toEqual({ secret: secretRef, run: '{{run.token}}' });
    expect(failure?.cause).toBeUndefined();
    expect(failingOutcome.results[0]?.result).toMatchObject({
      status: 'error',
      explanation: `Browser rejected ${secretRef} and {{run.token}}.`,
      steps: [
        { id: 'capture-token', status: 'passed' },
        { id: 'recorded-ai', status: 'error', kind: 'environment' },
      ],
    });
    expect(aiCalls(failing.events)).toEqual([{ type: 'ai-call', stepId: 'recorded-ai' }]);
    for (const surface of [
      successfulGroundingText,
      JSON.stringify(successfulOutcome.results[0]?.result),
      failure?.message ?? '',
      JSON.stringify(failure?.details ?? {}),
      JSON.stringify(failingOutcome.results[0]?.result),
      JSON.stringify(successful.events.emitted()),
      JSON.stringify(failing.events.emitted()),
    ]) {
      expect(surface).not.toContain(secretValue);
      expect(surface).not.toContain(runValue);
    }
  });

  it.each([
    ['a captured run value', async (request: AiAgenticRequest) => {
      await request.controller.perform({ type: 'navigate', url: 'RUN-LITERAL-SENTINEL' });
    }],
    ['a resolved secret value', async (request: AiAgenticRequest) => {
      await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.auth.literal}}' });
      await request.controller.perform({ type: 'fill', target: EMAIL, value: 'SECRET-LITERAL-SENTINEL' });
    }],
  ] as const)('rejects a provider echo of %s as a literal before it reaches the browser journal', async (_description, script) => {
    const secretRef = '{{secrets.auth.literal}}';
    const runValue = 'RUN-LITERAL-SENTINEL';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue, value: '' }]]),
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await script(request);
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, 'SECRET-LITERAL-SENTINEL']])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      aiStep('recorded-ai', [secretRef]),
    ], elementGrounding(['capture-token']));
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(recordingStorage.writes).toEqual([]);
    expect(session.operations().filter((operation) => operation.type === 'perform')).toEqual(
      _description === 'a captured run value'
        ? []
        : [{ type: 'perform', action: { type: 'fill-secret', target: PASSWORD, value: 'SECRET-LITERAL-SENTINEL' } }],
    );
  });

  it.each([
    ['an empty secret', '', 'ordinary provider text', 'passed'],
    ['a one-character secret as a substring', 'x', 'prefix-xsuffix', 'passed'],
    ['a one-character secret as an exact value', 'x', 'x', 'rejected'],
    ['a two-character secret as a substring', 'xy', 'prefix-xysuffix', 'passed'],
    ['a two-character secret as an exact value', 'xy', 'xy', 'rejected'],
    ['a three-character secret as a substring', 'xyz', 'prefix-xyzsuffix', 'rejected'],
    ['a four-character secret as a substring', 'wxyz', 'prefix-wxyzsuffix', 'rejected'],
  ] as const)('applies the resolved-secret boundary matrix to %s', async (_description, secretValue, candidate, expectation) => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]));
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        await request.controller.perform({ type: 'fill', target: EMAIL, value: candidate });
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep('recorded-ai', [secretRef])]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, DEFAULT_OPTIONS);

    if (expectation === 'rejected') {
      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(recordingStorage.writes).toEqual([]);
      expect(session.operations()).toEqual([
        { type: 'perform', action: { type: 'fill-secret', target: PASSWORD, value: secretValue } },
      ]);
      return;
    }

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recordingStorage.writes).toHaveLength(1);
  });

  it.each([
    ['navigate URL', async (request: AiAgenticRequest, runValue: string) => {
      await request.controller.perform({ type: 'navigate', url: `/users/${runValue}/settings` });
    }],
    ['fill value', async (request: AiAgenticRequest, runValue: string) => {
      await request.controller.perform({ type: 'fill', target: PASSWORD, value: `welcome-${runValue}` });
    }],
    ['assertion text', async (request: AiAgenticRequest, runValue: string) => {
      await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: `Welcome ${runValue}.` });
    }],
    ['assertion URL pattern', async (request: AiAgenticRequest, runValue: string) => {
      await request.controller.evaluateAssert({ type: 'assert', check: 'url-matches', pattern: `/users/${runValue}/.*` });
    }],
  ] as const)('keeps captured run-state values exact-match-only for %s', async (_description, script) => {
    const runValue = 'AMBERCAST_SECRET_DUMMY_RUN_VALUE';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue, value: '' }]]),
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await script(request, runValue);
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(
      recordingStorage.storage,
      testPath,
      [
        { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
        aiStep(),
      ],
      elementGrounding(['capture-token']),
    );

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(outcome.results[0]?.error).toBeUndefined();
  });

  it.each([
    ['an empty secret value', '', undefined, 'empty secret marker'],
    ['an empty run value', undefined, '', 'empty run marker'],
  ] as const)('does not template %s in an assertion diagnostic', async (_description, secretValue, runValue, message) => {
    const secretRef = '{{secrets.auth.empty}}';
    let adapterMessage: string | undefined;
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: runValue ?? 'unused', value: '' }]]),
      assertOutcome: { passed: true, message },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        if (secretValue !== undefined) {
          await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        }
        const outcome = await request.controller.evaluateAssert(passingText('Visible'));
        adapterMessage = outcome.message;
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue ?? 'unused']])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(
      recordingStorage.storage,
      'login.test.md',
      secretValue === undefined ? PROMPT : `${PROMPT}\n${secretRef}\n`,
    );
    const steps: Step[] = secretValue === undefined
      ? [
        { id: 'capture-empty', kind: 'capture', target: EMAIL, variable: 'empty' },
        aiStep('recorded-ai'),
      ]
      : [aiStep('recorded-ai', [secretRef])];
    const entries = secretValue === undefined ? elementGrounding(['capture-empty']) : {};
    await seedFreshArtifacts(recordingStorage.storage, testPath, steps, entries);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(adapterMessage).toBe(message);
  });

  it('templates repeated diagnostics longest-first with the secret-before-run tie-break', async () => {
    const shortRun = 'prefix';
    const tiedValue = 'same';
    const longValue = 'prefix-long';
    const tiedSecretRef = '{{secrets.auth.tied}}';
    const longSecretRef = '{{secrets.auth.long}}';
    let adapterMessage: string | undefined;
    const session = createFakeBrowserSession(liveEntries([EMAIL, SUBMIT, PASSWORD]), {
      captureValues: new Map([
        [elementRefKey(EMAIL), { text: shortRun, value: '' }],
        [elementRefKey(SUBMIT), { text: tiedValue, value: '' }],
      ]),
      assertOutcome: { passed: true, message: `${longValue} ${shortRun} ${tiedValue} ${tiedValue}` },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: tiedSecretRef });
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: longSecretRef });
        const outcome = await request.controller.evaluateAssert(passingText('Visible'));
        adapterMessage = outcome.message;
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([
        [tiedSecretRef, tiedValue],
        [longSecretRef, longValue],
      ])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(
      recordingStorage.storage,
      'login.test.md',
      `${PROMPT}\n${tiedSecretRef}\n${longSecretRef}\n`,
    );
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'capture-prefix', kind: 'capture', target: EMAIL, variable: 'prefix' },
      { id: 'capture-same', kind: 'capture', target: SUBMIT, variable: 'same' },
      aiStep('recorded-ai', [tiedSecretRef, longSecretRef]),
    ], elementGrounding(['capture-prefix', 'capture-same']));

    await expect(run(deps, DEFAULT_OPTIONS)).resolves.toMatchObject({ results: [{ result: { status: 'passed' } }] });

    expect(adapterMessage).toBe(`${longSecretRef} {{run.prefix}} ${tiedSecretRef} ${tiedSecretRef}`);
  });
});

describe('run per-case grounding flush and dispatch wiring', () => {
  it('surfaces a grounding flush failure as FsIoError after an otherwise-clean agentic case', async () => {
    const session = createFakeBrowserSession(new Map());
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    const writeText = vi.spyOn(recordingStorage.storage, 'writeText').mockRejectedValueOnce(new Error('disk full'));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]?.error).toBeInstanceOf(FsIoError);
    expect(outcome.results[0]?.error).toMatchObject({ kind: 'fs-io-error', exitCode: 3 });
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      explanation: 'The grounding cache could not be written.',
      steps: [{ id: 'recorded-ai', status: 'passed' }],
    });
    expect(outcome.results[0]?.result.steps[0]).not.toHaveProperty('screenshot');
    expect(outcome.results[0]?.result.steps[0]).not.toHaveProperty('screenshotOmitted');
    expect(outcome.results[0]?.result.steps[0]).not.toHaveProperty('observed');
  });

  it('redacts a resolved secret and drops the cause when a grounding flush fails', async () => {
    const secretRef = '{{secrets.AMBERCAST_SECRET_DUMMY_GROUNDING_FLUSH}}';
    const secretValue = 'AMBERCAST_SECRET_DUMMY_GROUNDING_FLUSH_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]));
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef });
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep('recorded-ai', [secretRef])]);
    const storageFailure = new Error(`The storage backend rejected ${secretValue}.`, {
      cause: new Error(`The filesystem diagnostic contains ${secretValue}.`),
    });
    const writeText = vi.spyOn(recordingStorage.storage, 'writeText').mockRejectedValueOnce(storageFailure);

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const caseOutcome = outcome.results[0];

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(session.operations()).toContainEqual({
      type: 'perform',
      action: { type: 'fill-secret', target: PASSWORD, value: secretValue },
    });
    expect({
      errorMessage: caseOutcome?.error?.message,
      errorCause: caseOutcome?.error?.cause,
      explanation: caseOutcome?.result.explanation,
    }).toStrictEqual({
      errorMessage: 'The grounding cache could not be written.',
      errorCause: undefined,
      explanation: 'The grounding cache could not be written.',
    });
    expect(JSON.stringify(caseOutcome)).not.toContain(secretValue);
  });

  it('does not let a flush failure override an execution failure after a prior successful grounding mutation', async () => {
    const session = createFakeBrowserSession(new Map(), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new Error('The next deterministic step failed.');
        }
      },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      aiStep(),
      { id: 'later-failure', kind: 'action', action: 'navigate', url: '/later' },
    ]);
    const writeText = vi.spyOn(recordingStorage.storage, 'writeText').mockRejectedValueOnce(new Error('disk full'));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      explanation: 'The browser session could not complete this case and no deterministic fallback is available.',
      steps: [
        { id: 'recorded-ai', status: 'passed' },
        { id: 'later-failure', status: 'error', kind: 'environment' },
      ],
    });
  });

  it('flushes a successful earlier grounding mutation even when a later step in the same case fails', async () => {
    const session = createFakeBrowserSession(new Map(), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new Error('The next deterministic step failed.');
        }
      },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(passingText('Dashboard'));
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor: async () => executor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      aiStep(),
      { id: 'later-failure', kind: 'action', action: 'navigate', url: '/later' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect((await readGrounding(recordingStorage.storage, testPath)).entries).toEqual(aiGrounding(trace(
      [],
      [passingText('Dashboard')],
    )));
  });

  it('memoizes one lazy executor across path-C and path-B fallbacks while incrementally granting earlier captures', async () => {
    const capturedValue = 'Ari';
    const session = createFakeBrowserSession(new Map([
      [elementRefKey(EMAIL), { exists: true, currentFingerprint: FINGERPRINT }],
      [elementRefKey(SUBMIT), { exists: true, currentFingerprint: DIFFERENT_FINGERPRINT }],
    ]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: capturedValue, value: '' }]]),
      snapshot: pathBSnapshot(),
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        expect(request.allowedRunRefs).toEqual(['name']);
        await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: '{{run.name}}' });
        return { outcome: 'success' };
      },
      execute: () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => executor);
    const { deps, events, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      resolveAiExecutor,
    });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'capture-name', kind: 'capture', target: EMAIL, variable: 'name' },
      aiStep(),
      { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
    ], elementGrounding(['capture-name', 'click-submit']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(executor.structuredRequests).toHaveLength(1);
    expect(aiCalls(events)).toEqual([
      { type: 'ai-call', stepId: 'recorded-ai' },
      { type: 'ai-call', stepId: 'click-submit' },
    ]);
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      { type: 'step-result', stepId: 'capture-name', via: 'grounding' },
      { type: 'step-result', stepId: 'recorded-ai', via: 'ai-resolve' },
      { type: 'step-result', stepId: 'click-submit', via: 'ai-resolve' },
    ]);
  });
});

describe('run failure evidence', () => {
  it('persists a normal assertion screenshot with real filesystem storage and a schema-valid result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ambercast-run-evidence-'));
    const testDir = join(root, 'tests');
    const runsDir = join(root, '.runs');
    const testPath = join(testDir, 'login.test.md');
    const runId = '2026-08-10T000000Z-550e8400-e29b-41d4-a716-446655440000';
    const screenshotBytes = new Uint8Array([7, 8, 9]);
    const storage = createFsStorage();
    const layout = createLayoutResolver({ testDir, runsDir });

    try {
      await storage.writeText(testPath, PROMPT);
      const plan: PlanDocument = {
        schemaVersion: 1,
        source: {
          inputsDigest: computeInputsDigest({
            normalizedTestMd: normalizeTestMd(PROMPT), schemaVersion: 1,
            generatorPromptTemplateFingerprint: promptTemplateFingerprint(), targetDefinitions: TARGETS,
          }),
        },
        targets: TARGETS,
        steps: [
          { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
          { id: 'later-step', kind: 'action', action: 'navigate', url: '/later' },
        ],
      };
      await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
      await storage.writeText(layout.groundingPathFor(testPath), toCanonicalArtifactText({
        schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {},
      } as unknown as JsonValueT));
      const session = createFakeBrowserSession(new Map(), {
        assertOutcome: { passed: false, message: 'The dashboard is absent.' },
        snapshot: { accessibilityTree: { role: 'document', name: 'Sign in' }, screenshot: screenshotBytes },
      });
      const outcome = await run({
        storage, layout, clock: createFixedClock(new Date('2026-08-10T00:00:00.000Z'), 0), runId,
        browserDriver: () => createFakeBrowserDriver(() => session), secrets: createFakeSecretsProvider(new Map()),
        resolveAiExecutor: async () => createFakeAiExecutor(), events: createRecordingEventSink().sink,
        discoverTestFiles: async () => [],
        config: { testDir, testMatch: ['**/*.test.md'], testIgnore: ['**/.runs/**'], targets: TARGETS, defaultTarget: 'web' },
      }, { files: [testPath], cacheOnly: false, stale: 'fail' });
      const result = outcome.results[0]?.result;
      const step = result?.steps[0];
      const screenshotPath = join(runsDir, runId, 'login', 'assert-dashboard.png');

      expect(RunResult.safeParse(result).success).toBe(true);
      expect(step).toMatchObject({
        expected: 'Text "Dashboard" is visible.', actual: 'The dashboard is absent.', screenshot: screenshotPath,
        observed: { note: OBSERVED_NOTE, accessibilitySnapshot: '{"role":"document","name":"Sign in"}' },
      });
      expect(step).not.toHaveProperty('screenshotOmitted');
      expect(result?.steps[1]).not.toHaveProperty('screenshot');
      expect(result?.steps[1]).not.toHaveProperty('screenshotOmitted');
      expect(result?.steps[1]).not.toHaveProperty('observed');
      expect(new Uint8Array(await readFile(screenshotPath))).toEqual(screenshotBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [{ id: 'text-visible', kind: 'assert', check: 'text-visible', text: 'Welcome' }, {}, 'Text "Welcome" is visible.'],
    [{ id: 'element-visible', kind: 'assert', check: 'element-visible', target: SUBMIT }, elementGrounding(['element-visible']), 'Element button "Submit" is visible.'],
    [{ id: 'text-equals', kind: 'assert', check: 'text-equals', target: SUBMIT, text: 'Continue' }, elementGrounding(['text-equals']), 'Element button "Submit" has text "Continue".'],
    [{ id: 'url-matches', kind: 'assert', check: 'url-matches', pattern: '/dashboard/.*' }, {}, 'URL matches "/dashboard/.*".'],
    [{ id: 'element-count', kind: 'assert', check: 'element-count', target: SUBMIT, count: 2 }, elementGrounding(['element-count']), 'Element button "Submit" has count 2.'],
  ] as const)('renders the materialized expected description for %s', async (step, entries, expected) => {
    const session = createFakeBrowserSession(liveEntries([SUBMIT]), {
      assertOutcome: { passed: false, message: 'The browser reported a mismatch.' },
    });
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [step], entries);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.steps[0]).toMatchObject({ expected, actual: 'The browser reported a mismatch.' });
  });

  it('restores a captured run reference in an expected assertion description exactly once', async () => {
    const session = createFakeBrowserSession(liveEntries([EMAIL]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: 'Ari', value: '' }]]),
      assertOutcome: { passed: false, message: 'Welcome, Ari was not visible.' },
    });
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'capture-name', kind: 'capture', target: EMAIL, variable: 'name' },
      { id: 'assert-welcome', kind: 'assert', check: 'text-visible', text: 'Welcome, {{run.name}}' },
    ], elementGrounding(['capture-name']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result).toMatchObject({
      explanation: 'Welcome, {{run.name}} was not visible.',
      steps: [{ status: 'passed' }, {
        expected: 'Text "Welcome, {{run.name}}" is visible.', actual: 'Welcome, {{run.name}} was not visible.',
      }],
    });
  });

  it('omits screenshots without touching browser or storage when raw accessibility evidence contains a resolved secret', async () => {
    const secretRef = '{{secrets.evidence}}';
    const secretValue = 'AMBERCAST_SECRET_EVIDENCE_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: 'The dashboard is absent.' },
      snapshot: { accessibilityTree: { text: `token=${secretValue}` }, screenshot: new Uint8Array([1]) },
    });
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
    ], elementGrounding(['fill-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.steps.at(-1)).toMatchObject({ screenshotOmitted: 'secret-detected' });
    expect(outcome.results[0]?.result.steps.at(-1)).not.toHaveProperty('screenshot');
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('omits screenshots when accessibility capture fails after an earlier fill-secret', async () => {
    const secretRef = '{{secrets.snapshot_evidence}}';
    const secretValue = 'AMBERCAST_SECRET_SNAPSHOT_EVIDENCE_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: 'The dashboard is absent.' },
      snapshot: { accessibilityTree: { role: 'document' }, screenshot: new Uint8Array([1]) },
    });
    vi.spyOn(session, 'accessibilitySnapshot').mockRejectedValue(new Error('a11y unavailable'));
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
    ], elementGrounding(['fill-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const step = outcome.results[0]?.result.steps.at(-1);

    expect(step).toMatchObject({ screenshotOmitted: 'secret-detected' });
    expect(step).not.toHaveProperty('screenshot');
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('captures screenshots when accessibility capture fails without any resolved secret', async () => {
    const session = createFakeBrowserSession(new Map(), {
      assertOutcome: { passed: false, message: 'The dashboard is absent.' },
      snapshot: { accessibilityTree: { role: 'document' }, screenshot: new Uint8Array([1]) },
    });
    vi.spyOn(session, 'accessibilitySnapshot').mockRejectedValue(new Error('a11y unavailable'));
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
    ]);

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const step = outcome.results[0]?.result.steps[0];

    expect(step).toMatchObject({ screenshot: expect.any(String) });
    expect(step).not.toHaveProperty('screenshotOmitted');
    expect(screenshot).toHaveBeenCalledOnce();
    expect(writeBinary).toHaveBeenCalledOnce();
  });

  it('still omits screenshots when redacted secret-bearing accessibility evidence cannot be serialized', async () => {
    const secretRef = '{{secrets.rendering_evidence}}';
    const secretValue = 'AMBERCAST_SECRET_RENDERING_EVIDENCE_VALUE';
    let textReads = 0;
    const accessibilityTree: { readonly text: string } = {} as { readonly text: string };
    Object.defineProperty(accessibilityTree, 'text', {
      enumerable: true,
      get() {
        textReads += 1;
        if (textReads === 1) {
          return `token=${secretValue}`;
        }

        throw new Error('observed evidence rendering failed');
      },
    });
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: 'The dashboard is absent.' },
      snapshot: {
        accessibilityTree,
        screenshot: new Uint8Array([1]),
      },
    });
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
    ], elementGrounding(['fill-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.steps.at(-1)).toMatchObject({ screenshotOmitted: 'secret-detected' });
    expect(outcome.results[0]?.result.steps.at(-1)).not.toHaveProperty('screenshot');
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('omits an assertion screenshot when its raw diagnostic contains a resolved secret despite a clean tree', async () => {
    const secretRef = '{{secrets.evidence}}';
    const secretValue = 'AMBERCAST_SECRET_EVIDENCE_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: `The page exposed ${secretValue}.` },
      snapshot: { accessibilityTree: { text: 'Clean accessibility evidence' }, screenshot: new Uint8Array([1]) },
    });
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' },
    ], elementGrounding(['fill-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.steps.at(-1)).toMatchObject({
      actual: `The page exposed ${secretRef}.`, screenshotOmitted: 'secret-detected',
    });
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('omits an assertion screenshot when only its raw expected text contains a resolved secret', async () => {
    const secretRef = '{{secrets.expected_evidence}}';
    const secretValue = 'AMBERCAST_SECRET_EXPECTED_EVIDENCE_VALUE';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: secretValue, value: '' }]]),
      assertOutcome: { passed: false, message: 'The ordinary diagnostic is clean.' },
      snapshot: { accessibilityTree: { text: 'Clean accessibility evidence' }, screenshot: new Uint8Array([2]) },
    });
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      { id: 'assert-token', kind: 'assert', check: 'text-visible', text: 'Token {{run.token}}' },
    ], elementGrounding(['fill-secret', 'capture-token']));

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result.steps.at(-1)).toMatchObject({ screenshotOmitted: 'secret-detected' });
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('attaches best-effort evidence to a caught dispatch error without assertion-only fields', async () => {
    const session = createFakeBrowserSession(new Map(), {
      snapshot: { accessibilityTree: { role: 'document', name: 'Broken page' }, screenshot: new Uint8Array([3]) },
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new Error('socket disconnected');
        }
      },
    });
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'open-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const step = outcome.results[0]?.result.steps[0];

    expect(outcome.results[0]?.result.explanation).toBe('The browser session could not complete this case and no deterministic fallback is available.');
    expect(step).toMatchObject({ id: 'open-dashboard', status: 'error', kind: 'environment', screenshot: expect.any(String), observed: expect.any(Object) });
    expect(step).not.toHaveProperty('expected');
    expect(step).not.toHaveProperty('actual');
  });

  it('sequences accessibility capture before screenshot and keeps their failure modes independent', async () => {
    const order: string[] = [];
    const session = createFakeBrowserSession(new Map(), {
      assertOutcome: { passed: false, message: 'The dashboard is absent.' },
      snapshot: { accessibilityTree: { role: 'document' }, screenshot: new Uint8Array([4]) },
    });
    vi.spyOn(session, 'accessibilitySnapshot').mockImplementation(async () => {
      order.push('accessibility-start');
      await Promise.resolve();
      order.push('accessibility-end');
      throw new Error('a11y unavailable');
    });
    vi.spyOn(session, 'screenshot').mockImplementation(async () => {
      order.push('screenshot');
      return new Uint8Array([4]);
    });
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(order).toEqual(['accessibility-start', 'accessibility-end', 'screenshot']);
    expect(outcome.results[0]?.result.steps[0]).toMatchObject({ screenshot: expect.any(String) });
    expect(outcome.results[0]?.result.steps[0]).not.toHaveProperty('observed');
    expect(outcome.results[0]?.result.steps[0]).not.toHaveProperty('screenshotOmitted');
  });

  it('absorbs screenshot capture or write failures without changing the original assertion result', async () => {
    for (const failure of ['capture', 'write'] as const) {
      const session = createFakeBrowserSession(new Map(), {
        assertOutcome: { passed: false, message: 'The dashboard is absent.' },
        snapshot: { accessibilityTree: { role: 'document' }, screenshot: new Uint8Array([5]) },
      });
      const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)) });
      if (failure === 'capture') {
        vi.spyOn(session, 'screenshot').mockImplementation(() => { throw new Error('synchronous screenshot failure'); });
      } else {
        vi.spyOn(recordingStorage.storage, 'writeBinary').mockRejectedValue(new Error('disk full'));
      }
      const testPath = await writePrompt(recordingStorage.storage, `${failure}.test.md`);
      await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' }]);

      const outcome = await run(deps, { ...DEFAULT_OPTIONS, files: [testPath] });
      const step = outcome.results[0]?.result.steps[0];

      expect(outcome.results[0]?.result).toMatchObject({ status: 'failed', explanation: 'The dashboard is absent.' });
      expect(step).not.toHaveProperty('screenshot');
      expect(step).toHaveProperty('observed');
    }
  });

  it('omits a caught-error screenshot when only its raw accessibility tree contains a resolved secret', async () => {
    const secretRef = '{{secrets.catch_evidence}}';
    const secretValue = 'AMBERCAST_SECRET_CATCH_EVIDENCE_VALUE';
    const session = createFakeBrowserSession(liveEntries([PASSWORD]), {
      snapshot: { accessibilityTree: { text: `token=${secretValue}` }, screenshot: new Uint8Array([6]) },
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new Error('detached page');
        }
      },
    });
    const screenshot = vi.spyOn(session, 'screenshot');
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'open-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding(['fill-secret']));

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const step = outcome.results[0]?.result.steps.at(-1);

    expect(step).toMatchObject({ kind: 'environment', screenshotOmitted: 'secret-detected' });
    expect(step).not.toHaveProperty('screenshot');
    expect(step).not.toHaveProperty('expected');
    expect(step).not.toHaveProperty('actual');
    expect(screenshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });

  it('redacts raw assertion and accessibility evidence before it reaches the result', async () => {
    const secretRef = '{{secrets.redaction_evidence}}';
    const secretValue = 'secret-"quoted\\value';
    const capturedValue = 'captured-value';
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      captureValues: new Map([[elementRefKey(EMAIL), { text: capturedValue, value: '' }]]),
      assertOutcome: { passed: false, message: `actual ${secretValue} ${capturedValue}` },
      snapshot: {
        accessibilityTree: { [`key ${secretValue}`]: `value ${capturedValue} ${secretValue}` },
        screenshot: new Uint8Array([7]),
      },
    });
    const { deps, recordingStorage } = createScenario({
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(new Map([[secretRef, secretValue]])),
    });
    const testPath = await writePrompt(recordingStorage.storage, 'login.test.md', `${PROMPT}\n${secretRef}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef },
      { id: 'capture-token', kind: 'capture', target: EMAIL, variable: 'token' },
      { id: 'assert-token', kind: 'assert', check: 'text-visible', text: 'Token {{run.token}}' },
    ], elementGrounding(['fill-secret', 'capture-token']));

    const outcome = await run(deps, DEFAULT_OPTIONS);
    const result = outcome.results[0]?.result;
    const step = result?.steps.at(-1);

    expect(step).toMatchObject({
      expected: 'Text "Token {{run.token}}" is visible.',
      actual: `actual ${secretRef} {{run.token}}`,
      screenshotOmitted: 'secret-detected',
      observed: { accessibilitySnapshot: expect.any(String) },
    });
    expect(step?.observed?.accessibilitySnapshot).toContain(secretRef);
    expect(step?.observed?.accessibilitySnapshot).toContain('{{run.token}}');
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(JSON.stringify(result)).not.toContain(capturedValue);
    expect(RunResult.safeParse(result).success).toBe(true);
  });

  it('returns a pre-launch error without attempting to attach browser evidence', async () => {
    const driver = createFakeBrowserDriver(() => createFakeBrowserSession(new Map()));
    vi.spyOn(driver, 'launch').mockRejectedValue(new BrowserLaunchFailedError('launch failed'));
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => driver) });
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'open-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' }]);

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expect(outcome.results[0]?.result).toMatchObject({ status: 'error', steps: [] });
  });

  it('does not capture failure evidence for passing or duplicate literal cases', async () => {
    const passingSession = createFakeBrowserSession(new Map());
    const screenshot = vi.spyOn(passingSession, 'screenshot');
    const accessibilitySnapshot = vi.spyOn(passingSession, 'accessibilitySnapshot');
    const { deps, recordingStorage } = createScenario({ browserDriver: vi.fn(() => createFakeBrowserDriver(() => passingSession)) });
    const writeBinary = vi.spyOn(recordingStorage.storage, 'writeBinary');
    const testPath = await writePrompt(recordingStorage.storage);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{ id: 'open-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' }]);

    const outcome = await run(deps, { ...DEFAULT_OPTIONS, files: [testPath, testPath] });

    expect(outcome.results).toHaveLength(1);
    expect(screenshot).not.toHaveBeenCalled();
    expect(accessibilitySnapshot).not.toHaveBeenCalled();
    expect(writeBinary).not.toHaveBeenCalled();
  });
});
