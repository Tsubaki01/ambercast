import { describe, expect, it, vi } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  type ElementRef,
  type GroundingDocument,
  type GeneratedPlanResponse,
  type JsonValueT,
  PlanDocument,
  Step,
  type Fingerprint,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { AssertOutcome, BrowserEngine, BrowserSession } from '#ports/browser.js';
import type { StorageAdapter } from '#ports/storage.js';
import {
  createHealOverlayStorage,
  heal,
  type HealDeps,
  type HealOptions,
} from '#usecases/heal.js';
import { BatchInterruptionTracker } from '#usecases/batch-interruption.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession, elementRefKey, type FakeBrowserSessionEntry } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const replayRunObserver = vi.hoisted(() => ({
  afterRun: undefined as undefined | ((storage: { readonly readText: (path: string) => Promise<string> }, options: { readonly cacheOnly?: boolean }) => void | Promise<void>),
}));

vi.mock('#usecases/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#usecases/run.js')>();
  return {
    ...actual,
    run: async (...args: Parameters<typeof actual.run>) => {
      const outcome = await actual.run(...args);
      await replayRunObserver.afterRun?.(args[0].storage, args[1]);
      return outcome;
    },
  };
});

const PLAN = '/workspace/tests/login.ambercast.plan.json';
const GROUNDING = '/workspace/tests/login.ambercast.grounding.json';
const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) };
const SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Submit' };
const REPAIRED_SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Continue' };
const AFTER_SUBMIT = { strategy: 'accessibility' as const, role: 'button', name: 'Open dashboard' };
const PASSWORD = { strategy: 'accessibility' as const, role: 'textbox', name: 'Password' };
const SECRET_PROMPT = '@ambercast-secret {{secrets.PASSWORD}}\n\n# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const OPTIONS: HealOptions = {
  files: ['/workspace/tests/login.test.md'],
  dryRun: false,
  yes: false,
  list: false,
};

/**
 * Mirrors the live accessibility evidence independently from grounded-entry
 * verification. Route-B resolution reads this tree, whereas session entries
 * model the existing-grounding verification path.
 */
function healAccessibilityTree(entries: ReadonlyMap<string, FakeBrowserSessionEntry>): JsonValueT {
  const targets = [PASSWORD, SUBMIT, REPAIRED_SUBMIT, AFTER_SUBMIT];
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

function recordingStorage(): { readonly storage: StorageAdapter; readonly textWrites: ReturnType<typeof vi.fn>; } {
  const base = createInMemoryStorage();
  const textWrites = vi.fn<StorageAdapter['writeText']>(base.writeText);
  return { storage: { ...base, writeText: textWrites }, textWrites };
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
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
        ci: { heal: false, updateGroundingCache: false },
        grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
      },
    },
  };
}

