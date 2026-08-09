import { describe, expect, it, vi } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretUnresolvedError } from '#core/errors/secret-unresolved-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type {
  ElementRef,
  Fingerprint,
  GroundingDocument,
  JsonValueT,
  PlanDocument,
  Step,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { BrowserDriver, BrowserEngine, BrowserSession, PerformableAction } from '#ports/browser.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock } from '#ports/system.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
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
}

interface Scenario {
  readonly deps: RunDeps;
  readonly browserDriver: ReturnType<typeof vi.fn<(engine: BrowserEngine) => BrowserDriver>>;
  readonly events: ReturnType<typeof createRecordingEventSink>;
  readonly recordingStorage: RecordingStorage;
  readonly sessionFactory: ReturnType<typeof vi.fn<() => BrowserSession>>;
}

function createRecordingStorage(): RecordingStorage {
  const backing = createInMemoryStorage();
  const reads: string[] = [];
  const exists: string[] = [];

  return {
    reads,
    exists,
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
    },
  };
}

function createScenario(overrides: Partial<RunDeps> = {}): Scenario {
  const recordingStorage = createRecordingStorage();
  const events = createRecordingEventSink();
  const sessionFactory = vi.fn<() => BrowserSession>(() => createFakeBrowserSession(new Map()));
  const driver = createFakeBrowserDriver(sessionFactory);
  const browserDriver = vi.fn<(engine: BrowserEngine) => BrowserDriver>(() => driver);
  const deps: RunDeps = {
    storage: recordingStorage.storage,
    layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
    clock: createFixedClock(new Date('2026-08-09T00:00:00.000Z'), 0),
    browserDriver,
    secrets: createFakeSecretsProvider(new Map()),
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

  return { deps, browserDriver, events, recordingStorage, sessionFactory };
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
    const testPath = await writePrompt(recordingStorage.storage);
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
    const testPath = await writePrompt(recordingStorage.storage);
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
    const testPath = await writePrompt(recordingStorage.storage);
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

  it('uses the unclassified case-abort stopgap for an AI step and closes the session', async () => {
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

    const outcome = await run(deps, DEFAULT_OPTIONS);

    expectStopgapOutcome(outcome, 'recorded-ai', 'after-ai', 'before-ai');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an absent grounding entry', {} as GroundingDocument['entries'], new Map<string, FakeBrowserSessionEntry>(), false],
    ['an element-not-found grounding miss', elementGrounding(['click-submit']), new Map<string, FakeBrowserSessionEntry>(), true],
    ['a fingerprint-mismatch grounding miss', elementGrounding(['click-submit']), liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), true],
  ] as const)('uses the unclassified case-abort stopgap for %s and closes the session', async (_description, entries, live, resolvesGrounding) => {
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

    const outcome = await run(deps, DEFAULT_OPTIONS);

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
  ] as const)('degrades %s to the grounding-miss case-abort stopgap', async (_description, arrangeGrounding) => {
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

    const outcome = await run(deps, DEFAULT_OPTIONS);

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
