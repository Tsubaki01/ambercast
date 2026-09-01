import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import * as planInputProvenance from '#core/ai/plan-input-provenance.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { planProducerBundleFingerprint } from '#core/ai/plan-producer-bundle.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  type ElementRef,
  type GroundingDocument,
  GeneratedPlanResponse,
  type JsonValueT,
  GROUNDING_SCHEMA_VERSION,
  PlanDocument,
  Step,
  type Fingerprint,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { AssertOutcome, BrowserEngine, BrowserSession } from '#ports/browser.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { EventSink, RunEvent, StageTwoRejectionReason } from '#ports/system.js';
import {
  heal,
  type HealCommitOutcome,
  type HealDeps,
  type HealOptions,
} from '#usecases/heal.js';
import { PlanNavigationResolutionError, type RunOutcome } from '#usecases/run.js';
import { BatchInterruptionTracker } from '#usecases/batch-interruption.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession, elementRefKey, type FakeBrowserSessionEntry } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const replayRunObserver = vi.hoisted(() => ({
  afterRun: undefined as undefined | ((deps: Pick<HealDeps, 'layout' | 'runId'>, storage: StorageAdapter, options: { readonly files: readonly string[]; readonly cacheOnly?: boolean }, outcome: RunOutcome) => void | Promise<void>),
}));

const generateRunObserver = vi.hoisted(() => ({
  rejectWith: undefined as Error | undefined,
  afterGenerate: undefined as undefined | ((outcome: Awaited<ReturnType<typeof import('#usecases/generate.js').generate>>) => void | Promise<void>),
}));

vi.mock('#usecases/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#usecases/run.js')>();
  return {
    ...actual,
    run: async (...args: Parameters<typeof actual.run>) => {
      const outcome = await actual.run(...args);
      await replayRunObserver.afterRun?.(args[0], args[0].storage, args[1], outcome);
      return outcome;
    },
  };
});

vi.mock('#usecases/generate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#usecases/generate.js')>();
  return {
    ...actual,
    generate: async (...args: Parameters<typeof actual.generate>) => {
      if (generateRunObserver.rejectWith !== undefined) throw generateRunObserver.rejectWith;
      const outcome = await actual.generate(...args);
      await generateRunObserver.afterGenerate?.(outcome);
      return outcome;
    },
  };
});

afterEach(() => {
  replayRunObserver.afterRun = undefined;
  generateRunObserver.rejectWith = undefined;
  generateRunObserver.afterGenerate = undefined;
});

const PLAN = '/workspace/tests/login.ambercast.plan.json';
const GROUNDING = '/workspace/tests/login.ambercast.grounding.json';
const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const RESOLVED_TARGETS = { web: { ...TARGETS.web, healReplayIsolation: 'idempotent' as const } } as const;
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) };
const SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Submit' };
const REPAIRED_SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Continue' };
const AFTER_SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Open dashboard' };
const REPAIRED_AFTER_SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Continue to dashboard' };
const PASSWORD = { strategy: 'accessibility' as const, role: 'textbox', name: 'Password' };
const SECRET_PROMPT = '@ambercast-secret {{secrets.PASSWORD}}\n\n# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const AI_STEP = Step.parse({
  id: 'ai-step',
  kind: 'ai',
  instruction: 'Click Submit',
  instructionCoverage: [{
    id: 'dashboard-reached',
    kind: 'success',
    sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 },
  }],
});
const OPTIONS: HealOptions = {
  files: ['/workspace/tests/login.test.md'],
  dryRun: false,
  yes: false,
  list: false,
};

type Stage2RequestContext = {
  readonly trustedInputs?: {
    readonly frontier?: { readonly index: number; readonly stepId: string };
    readonly repairHistory?: unknown;
  };
};

function stage2Frontier(request: { readonly context?: unknown }): { readonly index: number; readonly stepId: string } | undefined {
  return (request.context as Stage2RequestContext | undefined)?.trustedInputs?.frontier;
}

/**
 * Mirrors the live accessibility evidence independently from grounded-entry
 * verification. Route-B resolution reads this tree, whereas session entries
 * model the existing-grounding verification path.
 */
function healAccessibilityTree(entries: ReadonlyMap<string, FakeBrowserSessionEntry>): JsonValueT {
  const targets = [PASSWORD, SUBMIT, REPAIRED_SUBMIT, AFTER_SUBMIT, REPAIRED_AFTER_SUBMIT];
  return {
    role: 'root',
    name: '',
    children: [{
      role: 'main',
      name: 'Application',
      children: targets
          .filter((target) => entries.get(elementRefKey(target))?.exists)
          .map((target) => ({
            role: 'form',
            name: `${target.name} control`,
            children: [{ role: target.role, name: target.name, children: [] }],
          })),
    }],
  };
}

function healSnapshot(entries: ReadonlyMap<string, FakeBrowserSessionEntry>): {
  readonly accessibilityTree: JsonValueT;
  readonly screenshot: Uint8Array;
} {
  return {
    accessibilityTree: healAccessibilityTree(entries),
    screenshot: new Uint8Array([1, 2, 3]),
  };
}

function freshFingerprint(
  entries: ReadonlyMap<string, FakeBrowserSessionEntry>,
  ref: ElementRef = SUBMIT,
): Fingerprint {
  const result = computeAccessibilityFingerprint(healAccessibilityTree(entries), ref, []);
  if (result.kind !== 'ok') {
    throw new Error('The heal fixture must contain exactly one matching target.');
  }

  return result.fingerprint;
}

function liveEntries(...refs: readonly ElementRef[]): Map<string, FakeBrowserSessionEntry> {
  const entries = new Map(refs.map((ref) => [elementRefKey(ref), { exists: true, currentFingerprint: FINGERPRINT }]));
  for (const ref of refs) {
    entries.set(elementRefKey(ref), { exists: true, currentFingerprint: freshFingerprint(entries, ref) });
  }

  return entries;
}

function createDeletableStorage(): { readonly storage: StorageAdapter; readonly deleteFile: (path: string) => void; } {
  const base = createInMemoryStorage();
  const deleted = new Set<string>();
  const missing = (path: string): Error => Object.assign(new Error(`Cannot read non-file path: ${path}`), { code: 'ENOENT' });

  return {
    storage: {
      ...base,
      async readText(path) {
        if (deleted.has(path)) throw missing(path);
        return base.readText(path);
      },
      async readTextSnapshot(path) {
        if (deleted.has(path)) throw missing(path);
        return base.readTextSnapshot(path);
      },
      async writeText(path, content) {
        deleted.delete(path);
        return base.writeText(path, content);
      },
      async readBinary(path) {
        if (deleted.has(path)) throw missing(path);
        return base.readBinary(path);
      },
      async writeBinary(path, content) {
        deleted.delete(path);
        return base.writeBinary(path, content);
      },
      async exists(path) {
        return !deleted.has(path) && base.exists(path);
      },
    },
    deleteFile(path) {
      deleted.add(path);
    },
  };
}

function isTrackedArtifact(path: string): boolean {
  return path === PLAN || path === GROUNDING;
}

function textSnapshot(text: string): { readonly text: string; readonly bytes: Uint8Array } {
  return { text, bytes: new TextEncoder().encode(text) };
}

function withTrackedLegacyReadTrap(storage: StorageAdapter): StorageAdapter {
  return {
    ...storage,
    async readText(path) {
      if (isTrackedArtifact(path)) throw new Error(`Legacy tracked text read: ${path}`);
      return storage.readText(path);
    },
    async readBinary(path) {
      if (isTrackedArtifact(path)) throw new Error(`Legacy tracked binary read: ${path}`);
      return storage.readBinary(path);
    },
  };
}

function permissiveContainedWrites(base: StorageAdapter): Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'> {
  return {
    writeText: base.writeText,
    writeBinary: base.writeBinary,
    ensureDir: base.ensureDir,
  };
}

interface HealScenario {
  readonly deps: HealDeps;
  readonly storage: StorageAdapter;
  readonly textWrites: ReturnType<typeof vi.fn>;
  readonly plan: PlanDocument;
  readonly sessionFactory: ReturnType<typeof vi.fn<() => BrowserSession>>;
}

async function createScenario(options: {
  readonly steps?: readonly ReturnType<typeof Step.parse>[];
  readonly grounding?: GroundingDocument['entries'];
  readonly sessionEntries?: Map<string, FakeBrowserSessionEntry>;
  readonly storage?: StorageAdapter;
  readonly launchFailure?: boolean;
  readonly prompt?: string;
  readonly aiExecutor?: ReturnType<typeof createFakeAiExecutor>;
  readonly secrets?: ReadonlyMap<string, string>;
  readonly signal?: AbortSignal;
  readonly browserDriver?: HealDeps['browserDriver'];
  readonly assertOutcome?: AssertOutcome;
} = {}): Promise<HealScenario> {
  const base = options.storage ?? createInMemoryStorage();
  const textWrites = vi.fn<StorageAdapter['writeText']>(base.writeText);
  const storage: StorageAdapter = { ...base, writeText: textWrites };
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const sessionEntries = options.sessionEntries ?? new Map();
  const sessionFactory = vi.fn<() => BrowserSession>(() => createFakeBrowserSession(sessionEntries, {
    baseUrl: TARGETS.web.baseUrl,
    currentUrl: TARGETS.web.baseUrl,
    snapshot: healSnapshot(sessionEntries),
    ...(options.assertOutcome === undefined ? {} : { assertOutcome: options.assertOutcome }),
  }));
  const plan = PlanDocument.parse({
    schemaVersion: 2,
    source: {
      inputsDigest: computeInputsDigest({
        normalizedTestMd: normalizeTestMd(options.prompt ?? PROMPT),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        planProducerBundleFingerprint: planProducerBundleFingerprint(),
        targetDefinitions: TARGETS,
      }),
    },
    targets: TARGETS,
    steps: options.steps ?? [Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT })],
  });
  const grounding: GroundingDocument = {
    schemaVersion: 1,
    planDigest: computePlanDigest(plan),
    entries: options.grounding ?? {
      'click-submit': { kind: 'element', fingerprint: FINGERPRINT },
    },
  };

  await storage.writeText(OPTIONS.files[0]!, options.prompt ?? PROMPT);
  await storage.writeText(layout.planPathFor(OPTIONS.files[0]!), toCanonicalArtifactText(plan as JsonValueT));
  await storage.writeText(layout.groundingPathFor(OPTIONS.files[0]!), toCanonicalArtifactText(grounding as JsonValueT));
  textWrites.mockClear();

  return {
    storage,
    textWrites,
    plan,
    sessionFactory,
    deps: {
      storage,
      containWrites: () => permissiveContainedWrites(storage),
      layout,
      clock: createFixedClock(new Date('2026-08-25T00:00:00.000Z'), 0),
      runId: '2026-08-25T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: options.browserDriver ?? vi.fn<(engine: BrowserEngine) => ReturnType<typeof createFakeBrowserDriver>>(() => options.launchFailure
        ? {
          engine: 'chromium',
          async launch() { throw new Error('Chromium is unavailable for this fixture.'); },
        }
        : createFakeBrowserDriver(sessionFactory)),
      secrets: createFakeSecretsProvider(options.secrets ?? new Map()),
      resolveAiExecutor: vi.fn(async () => options.aiExecutor ?? createFakeAiExecutor({
        execute: async () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
      })),
      events: createRecordingEventSink().sink,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      discoverTestFiles: vi.fn(async () => ['login.test.md']),
      isCI: false,
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: RESOLVED_TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
        heal: { caseTimeoutMs: 300_000 },
      },
    },
  };
}

async function createBothArtifactRepairScenario(storage?: StorageAdapter): Promise<HealScenario> {
  const repaired: GeneratedPlanResponse = {
    steps: [{ id: 'navigate-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' }],
    ambiguities: [],
  };
  return createScenario({
    ...(storage === undefined ? {} : { storage }),
    steps: [Step.parse({ id: 'navigate-dashboard', kind: 'action', action: 'navigate', url: 'http://[' })],
    grounding: {},
    aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: repaired, raw: JSON.stringify(repaired) }) }),
  });
}

describe('heal validated overlay capability', () => {
  it('exposes tracked snapshots only through successful heal preflight', async () => {
    const scenario = await createScenario({
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });
    const captured: StorageAdapter[] = [];
    replayRunObserver.afterRun = async (_deps, storage) => { captured.push(storage as StorageAdapter); };

    await heal(scenario.deps, OPTIONS);

    expect(captured).not.toHaveLength(0);
    await expect(captured[0]!.readText(PLAN)).resolves.toBe(await scenario.storage.readText(PLAN));
  });

  it.each(['', 'こんにちは世界'] as const)('keeps validated preimages after base mutation/deletion and then exposes buffered %j through all read views', async (content) => {
    const deletable = createDeletableStorage();
    const scenario = await createScenario({
      storage: deletable.storage,
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });
    const planSnapshot = await scenario.storage.readTextSnapshot(PLAN);
    const groundingSnapshot = await scenario.storage.readTextSnapshot(GROUNDING);
    let observed = false;
    replayRunObserver.afterRun = async (_deps, storage) => {
      if (observed) return;
      observed = true;
      await scenario.storage.writeText(PLAN, 'base changed after preflight');
      deletable.deleteFile(GROUNDING);

      const callerOwned = await storage.readTextSnapshot(PLAN);
      callerOwned.bytes.fill(0);
      await expect(storage.readTextSnapshot(PLAN)).resolves.toEqual(planSnapshot);

      await expect(Promise.all([
        storage.readText(PLAN), storage.readTextSnapshot(PLAN), storage.readBinary(PLAN), storage.exists(PLAN),
        storage.readText(GROUNDING), storage.readTextSnapshot(GROUNDING), storage.readBinary(GROUNDING), storage.exists(GROUNDING),
      ])).resolves.toEqual([
        planSnapshot.text, planSnapshot, planSnapshot.bytes, true,
        groundingSnapshot.text, groundingSnapshot, groundingSnapshot.bytes, true,
      ]);

      await storage.writeText(PLAN, content);
      await expect(Promise.all([
        storage.readText(PLAN), storage.readTextSnapshot(PLAN), storage.readBinary(PLAN), storage.exists(PLAN),
      ])).resolves.toEqual([
        content, textSnapshot(content), new TextEncoder().encode(content), true,
      ]);

      await storage.writeText(GROUNDING, content);
      await expect(Promise.all([
        storage.readText(GROUNDING), storage.readTextSnapshot(GROUNDING), storage.readBinary(GROUNDING), storage.exists(GROUNDING),
      ])).resolves.toEqual([
        content, textSnapshot(content), new TextEncoder().encode(content), true,
      ]);
    };

    await heal(scenario.deps, OPTIONS);
    expect(observed).toBe(true);
  });
});