describe('createHealOverlayStorage', () => {
  it('reads buffered plan and grounding text and reports both paths as existing', async () => {
    const { storage: base } = recordingStorage();
    await base.writeText(PLAN, 'old-plan');
    await base.writeText(GROUNDING, 'old-grounding');
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING });

    await overlay.storage.writeText(PLAN, 'candidate-plan');
    await overlay.storage.writeText(GROUNDING, 'candidate-grounding');

    await expect(overlay.storage.readText(PLAN)).resolves.toBe('candidate-plan');
    await expect(overlay.storage.readText(GROUNDING)).resolves.toBe('candidate-grounding');
    await expect(overlay.storage.exists(PLAN)).resolves.toBe(true);
    await expect(overlay.storage.exists(GROUNDING)).resolves.toBe(true);
    await expect(base.readText(PLAN)).resolves.toBe('old-plan');
    await expect(base.readText(GROUNDING)).resolves.toBe('old-grounding');
  });

  it('passes every untracked storage operation through to the base adapter', async () => {
    const { storage: base } = recordingStorage();
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING });
    const evidence = '/workspace/tests/.runs/run/evidence.png';
    const otherText = '/workspace/tests/notes.txt';

    await overlay.storage.writeText(otherText, 'visible immediately');
    await overlay.storage.writeBinary(evidence, new Uint8Array([1, 2, 3]));
    await overlay.storage.ensureDir('/workspace/tests/.runs/run/empty');

    await expect(base.readText(otherText)).resolves.toBe('visible immediately');
    await expect(base.readBinary(evidence)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(overlay.storage.listFiles('/workspace/tests/.runs/run')).resolves.toEqual(['evidence.png']);
  });

  it('flushes no paths for an empty buffer', async () => {
    const { storage, textWrites } = recordingStorage();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING });

    await overlay.flush();

    expect(textWrites).not.toHaveBeenCalled();
    expect(overlay.hasBufferedWrites()).toBe(false);
  });

  it('flushes only grounding for an element-only Stage-1 candidate', async () => {
    const { storage, textWrites } = recordingStorage();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING });
    await overlay.storage.writeText(GROUNDING, 'stage-1-grounding');

    await overlay.flush();

    expect(textWrites).toHaveBeenCalledTimes(1);
    expect(textWrites).toHaveBeenCalledWith(GROUNDING, 'stage-1-grounding');
    await expect(storage.exists(PLAN)).resolves.toBe(false);
  });

  it('flushes plan before grounding for a Stage-2 or Stage-3 candidate', async () => {
    const { storage, textWrites } = recordingStorage();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING });
    await overlay.storage.writeText(PLAN, 'healed-plan');
    await overlay.storage.writeText(GROUNDING, 'healed-grounding');

    await overlay.flush();

    expect(textWrites.mock.calls).toEqual([[PLAN, 'healed-plan'], [GROUNDING, 'healed-grounding']]);
  });

  it('restores a snapshot and discards a partial Stage-3 pair before any commit', async () => {
    const { storage } = recordingStorage();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING });
    await overlay.storage.writeText(GROUNDING, 'stage-1-grounding');
    const snapshot = overlay.snapshot();
    await overlay.storage.writeText(PLAN, 'partially-generated-plan');

    overlay.restore(snapshot);

    await expect(overlay.storage.readText(GROUNDING)).resolves.toBe('stage-1-grounding');
    await expect(overlay.storage.exists(PLAN)).resolves.toBe(false);
    await overlay.flush();
    await expect(storage.exists(PLAN)).resolves.toBe(false);
    await expect(storage.readText(GROUNDING)).resolves.toBe('stage-1-grounding');
  });

  it('keeps base artifact bytes unchanged when a dry-run candidate is replayed only from the overlay', async () => {
    const { storage } = recordingStorage();
    await storage.writeText(PLAN, 'base-plan');
    await storage.writeText(GROUNDING, 'base-grounding');
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING });
    await overlay.storage.writeText(PLAN, 'stage-3-plan');
    await overlay.storage.writeText(GROUNDING, 'stage-3-grounding');

    // This is the storage boundary used by the Stage-3 replay: it must observe the
    // regenerated pair even though dry-run deliberately never invokes flush().
    await expect(Promise.all([overlay.storage.readText(PLAN), overlay.storage.readText(GROUNDING)]))
      .resolves.toEqual(['stage-3-plan', 'stage-3-grounding']);
    await expect(Promise.all([storage.readText(PLAN), storage.readText(GROUNDING)]))
      .resolves.toEqual(['base-plan', 'base-grounding']);
  });
});