describe('heal state-machine contract', () => {
  function injectReplayIntegrityViolation(when: (call: number, options: { readonly cacheOnly?: boolean }) => boolean, violation: IntegrityViolationError): () => number {
    let call = 0;
    replayRunObserver.afterRun = (_deps, _storage, options, outcome) => {
      call += 1;
      if (when(call, options)) {
        (outcome.results[0] as { error?: IntegrityViolationError } | undefined)!.error = violation;
      }
    };
    return () => call;
  }

  function expectCaseScopedIntegrityFailure(result: Awaited<ReturnType<typeof heal>>, violation: IntegrityViolationError): void {
    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([{ file: OPTIONS.files[0], error: violation }]);
    expect(result.commits.size).toBe(0);
  }

  it('aborts at the cache-only baseline when its replay carries an integrity violation', async () => {
    const violation = new IntegrityViolationError('baseline evidence escaped containment');
    const scenario = await createScenario();
    const calls = injectReplayIntegrityViolation((call, options) => call === 1 && options.cacheOnly === true, violation);

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(calls()).toBe(1);
    expect(scenario.deps.resolveAiExecutor).not.toHaveBeenCalled();
  });

  it('aborts at the initial live measurement when its replay carries an integrity violation', async () => {
    const violation = new IntegrityViolationError('initial live evidence escaped containment');
    const scenario = await createScenario();
    const calls = injectReplayIntegrityViolation((call, options) => call === 2 && options.cacheOnly === false, violation);

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(calls()).toBe(2);
    expect(scenario.deps.resolveAiExecutor).not.toHaveBeenCalled();
  });

  it('aborts at the Stage-1 replay when its replay carries an integrity violation', async () => {
    const violation = new IntegrityViolationError('stage one evidence escaped containment');
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => { throw new AiExecutorUnavailableError('AI is unavailable.'); } }),
    });
    const calls = injectReplayIntegrityViolation((call, options) => call === 3 && options.cacheOnly === false, violation);

    const result = await heal(scenario.deps, OPTIONS);

    expect(calls()).toBe(3);
    expect(scenario.deps.resolveAiExecutor).not.toHaveBeenCalled();
    expectCaseScopedIntegrityFailure(result, violation);
    expect(calls()).toBe(3);
  });

  it('aborts at a Stage-2 candidate replay even when its failure index would advance the frontier', async () => {
    const violation = new IntegrityViolationError('stage two candidate evidence escaped containment');
    const response: GeneratedPlanResponse = {
      steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'after-submit', kind: 'assert', check: 'text-visible', text: 'Dashboard' }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether')
        ? { data: { confirmed: true }, raw: '{"confirmed":true}' }
        : { data: response, raw: JSON.stringify(response) } }),
      assertOutcome: { passed: false, message: 'Dashboard is absent.' },
    });
    let candidateSteps: readonly { readonly id: string; readonly status: string }[] | undefined;
    const calls = injectReplayIntegrityViolation((call, options) => call === 4 && options.cacheOnly === false, violation);
    const injectViolation = replayRunObserver.afterRun;
    replayRunObserver.afterRun = (deps, storage, options, outcome) => {
      if (calls() === 3 && options.cacheOnly === false) {
        candidateSteps = outcome.results[0]?.result.steps.map(({ id, status }) => ({ id, status }));
      }
      return injectViolation?.(deps, storage, options, outcome);
    };

    const result = await heal(scenario.deps, OPTIONS);

    expect(candidateSteps).toEqual([
      { id: 'click-submit', status: 'passed' },
      { id: 'after-submit', status: 'failed' },
    ]);
    expectCaseScopedIntegrityFailure(result, violation);
    expect(calls()).toBe(4);
  });

  it('keeps a repairable Stage-2 candidate replay on the ordinary no-advance path', async () => {
    const violation = new PlanNavigationResolutionError('The Stage two candidate replay could not resolve its navigation.');
    const events = createRecordingEventSink();
    const candidate: GeneratedPlanResponse = {
      steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [],
    };
    const scenario = await createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: candidate, raw: JSON.stringify(candidate) }) }),
    });
    let replayCalls = 0;
    let candidateFirstFailureIndex: number | undefined;
    replayRunObserver.afterRun = (_deps, _storage, options, outcome) => {
      replayCalls += 1;
      if (replayCalls !== 4 || options.cacheOnly === true) return;
      const replay = outcome.results[0];
      candidateFirstFailureIndex = replay?.result.steps.findIndex((step) => step.status === 'failed' || step.status === 'error');
      (replay as { error?: IntegrityViolationError } | undefined)!.error = violation;
    };

    const result = await heal({ ...scenario.deps, events: events.sink }, OPTIONS);
    const outcome = result.outcome.results[0]!;

    expect(candidateFirstFailureIndex).toBe(0);
    expect(outcome.baselineFirstFailureIndex).toBe(0);
    expect(events.emitted()).toContainEqual({ type: 'heal-stage2-rejected', stepId: 'click-submit', reason: 'no-advance' });
    expect(result.outcome.errors).toEqual([]);
    expect(result.commits.size).toBe(0);
  });

  it('fails closed when a Stage-2 candidate replay carries a PlanNavigationResolutionError subclass', async () => {
    class TestSubclassNavigationError extends PlanNavigationResolutionError {}

    const originalUrl = '/p239original';
    const candidateUrl = '/p239candidate';
    const violation = new TestSubclassNavigationError('The subclassed navigation failure escaped the Stage-2 candidate replay.');
    const recording = createRecordingEventSink();
    const candidate: GeneratedPlanResponse = {
      steps: [{ id: 'repair-me', kind: 'action', action: 'navigate', url: candidateUrl }], ambiguities: [],
    };
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: originalUrl }),
        Step.parse({ id: 'after-repair', kind: 'assert', check: 'text-visible', text: 'Dashboard' }),
      ],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: candidate, raw: JSON.stringify(candidate) }) }),
      assertOutcome: { passed: false, message: 'Dashboard is absent.' },
      browserDriver: vi.fn<HealDeps['browserDriver']>(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map(), {
        baseUrl: TARGETS.web.baseUrl,
        currentUrl: TARGETS.web.baseUrl,
        snapshot: healSnapshot(new Map()),
        onPerform() { throw new Error('The Stage-2 navigation fixture must remain at its failing frontier.'); },
      }))),
    });
    let dispatchEventsAtInjection: readonly RunEvent[] | undefined;
    let injected = false;
    replayRunObserver.afterRun = async (_deps, storage, _options, outcome) => {
      const candidatePlan = await storage.readText(PLAN);
      if (!candidatePlan.includes(candidateUrl)) return;

      dispatchEventsAtInjection = recording.emitted().filter((event) => event.type === 'ai-call' || event.type === 'heal-stage2-rejected');
      (outcome.results[0] as { error?: IntegrityViolationError } | undefined)!.error = violation;
      injected = true;
    };

    const result = await heal({ ...scenario.deps, events: recording.sink }, OPTIONS);

    expect(injected).toBe(true);
    expect(recording.emitted().filter((event) => event.type === 'ai-call' || event.type === 'heal-stage2-rejected')).toEqual(dispatchEventsAtInjection);
    expectCaseScopedIntegrityFailure(result, violation);
  });

  it('aborts at the Stage-3 replay when its replay carries an integrity violation', async () => {
    const violation = new IntegrityViolationError('stage three evidence escaped containment');
    const invalidStage2: GeneratedPlanResponse = { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    const stage3: GeneratedPlanResponse = { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    let generation = 0;
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: generation++ === 0 ? invalidStage2 : stage3, raw: '{}' }) }),
    });
    const calls = injectReplayIntegrityViolation((call, options) => call === 4 && options.cacheOnly === false, violation);

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(calls()).toBe(4);
  });

  it('does not absorb an IntegrityViolationError via GenerateFileOutcome.error from Stage-3 generation', async () => {
    const violation = new IntegrityViolationError('Stage three generator crossed a containment boundary');
    const invalidStage2: GeneratedPlanResponse = { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    let generation = 0;
    let generatedItem: { readonly status: string; readonly error?: unknown } | undefined;
    generateRunObserver.afterGenerate = (outcome) => { generatedItem = outcome.results[0]; };
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => {
        if (generation++ === 0) return { data: invalidStage2, raw: '{}' };
        throw violation;
      } }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(generatedItem).toMatchObject({ status: 'failed', error: violation });
  });

  it('does not absorb an exact PlanNavigationResolutionError via GenerateFileOutcome.error from Stage-3 generation', async () => {
    const violation = new PlanNavigationResolutionError('Stage three generation produced a navigation-resolution failure.');
    const invalidStage2: GeneratedPlanResponse = { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    let generation = 0;
    let generatedItem: { readonly status: string; readonly error?: unknown } | undefined;
    generateRunObserver.afterGenerate = (outcome) => { generatedItem = outcome.results[0]; };
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => {
        if (generation++ === 0) return { data: invalidStage2, raw: '{}' };
        throw violation;
      } }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(generatedItem).toMatchObject({ status: 'failed', error: violation });
  });

  it('does not absorb a PlanNavigationResolutionError subclass via GenerateFileOutcome.error from Stage-3 generation', async () => {
    class TestIntegritySubclass extends PlanNavigationResolutionError {}

    const violation = new TestIntegritySubclass('Stage three generation produced a subclassed navigation-resolution failure.');
    const invalidStage2: GeneratedPlanResponse = { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    let generation = 0;
    let generatedItem: { readonly status: string; readonly error?: unknown } | undefined;
    generateRunObserver.afterGenerate = (outcome) => { generatedItem = outcome.results[0]; };
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => {
        if (generation++ === 0) return { data: invalidStage2, raw: '{}' };
        throw violation;
      } }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
    expect(generatedItem).toMatchObject({ status: 'failed', error: violation });
  });

  it('fails closed when generate() itself rejects before producing a GenerateFileOutcome', async () => {
    const violation = new IntegrityViolationError('Stage three generation rejected before producing an outcome.');
    const invalidStage2: GeneratedPlanResponse = { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] };
    let generation = 0;
    let afterGenerateRan = false;
    generateRunObserver.rejectWith = violation;
    generateRunObserver.afterGenerate = () => { afterGenerateRan = true; };
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => {
        if (generation++ === 0) return { data: invalidStage2, raw: '{}' };
        throw new Error('The mocked generate() rejection must happen before this executor call.');
      } }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expect(afterGenerateRan).toBe(false);
    expectCaseScopedIntegrityFailure(result, violation);
  });

  it('does not absorb a PlanNavigationResolutionError from the Stage-3 executor resolver', async () => {
    const violation = new PlanNavigationResolutionError('The Stage three executor resolver reported a navigation-resolution failure.');
    const scenario = await createScenario({ launchFailure: true });

    const result = await heal({
      ...scenario.deps,
      resolveAiExecutor: vi.fn(async () => { throw violation; }),
    }, OPTIONS);

    expectCaseScopedIntegrityFailure(result, violation);
  });

  it('gives an in-flight Stage-3 executor resolver navigation violation precedence over interruption', async () => {
    const controller = new AbortController();
    const violation = new PlanNavigationResolutionError('The interrupted Stage three executor resolver reported a navigation-resolution failure.');
    const scenario = await createScenario({
      launchFailure: true,
      signal: controller.signal,
    });

    const result = await heal({
      ...scenario.deps,
      resolveAiExecutor: vi.fn(async () => {
        controller.abort();
        throw violation;
      }),
    }, OPTIONS);

    expect(controller.signal.aborted).toBe(true);
    expectCaseScopedIntegrityFailure(result, violation);
  });

  it('gives an in-flight initial replay integrity violation precedence over interruption', async () => {
    const controller = new AbortController();
    const violation = new IntegrityViolationError('Interrupted replay still observed a containment escape.');
    let performs = 0;
    let replayInterrupted = false;
    const browserDriver = vi.fn<HealDeps['browserDriver']>(() => createFakeBrowserDriver(() => createFakeBrowserSession(liveEntries(SUBMIT), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
      snapshot: healSnapshot(liveEntries(SUBMIT)),
      onPerform() {
        performs += 1;
        if (performs === 1) {
          controller.abort();
          throw violation;
        }
      },
    })));
    const scenario = await createScenario({
      signal: controller.signal,
      browserDriver,
      grounding: {},
    });
    replayRunObserver.afterRun = (_deps, _storage, _options, outcome) => {
      replayInterrupted = outcome.interrupted;
    };

    const result = await heal(scenario.deps, OPTIONS);

    expect(controller.signal.aborted).toBe(true);
    expect(performs).toBe(1);
    expect(replayInterrupted).toBe(true);
    expect(result.outcome).toMatchObject({ interrupted: false, results: [] });
    expect(result.outcome.errors).toEqual([{ file: OPTIONS.files[0], error: violation }]);
    expect(result.outcome.skipped).toEqual([]);
  });

  it('continues the batch after the first case reports a replay integrity violation', async () => {
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';
    const violation = new IntegrityViolationError('First-case replay escaped containment.');
    const scenario = await createScenario({ sessionEntries: liveEntries(SUBMIT) });
    await scenario.storage.writeText(second, PROMPT);
    await scenario.storage.writeText(scenario.deps.layout.planPathFor(second), await scenario.storage.readText(PLAN));
    await scenario.storage.writeText(scenario.deps.layout.groundingPathFor(second), await scenario.storage.readText(GROUNDING));
    let firstReplay = true;
    replayRunObserver.afterRun = (_deps, _storage, _options, outcome) => {
      if (firstReplay) {
        firstReplay = false;
        (outcome.results[0] as { error?: IntegrityViolationError } | undefined)!.error = violation;
      }
    };

    const result = await heal(scenario.deps, { ...OPTIONS, files: [first, second] });

    expect(result.outcome.errors).toEqual([{ file: first, error: violation }]);
    expect(result.outcome.results).toEqual([expect.objectContaining({ file: second })]);
    expect(result.commits.has(first)).toBe(false);
  });

  it('keeps a genuinely cancelled pending case interrupted when another case has an integrity error', async () => {
    const controller = new AbortController();
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';
    const violation = new IntegrityViolationError('First-case replay escaped its trusted boundary.');
    const scenario = await createScenario({ signal: controller.signal });
    await scenario.storage.writeText(second, PROMPT);
    await scenario.storage.writeText(scenario.deps.layout.planPathFor(second), await scenario.storage.readText(PLAN));
    await scenario.storage.writeText(scenario.deps.layout.groundingPathFor(second), await scenario.storage.readText(GROUNDING));
    replayRunObserver.afterRun = (_deps, _storage, _options, outcome) => {
      (outcome.results[0] as { error?: IntegrityViolationError } | undefined)!.error = violation;
      controller.abort();
    };

    const result = await heal(scenario.deps, { ...OPTIONS, files: [first, second] });

    expect(result.outcome).toMatchObject({ interrupted: true, results: [] });
    expect(result.outcome.errors).toEqual([{ file: first, error: violation }]);
    expect(result.outcome.skipped).toEqual([{ file: second }]);
  });

  it('fails closed when a plan-sourced navigation uses a non-HTTP(S) scheme', async () => {
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'leave-target', kind: 'action', action: 'navigate', url: 'blob:https://example.test/guard-test' })],
    });

    const result = await heal(scenario.deps, OPTIONS);

    const error = result.outcome.errors[0]?.error;
    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(error).not.toBeInstanceOf(PlanNavigationResolutionError);
    expect(result.outcome.errors).toHaveLength(1);
    expect(result.outcome.results).toEqual([]);
    expect(result.commits.size).toBe(0);
  });
  it('keeps every replay attempt in a distinct monotonically numbered evidence directory and never reports discarded evidence', async () => {
    const base = createInMemoryStorage();
    const writeBinary = vi.fn<StorageAdapter['writeBinary']>(base.writeBinary);
    const replayDirectories: string[] = [];
    replayRunObserver.afterRun = (deps, _storage, replayOptions) => {
      replayDirectories.push(deps.layout.runsDirFor(replayOptions.files[0]!, deps.runId));
    };
    const stage2NoAdvance: GeneratedPlanResponse = {
      steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [],
    };
    const stage3Pass: GeneratedPlanResponse = {
      steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    let generation = 0;
    const scenario = await createScenario({
      storage: { ...base, writeBinary },
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
        return { data: generation++ === 0 ? stage2NoAdvance : stage3Pass, raw: '{}' };
      } }),
    });

    const result = await heal(scenario.deps, OPTIONS);
    const screenshotPaths = writeBinary.mock.calls.map(([path]) => path);

    expect(replayDirectories).toEqual([
      expect.stringMatching(/\/attempt-1$/),
      expect.stringMatching(/\/attempt-2$/),
      expect.stringMatching(/\/attempt-3$/),
      expect.stringMatching(/\/attempt-4$/),
      expect.stringMatching(/\/attempt-5$/),
    ]);
    expect(new Set(replayDirectories).size).toBe(replayDirectories.length);
    expect(new Set(screenshotPaths).size).toBe(screenshotPaths.length);
    expect(screenshotPaths).toEqual(expect.arrayContaining([
      expect.stringContaining('/attempt-1/'),
      expect.stringContaining('/attempt-2/'),
      expect.stringContaining('/attempt-3/'),
    ]));
    const finalEvidence = result.outcome.results[0]?.steps.flatMap((step) => step.screenshot === undefined ? [] : [step.screenshot]) ?? [];
    expect(finalEvidence.every((path) => !path.includes('/attempt-4/'))).toBe(true);
  });

  it('resets the evidence attempt ordinal for each case in a batch', async () => {
    const replayDirectories = new Map<string, string[]>();
    replayRunObserver.afterRun = (deps, _storage, replayOptions) => {
      const file = replayOptions.files[0]!;
      const entries = replayDirectories.get(file) ?? [];
      entries.push(deps.layout.runsDirFor(file, deps.runId));
      replayDirectories.set(file, entries);
    };
    const scenario = await createScenario({ assertOutcome: { passed: false, message: 'Dashboard is absent.' } });
    const second = '/workspace/tests/second.test.md';
    const secondPlan = PlanDocument.parse({ ...scenario.plan, steps: [Step.parse({ id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' })] });
    const secondGrounding: GroundingDocument = { schemaVersion: 1, planDigest: computePlanDigest(secondPlan), entries: {} };
    await scenario.storage.writeText(second, PROMPT);
    await scenario.storage.writeText(scenario.deps.layout.planPathFor(second), toCanonicalArtifactText(secondPlan as JsonValueT));
    await scenario.storage.writeText(scenario.deps.layout.groundingPathFor(second), toCanonicalArtifactText(secondGrounding as JsonValueT));

    await heal(scenario.deps, { ...OPTIONS, files: [OPTIONS.files[0]!, second] });

    expect(replayDirectories.get(OPTIONS.files[0]!)?.[0]).toMatch(/\/attempt-1$/);
    expect(replayDirectories.get(second)?.[0]).toMatch(/\/attempt-1$/);
  });
  it('owns list-mode discovery without opening artifacts or creating commits', async () => {
    const scenario = await createScenario();
    const result = await heal(scenario.deps, { ...OPTIONS, list: true });

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.listed).toEqual([{ file: OPTIONS.files[0] }]);
    expect(result.commits.size).toBe(0);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('reads each tracked artifact exactly once through snapshots during preflight and never uses legacy tracked reads', async () => {
    const base = createInMemoryStorage();
    const trackedReads: string[] = [];
    const snapshotReads = new Map<string, number>();
    const storage: StorageAdapter = {
      ...base,
      async readText(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readText:${path}`);
        return base.readText(path);
      },
      async readTextSnapshot(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readTextSnapshot:${path}`);
        const count = (snapshotReads.get(path) ?? 0) + 1;
        snapshotReads.set(path, count);
        if (isTrackedArtifact(path) && count > 1) return textSnapshot('{"changed":"between reads"}');
        return base.readTextSnapshot(path);
      },
      async readBinary(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readBinary:${path}`);
        return base.readBinary(path);
      },
    };
    const scenario = await createScenario({
      storage,
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });
    const derive = vi.spyOn(planInputProvenance, 'deriveCurrentPlanInputProvenance');
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results).toHaveLength(1);
    expect(result.outcome.results[0]).toMatchObject({
      repairOutcome: 'no-changes-needed', baselineFirstFailureIndex: scenario.plan.steps.length,
      finalFirstFailureIndex: scenario.plan.steps.length,
    });
    expect(result.commits.size).toBe(0);
    expect(derive).toHaveBeenCalled();
    expect(trackedReads).toEqual([
      `readTextSnapshot:${PLAN}`,
      `readTextSnapshot:${GROUNDING}`,
    ]);
  });

  it('classifies a plan snapshot rejection from the snapshot operation itself', async () => {
    const base = createInMemoryStorage();
    const snapshotFailure = new Error('snapshot read failed');
    const readTextSnapshot = vi.fn<StorageAdapter['readTextSnapshot']>(async (path) => {
      if (path === PLAN) throw snapshotFailure;
      return base.readTextSnapshot(path);
    });
    const scenario = await createScenario({ storage: {
      ...withTrackedLegacyReadTrap(base),
      readTextSnapshot,
    } });

    const result = await heal(scenario.deps, OPTIONS);

    expect(readTextSnapshot).toHaveBeenCalledOnce();
    expect(readTextSnapshot).toHaveBeenCalledWith(PLAN);
    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toHaveLength(1);
    expect(result.outcome.errors[0]?.error).toBeInstanceOf(FsIoError);
    expect(result.outcome.errors[0]?.error.cause).toBe(snapshotFailure);
  });

  it('stops after the plan snapshot when secret attribution fails and never reads grounding', async () => {
    const base = createInMemoryStorage();
    const trackedReads: string[] = [];
    const scenario = await createScenario({ storage: {
      ...base,
      async readText(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readText:${path}`);
        return base.readText(path);
      },
      async readTextSnapshot(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readTextSnapshot:${path}`);
        return base.readTextSnapshot(path);
      },
      async readBinary(path) {
        if (isTrackedArtifact(path)) trackedReads.push(`readBinary:${path}`);
        return base.readBinary(path);
      },
    }, prompt: SECRET_PROMPT });

    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.errors[0]?.error).toBeInstanceOf(SecretGrantUnattributableError);
    expect(trackedReads).toEqual([`readTextSnapshot:${PLAN}`]);
  });

  it.each([
    {
      title: 'a missing plan file',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        storage: { ...scenario.storage, exists: async (path) => path === PLAN ? false : scenario.storage.exists(path) },
      }),
      error: MissingPlanError,
    },
    {
      title: 'a rejected plan snapshot read',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        storage: {
          ...withTrackedLegacyReadTrap(scenario.storage),
          async readTextSnapshot(path) {
            if (path === PLAN) throw new Error('plan snapshot storage is unavailable');
            return scenario.storage.readTextSnapshot(path);
          },
        },
      }),
      error: FsIoError,
    },
    {
      title: 'a JSON-invalid plan snapshot',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        await scenario.storage.writeText(PLAN, '{');
        return { ...scenario.deps, storage: withTrackedLegacyReadTrap(scenario.storage) };
      },
      error: IntegrityViolationError,
    },
    {
      title: 'a schema-invalid plan snapshot',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        await scenario.storage.writeText(PLAN, toCanonicalArtifactText({}));
        return { ...scenario.deps, storage: withTrackedLegacyReadTrap(scenario.storage) };
      },
      error: IntegrityViolationError,
    },
    {
      title: 'a canonically invalid plan snapshot',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        const parsed = JSON.parse(await scenario.storage.readText(PLAN)) as JsonValueT;
        await scenario.storage.writeText(PLAN, JSON.stringify(parsed));
        return { ...scenario.deps, storage: withTrackedLegacyReadTrap(scenario.storage) };
      },
      error: IntegrityViolationError,
    },
    {
      title: 'an instruction-coverage-invalid plan snapshot',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        const coverageInvalid = {
          ...scenario.plan,
          steps: [{
            id: 'recorded-ai',
            kind: 'ai',
            instruction: 'Reach the dashboard.',
            instructionCoverage: [{
              id: 'outside-prompt',
              kind: 'success',
              sourceSpan: { startLine: 99, startColumn: 1, endLine: 99, endColumn: 2 },
            }],
          }],
        } as unknown as JsonValueT;
        await scenario.storage.writeText(PLAN, toCanonicalArtifactText(coverageInvalid));
        return { ...scenario.deps, storage: withTrackedLegacyReadTrap(scenario.storage) };
      },
      error: IntegrityViolationError,
    },
    {
      title: 'a stale plan',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        await scenario.storage.writeText(OPTIONS.files[0]!, '# Prompt changed after generation\n');
        return scenario.deps;
      },
      error: StaleIrError,
    },
    {
      title: 'a plan with an unsound committed secret attribution',
      create: () => createScenario({ prompt: SECRET_PROMPT }),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => scenario.deps,
      error: SecretGrantUnattributableError,
    },
    {
      title: 'a missing grounding artifact',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        storage: { ...scenario.storage, exists: async (path) => path === GROUNDING ? false : scenario.storage.exists(path) },
      }),
      error: FsIoError,
    },
    {
      title: 'a stale grounding artifact',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        const stale = JSON.parse(await scenario.storage.readText(GROUNDING)) as GroundingDocument;
        await scenario.storage.writeText(GROUNDING, toCanonicalArtifactText({ ...stale, planDigest: 'b'.repeat(64) } as JsonValueT));
        return scenario.deps;
      },
      error: FsIoError,
    },
    {
      title: 'a canonically invalid grounding artifact',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => {
        await scenario.storage.writeText(GROUNDING, JSON.stringify({
          schemaVersion: 1,
          planDigest: computePlanDigest(scenario.plan),
          entries: {
            'click-submit': {
              kind: 'ai',
              trace: {
                events: [],
                verification: [{ type: 'assert', check: 'text-visible', text: 'Ready' }],
                verificationCoverage: { complete: 0 },
              },
            },
          },
        }, null, 2));
        return scenario.deps;
      },
      error: FsIoError,
    },
    {
      title: 'a grounding inspection I/O rejection',
      create: () => createScenario(),
      arrange: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        storage: {
          ...scenario.storage,
          exists: async (path) => {
            if (path === GROUNDING) throw new Error('grounding storage is unavailable');
            return scenario.storage.exists(path);
          },
        },
      }),
      error: FsIoError,
    },
  ])('reports $title as a case-scoped preflight error', async ({ create, arrange, error }) => {
    const scenario = await create();
    const deps = await arrange(scenario);
    const containWrites = vi.fn(deps.containWrites);
    const result = await heal({ ...deps, containWrites }, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toHaveLength(1);
    expect(result.outcome.errors[0]).toMatchObject({ file: OPTIONS.files[0] });
    expect(result.outcome.errors[0]?.error).toBeInstanceOf(error);
    expect(deps.browserDriver).not.toHaveBeenCalled();
    expect(containWrites).not.toHaveBeenCalled();
  });

  it('keeps a cache-hit baseline replay browser-visible and persists failure evidence', async () => {
    const base = createInMemoryStorage();
    const writeBinary = vi.fn<StorageAdapter['writeBinary']>(base.writeBinary);
    const scenario = await createScenario({
      storage: { ...base, writeBinary },
      steps: [Step.parse({ id: 'assert-dashboard', kind: 'assert', check: 'text-visible', text: 'Dashboard' })],
      grounding: {},
      assertOutcome: { passed: false, message: 'Dashboard is absent.' },
      aiExecutor: createFakeAiExecutor({ execute: async () => { throw new AiExecutorUnavailableError('AI is unavailable.'); } }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ baselineFirstFailureIndex: 0 });
    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(2);
    expect(writeBinary).toHaveBeenCalledTimes(2);
  });

  it('replays Stage 1 when an element-consuming failing step has no grounding entry', async () => {
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => { throw new AiExecutorUnavailableError('AI is unavailable.'); } }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved' });
    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(3);
    expect(scenario.deps.resolveAiExecutor).toHaveBeenCalledOnce();
  });

  it('replaces a wrong-kind AI grounding entry when Stage 1 re-resolves an element-consuming step', async () => {
    const sessionEntries = liveEntries(SUBMIT);
    const scenario = await createScenario({
      sessionEntries,
      grounding: {
        'click-submit': {
          kind: 'ai',
          trace: {
            events: [],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
          },
        },
      },
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: scenario.plan.steps.length });
    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(2);
    const commit = result.commits.get(result.outcome.results[0]!.id);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewrittenGrounding = JSON.parse(await scenario.storage.readText(GROUNDING)) as GroundingDocument;
    expect(rewrittenGrounding.entries['click-submit']).toMatchObject({
      kind: 'element',
      fingerprint: freshFingerprint(sessionEntries),
    });
  });

  it.each([
    ['no entry', {} as GroundingDocument['entries'], undefined],
    ['a legacy AI trace', {
      'recorded-ai': { kind: 'ai', trace: { events: [], verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }] } },
    } as GroundingDocument['entries'], 'legacy'],
    ['a wrong-kind element entry', {
      'recorded-ai': { kind: 'element', fingerprint: FINGERPRINT },
    } as GroundingDocument['entries'], 'wrong-kind'],
  ] as const)('replays Stage 1 for an AI step with %s', async (_name, grounding, traceKind) => {
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'navigate', url: '/dashboard' });
        await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Dashboard' }, 'dashboard-reached');
        return { outcome: 'success' };
      },
      execute: async () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }),
    });
    const scenario = await createScenario({
      steps: [Step.parse({
        id: 'recorded-ai', kind: 'ai', instruction: 'Verify the dashboard.',
        instructionCoverage: [{ id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 } }],
      })],
      grounding,
      aiExecutor: executor,
    });

    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: 1 });
    expect(scenario.deps.browserDriver).toHaveBeenCalledOnce();
    expect(executor.agenticRequests).toHaveLength(1);
    const recordedEntry = grounding['recorded-ai'];
    if (traceKind === 'legacy' && recordedEntry?.kind === 'ai') {
      expect(executor.agenticRequests[0]).toMatchObject({ priorTrace: recordedEntry.trace });
    }
  });

  it('skips Stage 1 for an AI step with a current covered trace', async () => {
    const scenario = await createScenario({
      steps: [Step.parse({
        id: 'recorded-ai', kind: 'ai', instruction: 'Verify the dashboard.',
        instructionCoverage: [{ id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 56 } }],
      })],
      grounding: {
        'recorded-ai': {
          kind: 'ai',
          trace: {
            events: [],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
            verificationCoverage: { 'dashboard-reached': 0 },
          },
        },
      },
      assertOutcome: { passed: false, message: 'Dashboard is absent.' },
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: { confirmed: true }, raw: '{"confirmed":true}' }) }),
    });

    await heal(scenario.deps, OPTIONS);

    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(2);
  });

  it('keeps none-classified navigate failures out of Stage 1 even with an element entry', async () => {
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'navigate-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' })],
      grounding: { 'navigate-dashboard': { kind: 'element', fingerprint: FINGERPRINT } },
    });

    await heal(scenario.deps, OPTIONS);

    expect(scenario.deps.browserDriver).toHaveBeenCalledOnce();
  });

  it('keeps the plan digest unchanged while Stage 1 re-resolves one changed element grounding entry', async () => {
    const sessionEntries = liveEntries(SUBMIT);
    const scenario = await createScenario({ sessionEntries });
    const originalPlanDigest = computePlanDigest(scenario.plan);
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: scenario.plan.steps.length });
    const commit = result.commits.get(result.outcome.results[0]!.id);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewrittenPlan = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    const rewrittenGrounding = JSON.parse(await scenario.storage.readText(GROUNDING)) as GroundingDocument;
    expect(computePlanDigest(rewrittenPlan)).toBe(originalPlanDigest);
    expect(rewrittenGrounding.planDigest).toBe(computePlanDigest(rewrittenPlan));
    const refreshedEntry = rewrittenGrounding.entries['click-submit'];
    expect(refreshedEntry).toMatchObject({ kind: 'element', fingerprint: freshFingerprint(sessionEntries) });
    if (refreshedEntry?.kind === 'element') {
      expect(refreshedEntry.fingerprint).not.toEqual(FINGERPRINT);
    }
  });

  it('discards Stage-1 grounding writes when replay does not advance the baseline frontier', async () => {
    let stageOneOverlay: { readonly readText: (path: string) => Promise<string> } | undefined;
    const scenario = await createScenario({
      aiExecutor: createFakeAiExecutor({ execute: async () => { throw new AiExecutorUnavailableError('AI is unavailable.'); } }),
    });
    const originalGrounding = await scenario.storage.readText(GROUNDING);
    replayRunObserver.afterRun = async (_deps, storage, options) => {
      if (options.cacheOnly === false) stageOneOverlay = storage;
    };

    try {
      await heal(scenario.deps, OPTIONS);

      expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(3);
      expect(stageOneOverlay).toBeDefined();
      await expect(stageOneOverlay!.readText(GROUNDING)).resolves.toBe(originalGrounding);
    } finally {
      replayRunObserver.afterRun = undefined;
    }
  });

  it('describes buffered repairs by their concrete path without exposing stage labels', async () => {
    const groundingOnly = await createScenario({ sessionEntries: liveEntries(SUBMIT) });
    const regeneratedTail = await createScenario({
      steps: [
        Step.parse({ id: 'click-password', kind: 'action', action: 'click', target: PASSWORD }),
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
      ],
      grounding: {
        'click-password': { kind: 'element', fingerprint: FINGERPRINT },
        'click-submit': { kind: 'element', fingerprint: FINGERPRINT },
      },
      sessionEntries: new Map([
        [elementRefKey(PASSWORD), { exists: true, currentFingerprint: FINGERPRINT }],
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether')
        ? { data: { confirmed: true }, raw: '{"confirmed":true}' }
        : {
          data: {
            steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }],
            ambiguities: [],
          },
          raw: '{}',
        } }),
    });

    const groundingCommit = (await heal(groundingOnly.deps, OPTIONS)).commits.get(OPTIONS.files[0]!);
    const regenerated = await heal(regeneratedTail.deps, OPTIONS);
    expect(regenerated.outcome.results).toEqual([expect.objectContaining({ repairOutcome: 'healed' })]);
    const regeneratedCommit = regenerated.commits.get(OPTIONS.files[0]!);

    expect(groundingCommit).toBeDefined();
    expect(regeneratedCommit).toBeDefined();
    expect(groundingCommit!.healingSummary).not.toBe(regeneratedCommit!.healingSummary);
    for (const summary of [groundingCommit!.healingSummary, regeneratedCommit!.healingSummary]) {
      expect(summary).not.toMatch(/stage/i);
      expect(summary).not.toMatch(/\d/);
    }
  });

  it('rewrites one Stage-2 step while retaining prefix grounding and honoring a prefix-owned secret grant', async () => {
    const originalSteps = [
      Step.parse({ id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.PASSWORD}}', secretGrantSpan: { startLine: 1, endLine: 1 } }),
      Step.parse({ id: 'click-submit', kind: 'action', action: 'navigate', url: 'http://[' }),
      Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
    ];
    const repair: GeneratedPlanResponse = {
      steps: [
        { id: 'click-submit', kind: 'action', action: 'navigate', url: '/healed' },
      ],
      ambiguities: [],
    };
    const sessionEntries = new Map([
      [elementRefKey(PASSWORD), { exists: true, currentFingerprint: FINGERPRINT }],
      [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
      ...liveEntries(REPAIRED_SUBMIT, AFTER_SUBMIT),
    ]);
    let repairRequest: { readonly prompt: string; readonly context?: JsonValueT } | undefined;
    const scenario = await createScenario({
      prompt: SECRET_PROMPT,
      steps: originalSteps,
      grounding: {
        'fill-password': { kind: 'element', fingerprint: FINGERPRINT },
        'click-submit': { kind: 'element', fingerprint: FINGERPRINT },
        'click-after': { kind: 'element', fingerprint: FINGERPRINT },
      },
      secrets: new Map([['{{secrets.PASSWORD}}', 'correct-horse-battery-staple']]),
      sessionEntries,
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) {
          return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        }
        if (stage2Frontier(request) !== undefined) repairRequest = request;
        return { data: repair, raw: JSON.stringify(repair) };
      } }),
    });
    const originalPlanDigest = computePlanDigest(scenario.plan);
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: originalSteps.length });
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewrittenPlan = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    const rewrittenGrounding = JSON.parse(await scenario.storage.readText(GROUNDING)) as GroundingDocument;
    expect(rewrittenPlan.source.inputsDigest).toBe(scenario.plan.source.inputsDigest);
    expect(computePlanDigest(rewrittenPlan)).not.toBe(originalPlanDigest);
    expect(rewrittenGrounding.schemaVersion).toBe(GROUNDING_SCHEMA_VERSION);
    expect(rewrittenGrounding.planDigest).toBe(computePlanDigest(rewrittenPlan));
    expect(rewrittenGrounding.entries).toEqual({
      'fill-password': { kind: 'element', fingerprint: FINGERPRINT },
      'click-after': { kind: 'element', fingerprint: freshFingerprint(sessionEntries, AFTER_SUBMIT) },
    });
    expect(rewrittenPlan.steps.map((step) => step.id)).toEqual(['fill-password', 'click-submit', 'click-after']);
    expect(repairRequest?.prompt).toContain('Repair the requested failing plan step.');
    expect(repairRequest?.context).toMatchObject({
      trustedInputs: {
        testMd: normalizeTestMd(SECRET_PROMPT),
        targets: TARGETS,
        frontier: { stepId: 'click-submit', index: 1 },
      },
      untrustedReplayEvidence: {
        baselineFailure: {
          failingStep: expect.objectContaining({ id: 'click-submit' }),
          explanation: expect.any(String),
        },
      },
    });
  });

  it('retains a suffix-owned secret grant while replacing the failed middle step without full regeneration', async () => {
    const originalSteps = [
      Step.parse({ id: 'open-home', kind: 'action', action: 'navigate', url: '/' }),
      Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' }),
      Step.parse({ id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.PASSWORD}}', secretGrantSpan: { startLine: 1, endLine: 1 } }),
    ];
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request) !== undefined) {
        return {
          data: { steps: [{ id: 'repair-me', kind: 'action', action: 'navigate', url: '/healed' }], ambiguities: [] },
          raw: '{}',
        };
      }
      throw new Error('Full regeneration must not be requested for a valid suffix-owned grant.');
    });
    const events = createRecordingEventSink();
    const scenario = await createScenario({
      prompt: SECRET_PROMPT,
      steps: originalSteps,
      grounding: {},
      secrets: new Map([['{{secrets.PASSWORD}}', 'correct-horse-battery-staple']]),
      sessionEntries: liveEntries(PASSWORD),
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    const result = await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: 3 });
    expect(result.outcome.errors).toEqual([]);
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) === undefined && !request.prompt.startsWith('Confirm whether'))).toHaveLength(0);
    expect(events.emitted()).not.toContainEqual(expect.objectContaining({ type: 'heal-stage2-rejected', reason: 'secret-attribution' }));
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewritten = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    expect(rewritten.steps[2]).toMatchObject({ id: 'fill-password', secretGrantSpan: { startLine: 1, endLine: 1 } });
  });

  it('lets a Stage-2 replacement reclaim its replaced secret grant through its own citation', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request) === undefined) {
        throw new Error('Full regeneration must not be requested when the replacement claims its old grant.');
      }
      return {
        data: {
          steps: [{
            id: 'repair-ai',
            kind: 'ai',
            instruction: 'Complete sign-in.',
            instructionCoverage: [{
              id: 'dashboard-reached',
              kind: 'success',
              citation: 'When I submit valid credentials, I reach the dashboard.',
            }],
            verificationIntent: [{
              criterionId: 'dashboard-reached',
              assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
            }],
            secrets: [{ ref: '{{secrets.PASSWORD}}', citation: '@ambercast-secret {{secrets.PASSWORD}}' }],
          }],
          ambiguities: [],
        },
        raw: '{}',
      };
    });
    let agenticCalls = 0;
    const scenario = await createScenario({
      prompt: SECRET_PROMPT,
      steps: [Step.parse({
        id: 'repair-ai',
        kind: 'ai',
        instruction: 'Complete sign-in.',
        instructionCoverage: [{
          id: 'dashboard-reached',
          kind: 'success',
          sourceSpan: { startLine: 5, startColumn: 1, endLine: 5, endColumn: 56 },
        }],
        secrets: [{ ref: '{{secrets.PASSWORD}}', sourceSpan: { startLine: 1, endLine: 1 } }],
      })],
      grounding: {
        'repair-ai': {
          kind: 'ai',
          trace: {
            events: [],
            verification: [{ type: 'assert', check: 'element-visible', target: SUBMIT }],
            verificationCoverage: { 'dashboard-reached': 0 },
          },
        },
      },
      secrets: new Map([['{{secrets.PASSWORD}}', 'correct-horse-battery-staple']]),
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }]]),
      aiExecutor: createFakeAiExecutor({
        execute,
        executeAgentic: async (request) => {
          agenticCalls += 1;
          if (agenticCalls === 1) return { outcome: 'failure' };
          await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Dashboard' }, 'dashboard-reached');
          return { outcome: 'success' };
        },
      }),
    });
    const events = createRecordingEventSink();

    const result = await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(result.outcome.errors).toEqual([]);
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: 1 });
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined)).toHaveLength(1);
    expect(execute.mock.calls.find(([request]) => stage2Frontier(request) !== undefined)?.[0].context).toMatchObject({ trustedInputs: { frontier: { stepId: 'repair-ai', index: 0 } } });
    expect(events.emitted()).not.toContainEqual(expect.objectContaining({
      type: 'heal-stage2-rejected',
      reason: 'secret-attribution',
    }));
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
  });

  it('reuses one successfully resolved executor across tail repair and full regeneration', async () => {
    const executor = createFakeAiExecutor({ execute: async (request) => {
      if (request.prompt.startsWith('Confirm whether')) {
        return { data: { confirmed: true }, raw: '{"confirmed":true}' };
      }
      return stage2Frontier(request) === undefined
        ? {
          data: { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] },
          raw: '{}',
        }
        : {
          data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] },
          raw: '{}',
        };
    } });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'click-submit', kind: 'action', action: 'navigate', url: 'http://[' })],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
    });
    const resolveAiExecutor = vi.fn(async () => executor);

    const result = await heal({ ...scenario.deps, resolveAiExecutor }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed' });
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
  });

  it('propagates an unclassified Stage-2 resolver failure as a case-scoped unexpected crash without Stage 3', async () => {
    const executor = createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether')
      ? { data: { confirmed: true }, raw: '{"confirmed":true}' }
      : {
        data: { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] },
        raw: '{}',
      } });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
    });
    const resolveAiExecutor = vi.fn(async () => {
      if (resolveAiExecutor.mock.calls.length === 1) throw new Error('Provider is temporarily unavailable.');
      return executor;
    });

    const result = await heal({ ...scenario.deps, resolveAiExecutor }, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([
      expect.objectContaining({ file: OPTIONS.files[0], error: expect.any(UnexpectedCrashError) }),
    ]);
    expect(resolveAiExecutor).toHaveBeenCalledOnce();
    expect(result.commits.size).toBe(0);
  });

  it('propagates an initial Stage-2 resolver failure as a case-scoped unexpected crash without Stage 3', async () => {
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
      ]),
    });
    const resolveAiExecutor = vi.fn(async () => { throw new Error('Provider is temporarily unavailable.'); });

    const result = await heal({ ...scenario.deps, resolveAiExecutor }, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([
      expect.objectContaining({ file: OPTIONS.files[0], error: expect.any(UnexpectedCrashError) }),
    ]);
    expect(resolveAiExecutor).toHaveBeenCalledOnce();
    expect(result.commits.size).toBe(0);
  });

  it('propagates an unclassified Stage-2 executor failure as a case-scoped unexpected crash without Stage 3', async () => {
    const execute = vi.fn(async () => { throw new Error('Provider is temporarily unavailable.'); });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([
      expect.objectContaining({ file: OPTIONS.files[0], error: expect.any(UnexpectedCrashError) }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.commits.size).toBe(0);
  });

  it('emits one typed Stage-2 provider rejection when executor resolution is classified unavailable', async () => {
    const events = createRecordingEventSink();
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
    });

    await heal({
      ...scenario.deps,
      events: events.sink,
      resolveAiExecutor: vi.fn(async () => { throw new AiExecutorUnavailableError('Unavailable.'); }),
    }, OPTIONS);

    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected')).toEqual([
      { type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'provider-error' },
    ]);
  });

  it('classifies an executor-thrown invalid response as provider-error before local response validation', async () => {
    const events = createRecordingEventSink();
    const execute = vi.fn(async () => { throw new AiResponseInvalidError('The provider response is invalid.'); });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(execute).toHaveBeenCalled();
    expect(events.emitted()).toContainEqual({ type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'provider-error' });
  });

  it.each([
    {
      label: 'a local response shape mismatch after a successful executor call',
      response: { steps: [], ambiguities: [] },
      reason: 'response-shape',
    },
    {
      label: 'a schema-valid replacement with the wrong ID',
      response: { steps: [{ id: 'wrong-id', kind: 'action', action: 'navigate', url: '/healed' }], ambiguities: [] },
      reason: 'id-mismatch',
    },
  ] as const)('emits $reason for $label', async ({ response, reason }) => {
    const events = createRecordingEventSink();
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw: JSON.stringify(response) }) }),
    });

    await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(events.emitted()).toContainEqual({ type: 'heal-stage2-rejected', stepId: 'repair-me', reason });
  });

  it.each([
    { label: 'strict local parsing rejects non-object data', response: [] },
    { label: 'the replacement list is empty', response: { steps: [], ambiguities: [] } },
    {
      label: 'the replacement list contains two steps',
      response: {
        steps: [
          { id: 'repair-me', kind: 'action', action: 'navigate', url: '/one' },
          { id: 'second', kind: 'action', action: 'navigate', url: '/two' },
        ],
        ambiguities: [],
      },
    },
  ])('independently reaches response-shape when $label', async ({ response }) => {
    const events = createRecordingEventSink();
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response as JsonValueT, raw: JSON.stringify(response) }) }),
    });

    await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(events.emitted()).toContainEqual({ type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'response-shape' });
  });

  it.each([
    {
      reason: 'secret-attribution',
      prompt: SECRET_PROMPT,
      steps: [
        Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' }),
        Step.parse({ id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.PASSWORD}}', secretGrantSpan: { startLine: 1, endLine: 1 } }),
      ],
      replacement: {
        id: 'repair-me',
        kind: 'action',
        action: 'fill-secret',
        target: PASSWORD,
        secretRef: '{{secrets.PASSWORD}}',
        citation: '@ambercast-secret {{secrets.PASSWORD}}',
      },
    },
    {
      reason: 'coverage-invalid',
      prompt: PROMPT,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      replacement: {
        id: 'repair-me',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        instructionCoverage: [{ id: 'dashboard', kind: 'success', citation: 'not present in the prompt' }],
        verificationIntent: [{ criterionId: 'dashboard', assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' } }],
      },
    },
    {
      reason: 'obligation-mismatch',
      prompt: PROMPT,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      replacement: { id: 'repair-me', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
    },
    {
      reason: 'literal-secret',
      prompt: PROMPT,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      replacement: { id: 'repair-me', kind: 'action', action: 'navigate', url: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' },
    },
    {
      reason: 'no-advance',
      prompt: PROMPT,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      replacement: { id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' },
    },
  ] satisfies readonly {
    readonly reason: StageTwoRejectionReason;
    readonly prompt: string;
    readonly steps: readonly ReturnType<typeof Step.parse>[];
    readonly replacement: JsonValueT;
  }[])('independently reaches $reason after all preceding boundaries pass', async ({ reason, prompt, steps, replacement }) => {
    const events = createRecordingEventSink();
    const response = { steps: [replacement], ambiguities: [] };
    const parsedResponse = GeneratedPlanResponse.parse(response);
    expect(parsedResponse.steps).toHaveLength(1);
    expect(parsedResponse.steps[0]?.id).toBe('repair-me');
    const scenario = await createScenario({
      prompt,
      steps,
      grounding: {},
      secrets: new Map([['{{secrets.PASSWORD}}', 'correct-horse-battery-staple']]),
      sessionEntries: liveEntries(PASSWORD, REPAIRED_SUBMIT),
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw: JSON.stringify(response) }) }),
    });

    await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected')).toContainEqual({
      type: 'heal-stage2-rejected',
      stepId: 'repair-me',
      reason,
    });
  });

  it('preserves a non-provider AmbercastError thrown by Stage-2 resolver resolution', async () => {
    const classified = new StaleIrError('A classified non-provider failure escaped Stage 2.');
    const resolveAiExecutor = vi.fn(async () => { throw classified; });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
    });

    const result = await heal({ ...scenario.deps, resolveAiExecutor }, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([{ file: OPTIONS.files[0], error: classified }]);
    expect(resolveAiExecutor).toHaveBeenCalledOnce();
    expect(result.commits.size).toBe(0);
  });

  it.each([
    ['grounding readText', 'readText', GROUNDING],
    ['plan writeText', 'writeText', PLAN],
    ['grounding writeText', 'writeText', GROUNDING],
  ] as const)('classifies a Stage-2 %s rejection as FsIoError', async (_label, operation, rejectedPath) => {
    const storageFailure = new Error(`${operation} rejected for ${rejectedPath}`);
    let completedReplays = 0;
    replayRunObserver.afterRun = (_deps, storage) => {
      completedReplays += 1;
      if (completedReplays !== 2) return;
      const mutable = storage as StorageAdapter & {
        readText: StorageAdapter['readText'];
        writeText: StorageAdapter['writeText'];
      };
      if (operation === 'readText') {
        const original = mutable.readText;
        mutable.readText = async (path) => {
          if (path === rejectedPath) throw storageFailure;
          return original.call(storage, path);
        };
      } else {
        const original = mutable.writeText;
        mutable.writeText = async (path, content) => {
          if (path === rejectedPath) throw storageFailure;
          return original.call(storage, path, content);
        };
      }
    };
    const replacement = { steps: [{ id: 'repair-me', kind: 'action', action: 'navigate', url: '/healed' }], ambiguities: [] };
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: replacement, raw: JSON.stringify(replacement) }) }),
    });

    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toEqual([
      expect.objectContaining({ file: OPTIONS.files[0], error: expect.any(FsIoError) }),
    ]);
    expect(result.outcome.errors[0]?.error.cause).toBe(storageFailure);
    expect(result.commits.size).toBe(0);
  });

  it('orders a resolver-classified rejection without a Stage-2 ai-call', async () => {
    const events = createRecordingEventSink();
    const resolveAiExecutor = vi.fn(async () => { throw new AiExecutorUnavailableError('Unavailable.'); });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
    });

    await heal({ ...scenario.deps, events: events.sink, resolveAiExecutor }, OPTIONS);

    expect(events.emitted().filter((event) => (
      (event.type === 'ai-call' && event.stepId === 'repair-me')
      || event.type === 'heal-stage2-rejected'
    ))).toEqual([
      { type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'provider-error' },
    ]);
    expect(events.emitted().some((event) => event.type === 'ai-call')).toBe(false);
  });

  it('orders Stage-2 ai-call before an executor-classified rejection', async () => {
    const recording = createRecordingEventSink();
    const order: string[] = [];
    const events: EventSink = {
      emit(event: RunEvent): void {
        if (event.type === 'ai-call' && event.stepId === 'repair-me') order.push('ai-call');
        if (event.type === 'heal-stage2-rejected' && event.stepId === 'repair-me') order.push('rejection');
        recording.sink.emit(event);
      },
    };
    const execute = vi.fn(async () => {
      order.push('execute');
      throw new AiResponseInvalidError('Invalid provider response.');
    });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    await heal({ ...scenario.deps, events }, OPTIONS);

    expect(recording.emitted().filter((event) => (
      (event.type === 'ai-call' && event.stepId === 'repair-me')
      || event.type === 'heal-stage2-rejected'
    ))).toEqual([
      { type: 'ai-call', stepId: 'repair-me' },
      { type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'provider-error' },
    ]);
    expect(recording.emitted().filter((event) => (
      event.type === 'ai-call' && event.stepId === undefined
    ))).toEqual([
      { type: 'ai-call' },
    ]);
    expect(recording.emitted().filter((event) => event.type === 'step-start')).toEqual([
      { type: 'step-start', stepId: 'repair-me' },
      { type: 'step-start', stepId: 'repair-me' },
    ]);
    expect(order.slice(0, 3)).toEqual(['ai-call', 'execute', 'rejection']);
  });

  it('does not resolve, execute, or emit Stage-2 events when deadline admission rejects the dispatch', async () => {
    const events = createRecordingEventSink();
    const execute = vi.fn(async () => { throw new Error('The executor must remain unreachable.'); });
    const resolveAiExecutor = vi.fn(async () => createFakeAiExecutor({ execute }));
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
    });

    await heal({
      ...scenario.deps,
      events: events.sink,
      resolveAiExecutor,
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 0 } },
    }, OPTIONS);

    expect(resolveAiExecutor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected' || (event.type === 'ai-call' && event.stepId === 'repair-me'))).toEqual([]);
  });

  it('restores both buffered artifacts before emitting a no-advance rejection', async () => {
    const originalUrl = '/p239g5c-original';
    const candidateUrl = '/p239g5c-candidate';
    const recording = createRecordingEventSink();
    let stageTwoStorage: StorageAdapter | undefined;
    let completedReplays = 0;
    let observedCandidateBytes = false;
    let originalPlan!: string;
    let artifactsObservedAtRejection: Promise<readonly [string, string]> | undefined;
    replayRunObserver.afterRun = async (_deps, storage) => {
      completedReplays += 1;
      if (completedReplays === 2) stageTwoStorage = storage;
      const currentPlan = await storage.readText(PLAN);
      if (currentPlan.includes(candidateUrl)) observedCandidateBytes = true;
    };
    const events: EventSink = {
      emit(event: RunEvent): void {
        if (event.type === 'heal-stage2-rejected') {
          const storage = stageTwoStorage;
          if (storage === undefined) throw new Error('Stage-2 storage was not observed before rejection.');
          artifactsObservedAtRejection = Promise.all([
            storage.readText(PLAN),
            storage.readText(GROUNDING),
          ]) as Promise<[string, string]>;
        }
        recording.sink.emit(event);
      },
    };
    const response = { steps: [{ id: 'repair-me', kind: 'action', action: 'navigate', url: candidateUrl }], ambiguities: [] };
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: originalUrl })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: response, raw: JSON.stringify(response) }) }),
      browserDriver: vi.fn<HealDeps['browserDriver']>(() => createFakeBrowserDriver(() => createFakeBrowserSession(new Map(), {
        baseUrl: TARGETS.web.baseUrl,
        currentUrl: TARGETS.web.baseUrl,
        snapshot: healSnapshot(new Map()),
        onPerform() { throw new Error('The Stage-2 navigation fixture must remain at its failing frontier.'); },
      }))),
    });
    originalPlan = await scenario.storage.readText(PLAN);
    const originalGrounding = await scenario.storage.readText(GROUNDING);

    await heal({ ...scenario.deps, events }, OPTIONS);

    expect(observedCandidateBytes).toBe(true);
    expect(recording.emitted()).toContainEqual({ type: 'heal-stage2-rejected', stepId: 'repair-me', reason: 'no-advance' });
    expect(artifactsObservedAtRejection).toBeDefined();
    await expect(artifactsObservedAtRejection).resolves.toEqual([originalPlan, originalGrounding]);
  });

  it('passes only the first accepted replacement in the next Stage-2 repairHistory', async () => {
    const replacementRequests: { readonly context?: JsonValueT }[] = [];
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: JsonValueT }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const frontier = stage2Frontier(request);
      if (frontier !== undefined) {
        replacementRequests.push({ context: structuredClone(request.context!) });
        const response = frontier.index === 0
          ? { steps: [{ id: 'first', kind: 'action', action: 'navigate', url: '/first-healed' }], ambiguities: [] }
          : { steps: [{ id: 'second', kind: 'action', action: 'navigate', url: 'http://[' }], ambiguities: [] };
        return { data: response, raw: JSON.stringify(response) };
      }
      return {
        data: { steps: [{ id: 'full', kind: 'action', action: 'navigate', url: 'http://[' }], ambiguities: [] },
        raw: '{}',
      };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'first', kind: 'action', action: 'navigate', url: 'http://[' }),
        Step.parse({ id: 'second', kind: 'action', action: 'navigate', url: 'http://[' }),
      ],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    await heal(scenario.deps, OPTIONS);

    expect(replacementRequests).toHaveLength(2);
    expect(replacementRequests[0]?.context).toMatchObject({ trustedInputs: { repairHistory: [] } });
    expect(replacementRequests[1]?.context).toMatchObject({
      trustedInputs: { repairHistory: [{
        stepId: 'first',
        before: { id: 'first', kind: 'action', action: 'navigate', url: 'http://[' },
        after: { id: 'first', kind: 'action', action: 'navigate', url: '/first-healed' },
        fromFirstFailureIndex: 0,
        toFirstFailureIndex: 1,
        failureCategory: 'action',
      }] },
    });
  });

  it('treats a pre-launch replay as unresolved at the -1 sentinel after every repair replay also fails', async () => {
    const scenario = await createScenario({ launchFailure: true });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', baselineFirstFailureIndex: -1, finalFirstFailureIndex: -1 });
    expect(scenario.deps.resolveAiExecutor).toHaveBeenCalledTimes(1);
  });

  it('uses Stage 3 binary success against its regenerated plan when Stage 2 cannot produce a usable tail', async () => {
    const stage2Invalid: GeneratedPlanResponse = {
      steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const stage3Replacement: GeneratedPlanResponse = {
      steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    let call = 0;
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'navigate', url: 'http://[' }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) {
          return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        }
        const response = call++ === 0 ? stage2Invalid : stage3Replacement;
        return { data: response, raw: JSON.stringify(response) };
      } }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalFirstFailureIndex: 1 });
    const commit = result.commits.get(OPTIONS.files[0]!);
    await expect(commit?.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewrittenPlan = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    expect(rewrittenPlan.steps).toHaveLength(1);
    expect(rewrittenPlan.steps[0]?.id).toBe('regenerated-submit');
  });

  it('keeps a no-changes-needed sibling artifacts write-isolated from a Stage-3 regeneration', async () => {
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';
    const stage2Invalid: GeneratedPlanResponse = {
      steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const stage3Replacement: GeneratedPlanResponse = {
      steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    let repairCall = 0;
    const sessionEntries = new Map([
      [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
      ...liveEntries(REPAIRED_SUBMIT),
    ]);
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'navigate', url: 'http://[' }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries,
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) {
          return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        }
        const response = repairCall++ === 0 ? stage2Invalid : stage3Replacement;
        return { data: response, raw: JSON.stringify(response) };
      } }),
    });
    const secondPlan = PlanDocument.parse({
      schemaVersion: 2,
      source: scenario.plan.source,
      targets: TARGETS,
      steps: [Step.parse({ id: 'click-continue', kind: 'action', action: 'click', target: REPAIRED_SUBMIT })],
    });
    const secondGrounding: GroundingDocument = {
      schemaVersion: 1,
      planDigest: computePlanDigest(secondPlan),
      entries: {
        'click-continue': { kind: 'element', fingerprint: freshFingerprint(sessionEntries, REPAIRED_SUBMIT) },
      },
    };
    const secondPlanPath = scenario.deps.layout.planPathFor(second);
    const secondGroundingPath = scenario.deps.layout.groundingPathFor(second);
    await scenario.storage.writeText(second, PROMPT);
    await scenario.storage.writeText(secondPlanPath, toCanonicalArtifactText(secondPlan as JsonValueT));
    await scenario.storage.writeText(secondGroundingPath, toCanonicalArtifactText(secondGrounding as JsonValueT));
    const [planBefore, groundingBefore] = await Promise.all([
      scenario.storage.readText(secondPlanPath),
      scenario.storage.readText(secondGroundingPath),
    ]);
    scenario.textWrites.mockClear();

    const result = await heal(scenario.deps, { ...OPTIONS, files: [first, second] });

    expect(repairCall).toBe(2);
    expect(result.outcome.results).toEqual([
      expect.objectContaining({ file: first, repairOutcome: 'healed' }),
      expect.objectContaining({ file: second, repairOutcome: 'no-changes-needed' }),
    ]);
    await expect(Promise.all([
      scenario.storage.readText(secondPlanPath),
      scenario.storage.readText(secondGroundingPath),
    ])).resolves.toEqual([planBefore, groundingBefore]);
    expect(scenario.textWrites).not.toHaveBeenCalledWith(secondPlanPath, expect.any(String));
    expect(scenario.textWrites).not.toHaveBeenCalledWith(secondGroundingPath, expect.any(String));
  });

  it('classifies a non-passing Stage-3 regeneration as unresolved even when it advances beyond the baseline', async () => {
    const stage2Invalid: GeneratedPlanResponse = {
      steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const stage3Replacement: GeneratedPlanResponse = {
      steps: [
        { id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
        { id: 'regenerated-after', kind: 'action', action: 'click', target: AFTER_SUBMIT },
      ],
      ambiguities: [],
    };
    let call = 0;
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'navigate', url: 'http://[' }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) {
          return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        }
        const response = call++ === 0 ? stage2Invalid : stage3Replacement;
        return { data: response, raw: JSON.stringify(response) };
      } }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({
      repairOutcome: 'unresolved', baselineFirstFailureIndex: 0, finalFirstFailureIndex: 0,
    });
    expect(result.commits.size).toBe(0);
  });

  it.each([
    {
      title: 'an unavailable executor rejection',
      createDeps: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        resolveAiExecutor: vi.fn(async () => { throw new AiExecutorUnavailableError('The executor is unavailable.'); }),
      }),
      error: AiExecutorUnavailableError,
    },
    {
      title: 'an invalid generated response',
      createDeps: async (scenario: HealScenario): Promise<HealDeps> => ({
        ...scenario.deps,
        resolveAiExecutor: vi.fn(async () => createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Repair the requested')
          ? { data: { steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' }
          : { data: { steps: 'not-an-array', ambiguities: [] }, raw: '{"steps":"not-an-array"}' } })),
      }),
      error: AiResponseInvalidError,
    },
  ])('preserves Stage 3 classification for $title', async ({ createDeps, error }) => {
    const scenario = await createScenario({ grounding: {} });
    const result = await heal(await createDeps(scenario), OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved' });
    expect(result.outcome.results[0]?.stage3Error).toBeInstanceOf(error);
  });

  it('reports an empty plan as no-changes-needed without treating it as a pre-launch failure', async () => {
    const scenario = await createScenario({ steps: [], grounding: {} });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results).toEqual([expect.objectContaining({
      repairOutcome: 'no-changes-needed', baselineFirstFailureIndex: 0, finalFirstFailureIndex: 0,
    })]);
    expect(result.commits.size).toBe(0);
  });

  it('rejects a fail-fast Stage-3 regression and never offers its candidate for commit', async () => {
    const stage2Invalid: GeneratedPlanResponse = {
      steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const regressedPlan: GeneratedPlanResponse = {
      steps: [{ id: 'regressed-first-step', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [],
    };
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-password', kind: 'action', action: 'click', target: PASSWORD }),
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
      ],
      grounding: {
        'click-password': { kind: 'element', fingerprint: FINGERPRINT },
        'click-submit': { kind: 'element', fingerprint: FINGERPRINT },
      },
      sessionEntries: new Map([
        [elementRefKey(PASSWORD), { exists: true, currentFingerprint: FINGERPRINT }],
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => ({
        data: request.prompt.startsWith('Repair the requested') ? stage2Invalid : regressedPlan,
        raw: '{}',
      }) }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({
      repairOutcome: 'unresolved', baselineFirstFailureIndex: 1, finalFirstFailureIndex: 1,
    });
    expect(result.commits.size).toBe(0);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  // @ts-expect-error Integrity failures expose no partially written artifacts because their pre-write comparison is fail-closed.
  const invalidIntegrityCommitOutcome: HealCommitOutcome = {
    outcome: 'failed',
    error: new IntegrityViolationError('artifacts changed before commit'),
    partiallyWritten: ['plan'],
  };
  void invalidIntegrityCommitOutcome;

  it('returns a commit capability only for healed or partially-healed candidates and never flushes during heal()', async () => {
    const scenario = await createScenario({
      sessionEntries: liveEntries(SUBMIT),
    });
    const result = await heal(scenario.deps, { ...OPTIONS, dryRun: false });

    expect(scenario.textWrites).not.toHaveBeenCalled();
    expect(result.outcome.results).toHaveLength(1);
    expect(result.outcome.results[0]?.repairOutcome).toBe('healed');
    expect([...result.commits.keys()]).toEqual([OPTIONS.files[0]]);
  });

  it('returns an integration-level zero-write integrity failure when the plan changes between heal preflight and commit', async () => {
    const scenario = await createScenario({ sessionEntries: liveEntries(SUBMIT) });
    const result = await heal(scenario.deps, { ...OPTIONS, dryRun: false });
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    await scenario.storage.writeText(PLAN, 'externally-mutated-after-preflight');
    scenario.textWrites.mockClear();

    const settled = await commit!.commit();
    expect(settled).toMatchObject({ outcome: 'failed', error: expect.any(IntegrityViolationError), partiallyWritten: [] });
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('returns an integration-level zero-write integrity failure when the plan is deleted between heal preflight and commit', async () => {
    const deletable = createDeletableStorage();
    const scenario = await createScenario({ storage: deletable.storage, sessionEntries: liveEntries(SUBMIT) });
    const result = await heal(scenario.deps, { ...OPTIONS, dryRun: false });
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    deletable.deleteFile(PLAN);
    await expect(scenario.storage.exists(PLAN)).resolves.toBe(false);
    scenario.textWrites.mockClear();

    const settled = await commit!.commit();
    expect(settled).toMatchObject({ outcome: 'failed', error: expect.any(IntegrityViolationError), partiallyWritten: [] });
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('compares plan then grounding before committing both buffered artifacts in that order', async () => {
    const base = createInMemoryStorage();
    const comparisons: string[] = [];
    let commitStarted = false;
    const storage: StorageAdapter = {
      ...base,
      async readBinary(path) {
        if (commitStarted && isTrackedArtifact(path)) comparisons.push(path);
        return base.readBinary(path);
      },
    };
    const scenario = await createBothArtifactRepairScenario(storage);
    const result = await heal(scenario.deps, OPTIONS);
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    scenario.textWrites.mockClear();
    commitStarted = true;

    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });

    expect(comparisons).toEqual([PLAN, GROUNDING]);
    expect(scenario.textWrites.mock.calls.map(([path]) => path)).toEqual([PLAN, GROUNDING]);
  });

  it.each([
    ['plan mismatch, grounding ok', 'mismatch', 'ok', ['plan']],
    ['plan missing, grounding ok', 'missing', 'ok', ['plan']],
    ['plan ok, grounding mismatch', 'ok', 'mismatch', ['grounding']],
    ['plan ok, grounding missing', 'ok', 'missing', ['grounding']],
    ['plan mismatch, grounding read error', 'mismatch', 'error', ['plan']],
    ['plan read error, grounding missing', 'error', 'missing', ['grounding']],
  ] as const)('gives integrity precedence with zero writes for %s while still comparing both sides', async (_label, planBehavior, groundingBehavior, mismatched) => {
    const base = createInMemoryStorage();
    const baseWriteText = vi.spyOn(base, 'writeText');
    const comparisons: string[] = [];
    let commitStarted = false;
    const storage: StorageAdapter = {
      ...base,
      async readBinary(path) {
        if (!commitStarted || !isTrackedArtifact(path)) return base.readBinary(path);
        comparisons.push(path);
        const behavior = path === PLAN ? planBehavior : groundingBehavior;
        if (behavior === 'missing') throw Object.assign(new Error(`${path} missing`), { code: 'ENOENT' });
        if (behavior === 'error') throw new Error(`${path} read failed`);
        const bytes = await base.readBinary(path);
        return behavior === 'mismatch' ? new Uint8Array([...bytes, 0]) : bytes;
      },
    };
    const scenario = await createBothArtifactRepairScenario(storage);
    baseWriteText.mockClear();
    const commit = (await heal(scenario.deps, OPTIONS)).commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    scenario.textWrites.mockClear();
    commitStarted = true;

    const outcome = await commit!.commit();

    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: expect.any(IntegrityViolationError),
      partiallyWritten: [],
    });
    if (outcome.outcome === 'failed') {
      expect(outcome.error).toMatchObject({ details: { mismatched } });
    }
    expect(comparisons).toEqual([PLAN, GROUNDING]);
    expect(baseWriteText).not.toHaveBeenCalled();
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it.each([
    ['plan read error, grounding ok', 'plan'],
    ['plan ok, grounding read error', 'grounding'],
  ] as const)('wraps %s as FsIoError only after both comparisons have been attempted', async (_label, failedSide) => {
    const base = createInMemoryStorage();
    const readFailure = new Error(`${failedSide} comparison failed`);
    const comparisons: string[] = [];
    let commitStarted = false;
    const storage: StorageAdapter = {
      ...base,
      async readBinary(path) {
        if (commitStarted && isTrackedArtifact(path)) {
          comparisons.push(path);
          if ((failedSide === 'plan' && path === PLAN) || (failedSide === 'grounding' && path === GROUNDING)) {
            throw readFailure;
          }
        }
        return base.readBinary(path);
      },
    };
    const scenario = await createBothArtifactRepairScenario(storage);
    const commit = (await heal(scenario.deps, OPTIONS)).commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    scenario.textWrites.mockClear();
    commitStarted = true;

    const outcome = await commit!.commit();

    expect(outcome).toMatchObject({ outcome: 'failed', error: expect.any(FsIoError), partiallyWritten: [] });
    if (outcome.outcome === 'failed') expect(outcome.error.cause).toBe(readFailure);
    expect(comparisons).toEqual([PLAN, GROUNDING]);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('preserves the plan read error when both comparisons fail without short-circuiting grounding', async () => {
    const base = createInMemoryStorage();
    const planFailure = new Error('plan comparison failed first');
    const groundingFailure = new Error('grounding comparison also failed');
    const comparisons: string[] = [];
    let commitStarted = false;
    const storage: StorageAdapter = {
      ...base,
      async readBinary(path) {
        if (!commitStarted || !isTrackedArtifact(path)) return base.readBinary(path);
        comparisons.push(path);
        throw path === PLAN ? planFailure : groundingFailure;
      },
    };
    const scenario = await createBothArtifactRepairScenario(storage);
    const commit = (await heal(scenario.deps, OPTIONS)).commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    scenario.textWrites.mockClear();
    commitStarted = true;

    const outcome = await commit!.commit();

    expect(outcome).toMatchObject({ outcome: 'failed', error: expect.any(FsIoError), partiallyWritten: [] });
    if (outcome.outcome === 'failed') expect(outcome.error.cause).toBe(planFailure);
    expect(comparisons).toEqual([PLAN, GROUNDING]);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('uses malformed UTF-8 bytes from the real validated snapshot as the commit preimage', async () => {
    const base = createInMemoryStorage();
    let commitStarted = false;
    const commitPreimage = { bytes: undefined as Uint8Array | undefined };
    const storage: StorageAdapter = {
      ...base,
      async readBinary(path) {
        if (commitStarted && path === PLAN && commitPreimage.bytes !== undefined) return new Uint8Array(commitPreimage.bytes);
        return base.readBinary(path);
      },
    };
    const repaired: GeneratedPlanResponse = {
      steps: [{ id: 'navigate-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' }],
      ambiguities: [],
    };
    const scenario = await createScenario({
      storage,
      steps: [Step.parse({ id: 'navigate-dashboard', kind: 'action', action: 'navigate', url: 'http://[�' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => ({ data: repaired, raw: JSON.stringify(repaired) }) }),
    });
    const canonicalBytes = await base.readBinary(PLAN);
    const replacementOffset = canonicalBytes.findIndex((byte, index) => byte === 0xef && canonicalBytes[index + 1] === 0xbf && canonicalBytes[index + 2] === 0xbd);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    const malformedPreimage = new Uint8Array([
      ...canonicalBytes.slice(0, replacementOffset),
      0x80,
      ...canonicalBytes.slice(replacementOffset + 3),
    ]);
    commitPreimage.bytes = new Uint8Array([
      ...canonicalBytes.slice(0, replacementOffset),
      0x81,
      ...canonicalBytes.slice(replacementOffset + 3),
    ]);
    expect(new TextDecoder().decode(malformedPreimage)).toBe(new TextDecoder().decode(commitPreimage.bytes));
    await base.writeBinary(PLAN, malformedPreimage);

    const result = await heal(scenario.deps, OPTIONS);
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    scenario.textWrites.mockClear();
    commitStarted = true;

    const outcome = await commit!.commit();

    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: expect.any(IntegrityViolationError),
      partiallyWritten: [],
    });
    if (outcome.outcome === 'failed') expect(outcome.error).toMatchObject({ details: { mismatched: ['plan'] } });
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error rejection', new Error('grounding storage is unavailable')],
    ['a non-Error rejection', 'grounding storage is unavailable'],
  ])('keeps the deliberate mid-write I/O contrast: %s still reports FsIoError with plan partially written', async (_label, rejection) => {
    const base = createInMemoryStorage();
    let rejectGroundingWrite = false;
    const storage: StorageAdapter = {
      ...base,
      async writeText(path, text) {
        if (rejectGroundingWrite && path === GROUNDING) {
          throw rejection;
        }
        return base.writeText(path, text);
      },
    };
    const scenario = await createScenario({
      storage,
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT, AFTER_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) {
          return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        }
        const repair: GeneratedPlanResponse = {
          steps: [
            { id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
            { id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT },
          ],
          ambiguities: [],
        };
        return { data: repair, raw: JSON.stringify(repair) };
      } }),
    });
    const result = await heal(scenario.deps, OPTIONS);
    const commit = result.commits.get(OPTIONS.files[0]!);

    expect(commit).toBeDefined();
    rejectGroundingWrite = true;
    const outcome = await commit!.commit();
    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome === 'failed') {
      expect(outcome.error).toBeInstanceOf(FsIoError);
      expect(outcome.partiallyWritten).toEqual(['plan']);
    }
  });

  it('adopts two advancing frontier replacements and settles healed without a Stage 3 request', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const frontier = stage2Frontier(request);
      return {
        data: {
          steps: frontier?.index === 0
            ? [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }]
            : [{ id: 'click-after', kind: 'action', action: 'click', target: REPAIRED_AFTER_SUBMIT }],
          ambiguities: [],
        },
        raw: '{}',
      };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT, REPAIRED_AFTER_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal(scenario.deps, OPTIONS);
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', stopReason: 'settled', finalFirstFailureIndex: 2 });
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined)).toHaveLength(2);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && stage2Frontier(request) === undefined)).toHaveLength(0);
  });

  it('discards a non-advancing candidate then makes exactly one Stage 3 request and no further Stage 2 request', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => request.prompt.startsWith('Confirm whether')
      ? { data: { confirmed: true }, raw: '{}' }
      : { data: stage2Frontier(request) === undefined ? { steps: [{ id: 'full', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] } : { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] }, raw: '{}' });
    const scenario = await createScenario({ sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]), aiExecutor: createFakeAiExecutor({ execute }) });
    await heal(scenario.deps, OPTIONS);
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined)).toHaveLength(1);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && stage2Frontier(request) === undefined)).toHaveLength(1);
  });

  it('routes a replay revisit of a visited frontier to Stage 3 without a second dispatch at that index', async () => {
    const sessionEntries = new Map([
      ...liveEntries(SUBMIT),
      [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
    ]);
    let replayCount = 0;
    replayRunObserver.afterRun = () => {
      replayCount += 1;
      if (replayCount === 2) sessionEntries.get(elementRefKey(SUBMIT))!.exists = false;
    };
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const frontier = stage2Frontier(request);
      return {
        data: {
          steps: frontier === undefined
            ? [
              { id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT },
              { id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT },
            ]
            : [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
          ambiguities: [],
        },
        raw: '{}',
      };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      grounding: {
        'click-submit': { kind: 'element', fingerprint: FINGERPRINT },
        'click-after': { kind: 'element', fingerprint: FINGERPRINT },
      },
      sessionEntries,
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    await heal(scenario.deps, OPTIONS);
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined)).toHaveLength(1);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && stage2Frontier(request) === undefined)).toHaveLength(1);
  });

  it('sends a -1 loop entry to Stage 3 with zero Stage 1 or Stage 2 dispatches', async () => {
    const execute = vi.fn(async () => ({ data: { steps: [], ambiguities: [] }, raw: '{}' }));
    const scenario = await createScenario({ launchFailure: true, aiExecutor: createFakeAiExecutor({ execute }) });
    await heal(scenario.deps, OPTIONS);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('reports attempt-limit before progress when the initial live measurement consumes the allowance', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request)?.index === 0) return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      throw new Error('Stage 3 remains unresolved.');
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } } }, OPTIONS);
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', stopReason: 'attempt-limit' });
  });

  it('keeps attempt-limit precedence when the initial live measurement embeds a repairable navigation error', async () => {
    const violation = new PlanNavigationResolutionError('The initial live measurement retained a repairable navigation error.');
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request)?.index === 0) return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      throw new Error('Stage 3 remains unresolved.');
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    let replayCalls = 0;
    replayRunObserver.afterRun = (_deps, _storage, options, outcome) => {
      replayCalls += 1;
      if (replayCalls === 2 && options.cacheOnly === false) {
        (outcome.results[0] as { error?: IntegrityViolationError } | undefined)!.error = violation;
      }
    };

    const result = await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } } }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ stopReason: 'attempt-limit' });
    expect(result.outcome.errors).toEqual([]);
  });

  it('reports partially-healed when a first Stage 2 advance exhausts the next frontier allowance', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const frontier = stage2Frontier(request);
      if (frontier?.index === 0) return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      return { data: { steps: [{ id: 'click-after', kind: 'action', action: 'click', target: REPAIRED_AFTER_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    const result = await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 2 } } }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'partially-healed', stopReason: 'attempt-limit' });
  });

  it('reports settled when an attempt-limit Stage 3 replay fully heals the plan', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const frontier = stage2Frontier(request);
      return {
        data: {
          steps: frontier === undefined
            ? [
              { id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
              { id: 'click-after', kind: 'action', action: 'click', target: REPAIRED_AFTER_SUBMIT },
            ]
            : [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }],
          ambiguities: [],
        },
        raw: '{}',
      };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT, REPAIRED_AFTER_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal({
      ...scenario.deps,
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } },
    }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', stopReason: 'settled', finalFirstFailureIndex: scenario.plan.steps.length });
  });

  it('reports attempt-limit with no prior advance and enters Stage 3', async () => {
    const scenario = await createScenario({
      steps: [AI_STEP],
      grounding: {},
      aiExecutor: createFakeAiExecutor({
        execute: async () => { throw new Error('Stage 3 remains unresolved.'); },
        executeAgentic: async () => ({ outcome: 'failure' }),
      }),
    });
    const result = await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } } }, OPTIONS);
    expect(result.outcome.results[0]).toMatchObject({ stopReason: 'attempt-limit' });
  });

  it('returns unresolved at a deadline before progress without entering Stage 3', async () => {
    let expired = false;
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      expired = true;
      return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal({ ...scenario.deps, clock: { now: () => new Date(), monotonicMs: () => expired ? 2 : 0 }, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1 } } }, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, finalFirstFailureIndex: outcome.finalFirstFailureIndex }).toEqual({ repairOutcome: 'unresolved', stopReason: 'deadline', finalFirstFailureIndex: 0 });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
  });

  it('keeps a progressed candidate committable after the next phase is deadline-denied', async () => {
    let stageTwoGenerationCompleted = false;
    let stageTwoCandidateReplayed = false;
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) {
        expect(stageTwoGenerationCompleted).toBe(true);
        return { data: { confirmed: true }, raw: '{}' };
      }
      if (stage2Frontier(request) !== undefined) stageTwoGenerationCompleted = true;
      return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    replayRunObserver.afterRun = (_deps, _storage, options) => {
      if (options.cacheOnly === false && stageTwoGenerationCompleted) stageTwoCandidateReplayed = true;
    };
    const clock = { now: () => new Date(), monotonicMs: () => stageTwoCandidateReplayed ? 2 : 0 };

    const result = await heal({ ...scenario.deps, clock, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1 } } }, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect(outcome).toMatchObject({ repairOutcome: 'partially-healed', stopReason: 'deadline' });
    expect(stageTwoGenerationCompleted).toBe(true);
    expect(stageTwoCandidateReplayed).toBe(true);
    expect(execute.mock.calls.some(([request]) => request.prompt.startsWith('Confirm whether'))).toBe(true);
    const commit = result.commits.get(OPTIONS.files[0]!);
    await expect(commit?.commit()).resolves.toEqual({ outcome: 'committed' });
  });

  it('returns unresolved at a deadline before progress without entering Stage 3', async () => {
    const scenario = await createScenario();
    const result = await heal({ ...scenario.deps, clock: { now: () => new Date(), monotonicMs: vi.fn().mockReturnValueOnce(0).mockReturnValue(2) }, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1 } } }, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, finalFirstFailureIndex: outcome.finalFirstFailureIndex }).toEqual({ repairOutcome: 'unresolved', stopReason: 'deadline', finalFirstFailureIndex: 0 });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
  });

  it('lets ai-retrace consume the final budget unit before any Stage 2 replacement dispatch', async () => {
    const execute = vi.fn(async (_request: { readonly context?: unknown }) => { throw new Error('Stage 3 remains unresolved.'); });
    const scenario = await createScenario({ steps: [AI_STEP], grounding: {}, aiExecutor: createFakeAiExecutor({ execute, executeAgentic: async () => ({ outcome: 'failure' }) }) });
    const result = await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } } }, OPTIONS);
    expect(result.outcome.results[0]).toMatchObject({ stopReason: 'attempt-limit' });
    expect(execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined)).toHaveLength(0);
  });

  it('retains only the initial step-scoped ai-retrace event when the exhausted Stage 1 dispatch is denied', async () => {
    const recording = createRecordingEventSink();
    const execute = vi.fn(async (_request: { readonly context?: unknown }) => { throw new Error('Stage 3 remains unresolved.'); });
    const executeAgentic = vi.fn(async () => ({ outcome: 'failure' as const }));
    const scenario = await createScenario({ steps: [AI_STEP], grounding: {}, aiExecutor: createFakeAiExecutor({ execute, executeAgentic }) });

    const result = await heal({
      ...scenario.deps,
      events: recording.sink,
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } },
    }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ stopReason: 'attempt-limit' });
    expect(recording.emitted().filter((event) => event.type === 'ai-call' && event.stepId === 'ai-step')).toEqual([
      { type: 'ai-call', stepId: 'ai-step' },
    ]);
    expect(executeAgentic).toHaveBeenCalledOnce();
  });

  it('restores the best incremental candidate when Stage 3 replay does not fully pass', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request) !== undefined) {
        return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      }
      return { data: { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }, { id: 'regenerated-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({ steps: [Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }), Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT })], sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]), aiExecutor: createFakeAiExecutor({ execute }) });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, finalFirstFailureIndex: outcome.finalFirstFailureIndex }).toEqual({ repairOutcome: 'partially-healed', stopReason: 'settled', finalFirstFailureIndex: 1 });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(true);
  });

  it('restores the pre-Stage-3 best replay when the Stage-3 candidate has a repairable navigation failure', async () => {
    const violation = new PlanNavigationResolutionError('The regenerated candidate could not resolve its navigation.');
    const stage2Invalid: GeneratedPlanResponse = {
      steps: [{ id: 'wrong-id', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [],
    };
    const stage3Candidate: GeneratedPlanResponse = {
      steps: [
        { id: 'stage3-candidate-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
        { id: 'stage3-candidate-after', kind: 'action', action: 'click', target: AFTER_SUBMIT },
      ],
      ambiguities: [],
    };
    const scenario = await createScenario({
      steps: [
        Step.parse({ id: 'best-submit', kind: 'action', action: 'click', target: SUBMIT }),
        Step.parse({ id: 'best-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
      ],
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => {
        if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{"confirmed":true}' };
        const response = stage2Frontier(request) === undefined ? stage3Candidate : stage2Invalid;
        return { data: response, raw: JSON.stringify(response) };
      } }),
    });
    let injectedStage3CandidateReplay = false;
    replayRunObserver.afterRun = (_deps, _storage, options, outcome) => {
      const replay = outcome.results[0];
      if (options.cacheOnly === true || replay?.result.steps[0]?.id !== 'stage3-candidate-submit') return;
      (replay as { error?: IntegrityViolationError } | undefined)!.error = violation;
      injectedStage3CandidateReplay = true;
    };

    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;

    expect(injectedStage3CandidateReplay).toBe(true);
    expect({
      repairOutcome: outcome.repairOutcome,
      baselineFirstFailureIndex: outcome.baselineFirstFailureIndex,
      finalFirstFailureIndex: outcome.finalFirstFailureIndex,
      stage3Error: outcome.stage3Error,
    }).toEqual({
      repairOutcome: 'unresolved',
      baselineFirstFailureIndex: 0,
      finalFirstFailureIndex: 0,
      stage3Error: undefined,
    });
    expect(outcome.steps.map(({ id }) => id)).toEqual(['best-submit', 'best-after']);
    expect(result.commits.size).toBe(0);
  });

  it('classifies an unchanged no-Stage-3 measurement as no-changes-needed under R11', async () => {
    const scenario = await createScenario({ sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]) });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, baselineFirstFailureIndex: outcome.baselineFirstFailureIndex, finalFirstFailureIndex: outcome.finalFirstFailureIndex, stage3Error: outcome.stage3Error }).toEqual({ repairOutcome: 'no-changes-needed', stopReason: 'settled', baselineFirstFailureIndex: 1, finalFirstFailureIndex: 1, stage3Error: undefined });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
  });

  it('classifies a no-Stage-3 measurement that reaches plan length as healed under R11', async () => {
    const scenario = await createScenario({
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether') ? { data: { confirmed: true }, raw: '{}' } : { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' } }),
    });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, baselineFirstFailureIndex: outcome.baselineFirstFailureIndex, finalFirstFailureIndex: outcome.finalFirstFailureIndex, stage3Error: outcome.stage3Error }).toEqual({ repairOutcome: 'healed', stopReason: 'settled', baselineFirstFailureIndex: 0, finalFirstFailureIndex: 1, stage3Error: undefined });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(true);
  });

  it('classifies a no-Stage-3 measurement that advances but still fails as partially-healed under R11', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request)?.index === 0) {
        return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      }
      throw new AiResponseInvalidError('No further candidate is available.');
    });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }), Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT })],
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    // This fixture's frontier-0 Stage 2 candidate is admissible and succeeds,
    // strictly advancing the frontier to 1 before Stage 3 fails. Per F5h/G2, a
    // verified candidate that strictly advanced past baseline is retained rather
    // than discarded when a later phase fails, so the case settles as
    // partially-healed at the advanced index, matching this test's own title.
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, baselineFirstFailureIndex: outcome.baselineFirstFailureIndex, finalFirstFailureIndex: outcome.finalFirstFailureIndex, stage3Error: outcome.stage3Error }).toEqual({ repairOutcome: 'partially-healed', stopReason: 'settled', baselineFirstFailureIndex: 0, finalFirstFailureIndex: 1, stage3Error: expect.any(Error) });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(true);
  });

  it('classifies a no-Stage-3 measurement without advance as unresolved under R11', async () => {
    const scenario = await createScenario({ launchFailure: true });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, baselineFirstFailureIndex: outcome.baselineFirstFailureIndex, finalFirstFailureIndex: outcome.finalFirstFailureIndex, stage3Error: outcome.stage3Error }).toEqual({ repairOutcome: 'unresolved', stopReason: 'settled', baselineFirstFailureIndex: -1, finalFirstFailureIndex: -1, stage3Error: expect.any(Error) });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
  });

  it.each(['none', 'ai-retrace', 'element-reground'] as const)('varies provider dispatches by %s grounding recovery mode', async (mode) => {
    const execute = vi.fn(async (_request: { readonly context?: unknown }) => ({ data: { confirmed: false }, raw: '{}' }));
    const executeAgentic = vi.fn(async () => ({ outcome: 'failure' as const }));
    const step = mode === 'none'
      ? Step.parse({ id: 'navigate', kind: 'action', action: 'navigate', url: 'http://[' })
      : mode === 'ai-retrace'
        ? AI_STEP
        : Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT });
    const scenario = await createScenario({ steps: [step], grounding: {}, aiExecutor: createFakeAiExecutor({ execute, executeAgentic }) });
    await heal({ ...scenario.deps, config: { ...scenario.deps.config, heal: { caseTimeoutMs: 300_000, maxStepRepairs: 1 } } }, OPTIONS);
    const replacementDispatches = execute.mock.calls.filter(([request]) => stage2Frontier(request) !== undefined);
    const nonReplacementDispatches = execute.mock.calls.filter(([request]) => stage2Frontier(request) === undefined);
    const expected = mode === 'none'
      ? { replacement: 1, nonReplacement: 1, aiRetrace: 0 }
      : mode === 'ai-retrace'
        ? { replacement: 0, nonReplacement: 1, aiRetrace: 1 }
        : { replacement: 1, nonReplacement: 1, aiRetrace: 0 };
    expect({ replacement: replacementDispatches.length, nonReplacement: nonReplacementDispatches.length, aiRetrace: executeAgentic.mock.calls.length }).toEqual(expected);
  });

  it('deduplicates explicitly selected files before creating cases', async () => {
    const scenario = await createScenario({
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });

    const result = await heal(scenario.deps, { ...OPTIONS, files: [OPTIONS.files[0]!, OPTIONS.files[0]!] });

    expect(result.outcome.results).toHaveLength(1);
    expect(result.outcome.results.map((outcome) => outcome.file)).toEqual([OPTIONS.files[0]]);
  });

  it('does not perform a live replay or resolve AI when the cache-only baseline fully passes', async () => {
    const resolveAiExecutor = vi.fn(async () => createFakeAiExecutor());
    const replayModes: boolean[] = [];
    const scenario = await createScenario({
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });

    replayRunObserver.afterRun = (_deps, _storage, options) => { replayModes.push(options.cacheOnly === true); };

    const result = await heal({ ...scenario.deps, resolveAiExecutor }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'no-changes-needed', stopReason: 'settled' });
    expect(replayModes).toEqual([true]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
  });

  it('heals an element-reground frontier through Stage 2 and retains the proposed replacement', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    const result = await heal(scenario.deps, OPTIONS);
    const commit = result.commits.get(OPTIONS.files[0]!);

    expect(execute.mock.calls.some(([request]) => stage2Frontier(request) !== undefined)).toBe(true);
    await expect(commit?.commit()).resolves.toEqual({ outcome: 'committed' });
    const plan = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    expect(plan.steps[0]).toMatchObject({ id: 'click-submit', action: 'click', target: REPAIRED_SUBMIT });
  });

  it.each([
    ['accepts a locator-only replacement', 'click', true],
    ['rejects an obligation-changing replacement', 'navigate', false],
  ] as const)('%s for an element-reground Stage 2 candidate', async (_name, action, shouldCommit) => {
    const events = createRecordingEventSink();
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if (stage2Frontier(request) === undefined) throw new AiResponseInvalidError('No full-plan candidate is available.');
      return { data: { steps: [{ id: 'click-submit', kind: 'action', action, ...(action === 'click' ? { target: REPAIRED_SUBMIT } : { url: '/different-obligation' }) }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });

    const result = await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(execute.mock.calls.some(([request]) => stage2Frontier(request) !== undefined)).toBe(true);
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(shouldCommit);
    if (!shouldCommit) {
      expect(events.emitted()).toContainEqual({
        type: 'heal-stage2-rejected',
        stepId: 'click-submit',
        reason: 'obligation-mismatch',
      });
    }
  });

  it('restores the pre-phase snapshot when the deadline expires between Stage 2 dispatches', async () => {
    let expired = false;
    let deniedPhaseStorage: StorageAdapter | undefined;
    const events = createRecordingEventSink();
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (stage2Frontier(request) !== undefined) {
        expired = true;
        return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      }
      return { data: { confirmed: true }, raw: '{}' };
    });
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const originalPlan = await scenario.storage.readText(PLAN);
    const originalGrounding = await scenario.storage.readText(GROUNDING);
    replayRunObserver.afterRun = (_deps, storage, options) => {
      if (options.cacheOnly === false && expired) deniedPhaseStorage = storage;
    };

    const result = await heal({
      ...scenario.deps,
      events: events.sink,
      clock: { now: () => new Date(), monotonicMs: () => expired ? 2 : 0 },
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1 } },
    }, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', stopReason: 'deadline', finalFirstFailureIndex: 0 });
    expect(result.commits.size).toBe(0);
    expect(deniedPhaseStorage).toBeDefined();
    await expect(Promise.all([
      deniedPhaseStorage!.readText(PLAN),
      deniedPhaseStorage!.readText(GROUNDING),
    ])).resolves.toEqual([originalPlan, originalGrounding]);
    expect(events.emitted().filter((event) => event.type === 'ai-call' && event.stepId === 'click-submit')).toEqual([
      { type: 'ai-call', stepId: 'click-submit' },
    ]);
    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected')).toEqual([]);
  });

  it('starts the case deadline after preflight and does not charge preflight elapsed time', async () => {
    let preflightFinished = false;
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const resolveAiExecutor = vi.fn(async () => createFakeAiExecutor({ execute }));
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
    });
    const storage: StorageAdapter = {
      ...scenario.storage,
      async readTextSnapshot(path) {
        const snapshot = await scenario.storage.readTextSnapshot(path);
        if (path === GROUNDING) preflightFinished = true;
        return snapshot;
      },
    };
    const monotonicMs = vi.fn(() => preflightFinished ? 50_000 : 0);

    const result = await heal({
      ...scenario.deps,
      storage,
      resolveAiExecutor,
      clock: { now: () => new Date(), monotonicMs },
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1 } },
    }, OPTIONS);

    expect(preflightFinished).toBe(true);
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', stopReason: 'settled' });
    expect(execute.mock.calls.some(([request]) => stage2Frontier(request) !== undefined)).toBe(true);
    expect(resolveAiExecutor).toHaveBeenCalled();
    expect(monotonicMs.mock.calls.length).toBeGreaterThan(0);
  });

  it('gives the second file an independent deadline and commit capability after the first expires', async () => {
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';
    const firstPlan = PLAN;
    const firstGrounding = GROUNDING;
    let activeFile = first;
    const clockCalls = new Map<string, number>();
    const scenario = await createScenario({
      sessionEntries: new Map([
        [elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }],
        ...liveEntries(REPAIRED_SUBMIT),
      ]),
      aiExecutor: createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether')
        ? { data: { confirmed: true }, raw: '{}' }
        : { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' } }),
    });
    const secondPlan = scenario.deps.layout.planPathFor(second);
    const secondGrounding = scenario.deps.layout.groundingPathFor(second);
    await scenario.storage.writeText(second, await scenario.storage.readText(first));
    await scenario.storage.writeText(secondPlan, await scenario.storage.readText(PLAN));
    await scenario.storage.writeText(secondGrounding, await scenario.storage.readText(GROUNDING));
    const storage: StorageAdapter = {
      ...scenario.storage,
      async readTextSnapshot(path) {
        if (path === first || path === firstPlan || path === firstGrounding) activeFile = first;
        if (path === second || path === secondPlan || path === secondGrounding) activeFile = second;
        return scenario.storage.readTextSnapshot(path);
      },
    };
    const monotonicMs = vi.fn(() => {
      const calls = (clockCalls.get(activeFile) ?? 0) + 1;
      clockCalls.set(activeFile, calls);
      if (activeFile === first) return calls === 1 ? 0 : 2;
      return 100;
    });

    const result = await heal({
      ...scenario.deps,
      storage,
      clock: { now: () => new Date(), monotonicMs },
      config: { ...scenario.deps.config, heal: { caseTimeoutMs: 1, maxStepRepairs: 2 } },
    }, { ...OPTIONS, files: [first, second] });

    expect(result.outcome.results).toHaveLength(2);
    expect(result.outcome.results[0]).toMatchObject({ file: first, repairOutcome: 'unresolved', stopReason: 'deadline' });
    expect(result.outcome.results[1]).toMatchObject({ file: second, repairOutcome: 'healed', stopReason: 'settled' });
    expect(result.commits.has(first)).toBe(false);
    expect(result.commits.has(second)).toBe(true);
    expect(clockCalls.get(second)).toBeGreaterThan(0);
  });

  it('keeps the F5j dispatch-budget wording byte-identical across public surfaces', async () => {
    const sentence = 'Hard limit on real provider dispatches started during incremental repair. Charged at dispatch time regardless of outcome. Includes element confirmation dispatches. Excludes the cache-only baseline and Stage 3.';
    const [schema, cli, docs] = await Promise.all([
      readFile(new URL('../../../src/core/config/schema.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/cli/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../docs/configuration.md', import.meta.url), 'utf8'),
    ]);

    expect(schema).toContain(sentence);
    expect(cli).toContain(sentence);
    expect(docs).toContain(sentence);
  });
});

describe('heal interruption contract', () => {
  it('turns a pre-aborted batch into ordered pending identities without starting case work', async () => {
    const controller = new AbortController();
    controller.abort();
    const scenario = await createScenario({ signal: controller.signal });
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';

    const result = await heal(scenario.deps, { ...OPTIONS, files: [first, second] });

    expect(result.outcome).toMatchObject({ interrupted: true, results: [], errors: [] });
    expect(result.outcome.skipped).toEqual([{ file: first }, { file: second }]);
    expect(scenario.deps.browserDriver).not.toHaveBeenCalled();
    expect(scenario.deps.resolveAiExecutor).not.toHaveBeenCalled();
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('retains a completed first result and skips the remaining suffix after cancellation', async () => {
    const controller = new AbortController();
    const scenario = await createScenario({
      signal: controller.signal,
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';
    const originalPlan = await scenario.storage.readText(PLAN);
    const originalGrounding = await scenario.storage.readText(GROUNDING);
    await scenario.storage.writeText(second, PROMPT);
    await scenario.storage.writeText(scenario.deps.layout.planPathFor(second), originalPlan);
    await scenario.storage.writeText(scenario.deps.layout.groundingPathFor(second), originalGrounding);
    scenario.textWrites.mockClear();

    const originalMarkTerminal = BatchInterruptionTracker.prototype.markTerminal;
    let firstTerminalMarks = 0;
    const markTerminal = vi.spyOn(BatchInterruptionTracker.prototype, 'markTerminal').mockImplementation(function markTerminalAfterFirstCase(this: BatchInterruptionTracker, workKey) {
      originalMarkTerminal.call(this, workKey);
      if (workKey === first && ++firstTerminalMarks === 2) controller.abort();
    });

    try {
      const result = await heal(scenario.deps, { ...OPTIONS, files: [first, second] });

      expect(result.outcome).toMatchObject({ interrupted: true, errors: [] });
      expect(result.outcome.results).toHaveLength(1);
      expect(result.outcome.results[0]).toMatchObject({ file: first, repairOutcome: 'no-changes-needed' });
      expect(result.outcome.skipped).toEqual([{ file: second }]);
      expect(scenario.deps.browserDriver).toHaveBeenCalledOnce();
      expect(scenario.textWrites).not.toHaveBeenCalled();
    } finally {
      markTerminal.mockRestore();
    }
  });

  it('reports a case interrupted inside its own replay instead of dropping its identity', async () => {
    const controller = new AbortController();
    const entries = new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]);
    let releaseLaunch: ((session: BrowserSession) => void) | undefined;
    let notifyLaunchStarted: (() => void) | undefined;
    const launchStarted = new Promise<void>((resolve) => { notifyLaunchStarted = resolve; });
    const browserDriver = vi.fn<HealDeps['browserDriver']>(() => ({
      engine: 'chromium',
      launch: () => new Promise<BrowserSession>((resolve) => {
        releaseLaunch = resolve;
        notifyLaunchStarted?.();
      }),
    }));
    const scenario = await createScenario({ signal: controller.signal, sessionEntries: entries, browserDriver });
    const first = OPTIONS.files[0]!;
    const second = '/workspace/tests/second.test.md';

    const running = heal(scenario.deps, { ...OPTIONS, files: [first, second] });
    await launchStarted;
    controller.abort();
    releaseLaunch?.(createFakeBrowserSession(entries, {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
      snapshot: healSnapshot(entries),
    }));

    await expect(running).resolves.toMatchObject({
      outcome: {
        interrupted: true,
        results: [],
        errors: [],
        skipped: [{ file: first }, { file: second }],
      },
    });
    expect(browserDriver).toHaveBeenCalledOnce();
  });

  it('restores the Stage-1 snapshot when its replay is interrupted', async () => {
    const controller = new AbortController();
    let stageOneOverlay: { readonly readText: (path: string) => Promise<string> } | undefined;
    let releaseStageOne: ((session: BrowserSession) => void) | undefined;
    let markStageOneStarted: (() => void) | undefined;
    const stageOneStarted = new Promise<void>((resolve) => { markStageOneStarted = resolve; });
    let launches = 0;
    const browserDriver = vi.fn<HealDeps['browserDriver']>(() => ({
      engine: 'chromium',
      launch: () => {
        launches += 1;
        if (launches !== 2) {
          return Promise.resolve(createFakeBrowserSession(new Map(), {
            baseUrl: TARGETS.web.baseUrl,
            currentUrl: TARGETS.web.baseUrl,
            snapshot: healSnapshot(new Map()),
          }));
        }
        return new Promise<BrowserSession>((resolve) => {
          releaseStageOne = resolve;
          markStageOneStarted?.();
        });
      },
    }));
    const scenario = await createScenario({ signal: controller.signal, browserDriver });
    const originalGrounding = await scenario.storage.readText(GROUNDING);
    replayRunObserver.afterRun = async (_deps, storage, options) => {
      if (options.cacheOnly === false) stageOneOverlay = storage;
    };

    try {
      const running = heal(scenario.deps, OPTIONS);
      await stageOneStarted;
      controller.abort();
      releaseStageOne?.(createFakeBrowserSession(new Map(), {
        baseUrl: TARGETS.web.baseUrl,
        currentUrl: TARGETS.web.baseUrl,
        snapshot: healSnapshot(new Map()),
      }));

      await expect(running).resolves.toMatchObject({
        outcome: { interrupted: true, results: [], errors: [], skipped: [{ file: OPTIONS.files[0] }] },
      });
      expect(browserDriver).toHaveBeenCalledTimes(2);
      expect(stageOneOverlay).toBeDefined();
      await expect(stageOneOverlay!.readText(GROUNDING)).resolves.toBe(originalGrounding);
    } finally {
      replayRunObserver.afterRun = undefined;
    }
  });

  it('lets cancellation win over a simultaneous classifiable Stage-2 delegate failure without rejection, Stage 3, or retained writes', async () => {
    const controller = new AbortController();
    const events = createRecordingEventSink();
    const replacementRequests: Stage2RequestContext[] = [];
    const execute = vi.fn(async (request: { readonly context?: unknown }) => {
      replacementRequests.push(structuredClone(request.context as Stage2RequestContext));
      controller.abort();
      throw new AiResponseInvalidError('Provider response became invalid at cancellation.');
    });
    const scenario = await createScenario({
      signal: controller.signal,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const originalPlan = await scenario.storage.readText(PLAN);
    const originalGrounding = await scenario.storage.readText(GROUNDING);

    const result = await heal({ ...scenario.deps, events: events.sink }, OPTIONS);

    expect(result.outcome).toMatchObject({
      interrupted: true,
      results: [],
      errors: [],
      skipped: [{ file: OPTIONS.files[0] }],
    });
    expect(replacementRequests).toHaveLength(1);
    expect(replacementRequests[0]).toMatchObject({ trustedInputs: { frontier: { stepId: 'repair-me', index: 0 }, repairHistory: [] } });
    expect(events.emitted().filter((event) => event.type === 'ai-call' && event.stepId === 'repair-me')).toEqual([
      { type: 'ai-call', stepId: 'repair-me' },
    ]);
    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected')).toEqual([]);
    expect(result.commits.size).toBe(0);
    await expect(Promise.all([scenario.storage.readText(PLAN), scenario.storage.readText(GROUNDING)])).resolves.toEqual([originalPlan, originalGrounding]);
  });

  it('restores the Stage-2 snapshot when cancellation arrives during candidate replay', async () => {
    const controller = new AbortController();
    const events = createRecordingEventSink();
    const replacementRequests: Stage2RequestContext[] = [];
    let stageTwoOverlay: StorageAdapter | undefined;
    replayRunObserver.afterRun = (_deps, storage, options) => {
      if (options.cacheOnly === false && stageTwoOverlay === undefined) stageTwoOverlay = storage;
    };
    let launchCount = 0;
    let releaseCandidateReplay: ((session: BrowserSession) => void) | undefined;
    let markCandidateReplayStarted: (() => void) | undefined;
    const candidateReplayStarted = new Promise<void>((resolve) => { markCandidateReplayStarted = resolve; });
    const browserDriver = vi.fn<HealDeps['browserDriver']>(() => ({
      engine: 'chromium',
      launch: () => {
        launchCount += 1;
        if (launchCount !== 3) {
          return Promise.resolve(createFakeBrowserSession(new Map(), {
            baseUrl: TARGETS.web.baseUrl,
            currentUrl: TARGETS.web.baseUrl,
            snapshot: healSnapshot(new Map()),
          }));
        }
        return new Promise<BrowserSession>((resolve) => {
          releaseCandidateReplay = resolve;
          markCandidateReplayStarted?.();
        });
      },
    }));
    const response = { steps: [{ id: 'repair-me', kind: 'action', action: 'navigate', url: '/healed' }], ambiguities: [] };
    const execute = vi.fn(async (request: { readonly context?: unknown }) => {
      replacementRequests.push(structuredClone(request.context as Stage2RequestContext));
      return { data: response, raw: JSON.stringify(response) };
    });
    const scenario = await createScenario({
      signal: controller.signal,
      browserDriver,
      steps: [Step.parse({ id: 'repair-me', kind: 'action', action: 'navigate', url: 'http://[' })],
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const originalPlan = await scenario.storage.readText(PLAN);
    const originalGrounding = await scenario.storage.readText(GROUNDING);

    const running = heal({ ...scenario.deps, events: events.sink }, OPTIONS);
    await candidateReplayStarted;
    controller.abort();
    releaseCandidateReplay?.(createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
      snapshot: healSnapshot(new Map()),
    }));
    const result = await running;

    expect(result.outcome).toMatchObject({
      interrupted: true,
      results: [],
      errors: [],
      skipped: [{ file: OPTIONS.files[0] }],
    });
    expect(replacementRequests).toHaveLength(1);
    expect(replacementRequests[0]).toMatchObject({ trustedInputs: { frontier: { stepId: 'repair-me', index: 0 }, repairHistory: [] } });
    expect(events.emitted().filter((event) => event.type === 'ai-call' && event.stepId === 'repair-me')).toEqual([
      { type: 'ai-call', stepId: 'repair-me' },
    ]);
    expect(events.emitted().filter((event) => event.type === 'heal-stage2-rejected')).toEqual([]);
    expect(result.commits.size).toBe(0);
    expect(stageTwoOverlay).toBeDefined();
    await expect(Promise.all([stageTwoOverlay!.readText(PLAN), stageTwoOverlay!.readText(GROUNDING)])).resolves.toEqual([originalPlan, originalGrounding]);
  });

  it.each(['normal return', 'thrown preflight error'] as const)('disposes the interruption tracker after %s', async (mode) => {
    const dispose = vi.spyOn(BatchInterruptionTracker.prototype, 'dispose');
    const scenario = await createScenario();
    const deps = mode === 'normal return'
      ? scenario.deps
      : {
        ...scenario.deps,
        layout: { ...scenario.deps.layout, planPathFor: () => { throw new Error('preflight failed'); } },
      };

    try {
      if (mode === 'normal return') {
        await expect(heal(deps, { ...OPTIONS, files: [] , list: true })).resolves.toBeDefined();
      } else {
        await expect(heal(deps, OPTIONS)).resolves.toMatchObject({
          outcome: { errors: [expect.objectContaining({ file: OPTIONS.files[0] })] },
        });
      }
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      dispose.mockRestore();
    }
  });
});