describe('heal state-machine contract', () => {
  it('owns list-mode discovery without opening artifacts or creating commits', async () => {
    const scenario = await createScenario();
    const result = await heal(scenario.deps, { ...OPTIONS, list: true });

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.listed).toEqual([{ file: OPTIONS.files[0] }]);
    expect(result.commits.size).toBe(0);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

  it('returns no-changes-needed for a fully replayable trusted plan and never creates a commit', async () => {
    const scenario = await createScenario({
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: true, currentFingerprint: FINGERPRINT }]]),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results).toHaveLength(1);
    expect(result.outcome.results[0]).toMatchObject({
      repairOutcome: 'no-changes-needed', baselineReachedIndex: scenario.plan.steps.length,
      finalReachedIndex: scenario.plan.steps.length,
    });
    expect(result.commits.size).toBe(0);
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
    const result = await heal(deps, OPTIONS);

    expect(result.outcome.results).toEqual([]);
    expect(result.outcome.errors).toHaveLength(1);
    expect(result.outcome.errors[0]).toMatchObject({ file: OPTIONS.files[0] });
    expect(result.outcome.errors[0]?.error).toBeInstanceOf(error);
    expect(deps.browserDriver).not.toHaveBeenCalled();
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

    expect(result.outcome.results[0]).toMatchObject({ baselineReachedIndex: 0 });
    expect(scenario.deps.browserDriver).toHaveBeenCalledOnce();
    expect(writeBinary).toHaveBeenCalledOnce();
  });

  it('replays Stage 1 when an element-consuming failing step has no grounding entry', async () => {
    const scenario = await createScenario({
      grounding: {},
      aiExecutor: createFakeAiExecutor({ execute: async () => { throw new AiExecutorUnavailableError('AI is unavailable.'); } }),
    });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved' });
    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(2);
    expect(scenario.deps.resolveAiExecutor).toHaveBeenCalledOnce();
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

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalReachedIndex: 1 });
    expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(1);
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

    expect(scenario.deps.browserDriver).toHaveBeenCalledOnce();
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

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalReachedIndex: scenario.plan.steps.length });
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
    replayRunObserver.afterRun = async (storage, options) => {
      if (options.cacheOnly === false) stageOneOverlay = storage;
    };

    try {
      await heal(scenario.deps, OPTIONS);

      expect(scenario.deps.browserDriver).toHaveBeenCalledTimes(2);
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

  it('rewrites a Stage-2 tail while retaining prefix grounding and honoring a prefix-owned secret grant', async () => {
    const originalSteps = [
      Step.parse({ id: 'fill-password', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: '{{secrets.PASSWORD}}', secretGrantSpan: { startLine: 1, endLine: 1 } }),
      Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
      Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }),
    ];
    const repair: GeneratedPlanResponse = {
      steps: [
        { id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT },
        { id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT },
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
        repairRequest = request;
        return { data: repair, raw: JSON.stringify(repair) };
      } }),
    });
    const originalPlanDigest = computePlanDigest(scenario.plan);
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalReachedIndex: originalSteps.length });
    const commit = result.commits.get(OPTIONS.files[0]!);
    expect(commit).toBeDefined();
    await expect(commit!.commit()).resolves.toEqual({ outcome: 'committed' });
    const rewrittenPlan = PlanDocument.parse(JSON.parse(await scenario.storage.readText(PLAN)));
    const rewrittenGrounding = JSON.parse(await scenario.storage.readText(GROUNDING)) as GroundingDocument;
    expect(rewrittenPlan.source.inputsDigest).toBe(scenario.plan.source.inputsDigest);
    expect(computePlanDigest(rewrittenPlan)).not.toBe(originalPlanDigest);
    expect(rewrittenGrounding.planDigest).toBe(computePlanDigest(rewrittenPlan));
    expect(rewrittenGrounding.entries).toEqual({
      'fill-password': { kind: 'element', fingerprint: FINGERPRINT },
      'click-submit': { kind: 'element', fingerprint: freshFingerprint(sessionEntries, REPAIRED_SUBMIT) },
      'click-after': { kind: 'element', fingerprint: freshFingerprint(sessionEntries, AFTER_SUBMIT) },
    });
    expect(rewrittenPlan.steps.map((step) => step.id)).toEqual(['fill-password', 'click-submit', 'click-after']);
    expect(repairRequest?.prompt).toContain('Repair the requested failing plan tail.');
    expect(repairRequest?.context).toMatchObject({
      testMd: normalizeTestMd(SECRET_PROMPT),
      targets: TARGETS,
      replacement: {
        stepIds: ['click-submit', 'click-after'],
        startIndex: 1,
        prefix: [expect.objectContaining({ id: 'fill-password' })],
      },
      baselineFailure: {
        failingStep: expect.objectContaining({ id: 'click-submit' }),
        explanation: expect.any(String),
      },
    });
  });

  it('reuses one successfully resolved executor across tail repair and full regeneration', async () => {
    const executor = createFakeAiExecutor({ execute: async (request) => {
      if (request.prompt.startsWith('Confirm whether')) {
        return { data: { confirmed: true }, raw: '{"confirmed":true}' };
      }
      const context = request.context as { readonly replacement?: unknown };
      return context.replacement === undefined
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

  it('retries executor resolution for full regeneration when tail repair could not resolve one', async () => {
    const executor = createFakeAiExecutor({ execute: async (request) => request.prompt.startsWith('Confirm whether')
      ? { data: { confirmed: true }, raw: '{"confirmed":true}' }
      : {
        data: { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] },
        raw: '{}',
      } });
    const scenario = await createScenario({
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

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed' });
    expect(resolveAiExecutor).toHaveBeenCalledTimes(2);
  });

  it('treats a pre-launch replay as unresolved at the -1 sentinel after every repair replay also fails', async () => {
    const scenario = await createScenario({ launchFailure: true });
    const result = await heal(scenario.deps, OPTIONS);

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', baselineReachedIndex: -1, finalReachedIndex: -1 });
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
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
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

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', finalReachedIndex: 1 });
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
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
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
        Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }),
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
      repairOutcome: 'unresolved', baselineReachedIndex: 0, finalReachedIndex: 1,
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
      repairOutcome: 'no-changes-needed', baselineReachedIndex: 0, finalReachedIndex: 0,
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
      repairOutcome: 'unresolved', baselineReachedIndex: 1, finalReachedIndex: 0,
    });
    expect(result.commits.size).toBe(0);
    expect(scenario.textWrites).not.toHaveBeenCalled();
  });

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

  it.each([
    ['an Error rejection', new Error('grounding storage is unavailable')],
    ['a non-Error rejection', 'grounding storage is unavailable'],
  ])('reports a failed commit after %s without losing which artifact became visible', async (_label, rejection) => {
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
    replayRunObserver.afterRun = async (storage, options) => {
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
