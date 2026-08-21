import { describe, expect, it, vi } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type { Fingerprint, JsonValueT, PlanDocument, TraceRecord } from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { InstructionCoverageAiActionController } from '#ports/ai.js';
import type { AssertOutcome } from '#ports/browser.js';
import {
  inspectGroundingCoverageSource,
  run,
  type RunDeps,
  type RunOptions,
} from '#usecases/run.js';
import type { CoveredTraceRecord } from '#usecases/instruction-coverage-policy.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession, elementRefKey } from '../../doubles/fake-browser-session.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const TEST_DIR = '/workspace/instruction-coverage';
const RUNS_DIR = `${TEST_DIR}/.runs`;
const TEST_PATH = `${TEST_DIR}/covered.test.md`;
const PROMPT = '# Covered replay\n\nReach the dashboard.\n';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' as const } };
const OPTIONS: RunOptions = {
  files: [TEST_PATH],
  cacheOnly: false,
  allowEmpty: false,
  list: false,
  stale: 'fail',
};
const READY_ASSERTION = { type: 'assert' as const, check: 'text-visible' as const, text: 'Dashboard' };
const STATUS_TARGET = { strategy: 'accessibility' as const, role: 'status', name: 'Dashboard' };
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) };

interface RecordingStorage {
  readonly storage: StorageAdapter;
  readonly writes: { readonly path: string; readonly text: string }[];
  readonly binaryWrites: { readonly path: string; readonly bytes: Uint8Array }[];
  readonly ensuredDirectories: string[];
  resetMutations(): void;
}

function recordingStorage(): RecordingStorage {
  const backing = createInMemoryStorage();
  const writes: { path: string; text: string }[] = [];
  const binaryWrites: { path: string; bytes: Uint8Array }[] = [];
  const ensuredDirectories: string[] = [];
  return {
    writes,
    binaryWrites,
    ensuredDirectories,
    resetMutations() {
      writes.length = 0;
      binaryWrites.length = 0;
      ensuredDirectories.length = 0;
    },
    storage: {
      ...backing,
      async writeText(path, text) {
        writes.push({ path, text });
        await backing.writeText(path, text);
      },
      async writeBinary(path, bytes) {
        binaryWrites.push({ path, bytes: new Uint8Array(bytes) });
        await backing.writeBinary(path, bytes);
      },
      async ensureDir(path) {
        ensuredDirectories.push(path);
        await backing.ensureDir(path);
      },
    },
  };
}

type Criterion = {
  readonly id: string;
  readonly kind: 'success' | 'action';
  readonly sourceSpan: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
};

const DEFAULT_CRITERIA: readonly Criterion[] = [{
  id: 'dashboard-reached',
  kind: 'success',
  sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 21 },
}];

function coveredPlan(criteria: readonly Criterion[] = DEFAULT_CRITERIA): PlanDocument {
  return {
    schemaVersion: 2,
    source: {
      inputsDigest: computeInputsDigest({
        normalizedTestMd: normalizeTestMd(PROMPT),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        targetDefinitions: TARGETS,
      }),
    },
    targets: TARGETS,
    steps: [{
      id: 'reach-dashboard',
      kind: 'ai',
      instruction: 'Use the UI to satisfy the locally cited success condition.',
      instructionCoverage: criteria,
    }],
  } as unknown as PlanDocument;
}

function coveredTrace(overrides: Partial<TraceRecord & { verificationCoverage: Record<string, number> }> = {}) {
  return {
    events: [],
    verification: [READY_ASSERTION],
    verificationCoverage: { 'dashboard-reached': 0 },
    ...overrides,
  };
}

function duplicateReaderFailureGroundingRaw(plan: PlanDocument = coveredPlan()): string {
  const deepButValidJson = `${'['.repeat(15_000)}0${']'.repeat(15_000)}`;
  return `{"entries":{},"readerStress":${deepButValidJson},"planDigest":"${computePlanDigest(plan)}","schemaVersion":1}`;
}

async function arrangeArtifacts(
  storage: StorageAdapter,
  trace?: unknown,
  groundingText?: (grounding: JsonValueT) => string,
  plan: PlanDocument = coveredPlan(),
  additionalEntries: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const grounding = {
    schemaVersion: 1,
    planDigest: computePlanDigest(plan),
    entries: {
      ...additionalEntries,
      ...(trace === undefined ? {} : { 'reach-dashboard': { kind: 'ai', trace } }),
    },
  } as unknown as JsonValueT;
  await storage.writeText(TEST_PATH, PROMPT);
  await storage.writeText(layout.planPathFor(TEST_PATH), toCanonicalArtifactText(plan as unknown as JsonValueT));
  await storage.writeText(
    layout.groundingPathFor(TEST_PATH),
    groundingText?.(grounding) ?? toCanonicalArtifactText(grounding),
  );
}

async function arrangeRawGrounding(
  storage: StorageAdapter,
  entries: Record<string, unknown>,
  options: { readonly planDigest?: string; readonly raw?: string } = {},
): Promise<void> {
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const plan = coveredPlan();
  await storage.writeText(TEST_PATH, PROMPT);
  await storage.writeText(layout.planPathFor(TEST_PATH), toCanonicalArtifactText(plan as unknown as JsonValueT));
  await storage.writeText(
    layout.groundingPathFor(TEST_PATH),
    options.raw ?? toCanonicalArtifactText({
      schemaVersion: 1,
      planDigest: options.planDigest ?? computePlanDigest(plan),
      entries,
    } as unknown as JsonValueT),
  );
}

function scenario(
  recording: RecordingStorage,
  overrides: Partial<RunDeps> = {},
  assertOutcome: AssertOutcome = { passed: true },
  options: {
    readonly assertOutcomes?: readonly AssertOutcome[];
    readonly entries?: Map<string, { readonly exists: boolean; readonly currentFingerprint: Fingerprint }>;
    readonly captureValues?: Map<string, { readonly text: string; readonly value: string }>;
  } = {},
) {
  const session = createFakeBrowserSession(options.entries ?? new Map(), {
    baseUrl: TARGETS.web.baseUrl,
    currentUrl: TARGETS.web.baseUrl,
    assertOutcome,
    ...(options.captureValues === undefined ? {} : { captureValues: options.captureValues }),
    ...(options.assertOutcomes === undefined ? {} : { assertOutcomes: options.assertOutcomes }),
  });
  const browserDriver = vi.fn(() => createFakeBrowserDriver(() => session));
  const resolveAiExecutor = vi.fn<RunDeps['resolveAiExecutor']>(async () => {
    throw new Error('The scenario did not permit AI resolution.');
  });
  const events = createRecordingEventSink();
  const deps: RunDeps = {
    storage: recording.storage,
    layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
    clock: createFixedClock(new Date('2026-08-21T00:00:00.000Z'), 0),
    runId: '2026-08-21T000000Z-550e8400-e29b-41d4-a716-446655440000',
    browserDriver,
    secrets: createFakeSecretsProvider(new Map()),
    resolveAiExecutor,
    events: events.sink,
    discoverTestFiles: async () => [],
    config: {
      testDir: TEST_DIR,
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/.runs/**'],
      targets: TARGETS,
      defaultTarget: 'web',
      ai: { provider: 'codex', timeoutMs: 1000 },
    },
    ...overrides,
  };
  return { deps, session, browserDriver, resolveAiExecutor, events };
}

describe('run instruction coverage trust boundary', () => {
  it('exports the covered replay capability boundary as a runtime function', async () => {
    const runModule = await import('#usecases/run.js');

    expect(typeof runModule.replayCoveredTraceWithoutAi).toBe('function');
  });

  it('replays valid covered evidence through only the narrow non-AI context', async () => {
    const { replayCoveredTraceWithoutAi } = await import('#usecases/run.js');
    expect(typeof replayCoveredTraceWithoutAi).toBe('function');
    if (typeof replayCoveredTraceWithoutAi !== 'function') return;
    const session = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
      assertOutcome: { passed: true },
    });

    await expect(replayCoveredTraceWithoutAi(coveredTrace() as unknown as CoveredTraceRecord, {
      session,
      target: TARGETS.web,
      runState: new Map(),
      secrets: createFakeSecretsProvider(new Map()),
      resolvedSecrets: new Map(),
      allowedRunRefs: new Set(),
    }, new Set())).resolves.toBe(true);
    expect(session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
  });

  it('observes cancellation before every covered replay event', async () => {
    const { replayCoveredTraceWithoutAi } = await import('#usecases/run.js');
    const controller = new AbortController();
    const reason = new Error('covered event replay cancelled');
    const session = createFakeBrowserSession(new Map(), {
      baseUrl: TARGETS.web.baseUrl,
      currentUrl: TARGETS.web.baseUrl,
      onPerform: () => controller.abort(reason),
    });
    const trace = {
      events: [
        { type: 'navigate' as const, url: '/first' },
        { type: 'navigate' as const, url: '/second' },
      ],
      verification: [],
      verificationCoverage: {},
    } as unknown as CoveredTraceRecord;

    await expect(replayCoveredTraceWithoutAi(trace, {
      session,
      target: TARGETS.web,
      runState: new Map(),
      secrets: createFakeSecretsProvider(new Map()),
      resolvedSecrets: new Map(),
      allowedRunRefs: new Set(),
      signal: controller.signal,
    }, new Set())).rejects.toBe(reason);
    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'navigate', url: '/first' } },
    ]);
  });

  it('observes cancellation before every covered replay verification', async () => {
    const { replayCoveredTraceWithoutAi } = await import('#usecases/run.js');
    const controller = new AbortController();
    const reason = new Error('covered verification replay cancelled');
    const session = createFakeBrowserSession(new Map(), {
      assertOutcomes: [{ passed: true }, { passed: true }],
      onEvaluateAssert: () => controller.abort(reason),
    });
    const trace = {
      events: [],
      verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Account' }],
      verificationCoverage: { 'dashboard-reached': 0, 'account-reached': 1 },
    } as unknown as CoveredTraceRecord;

    await expect(replayCoveredTraceWithoutAi(trace, {
      session,
      target: TARGETS.web,
      runState: new Map(),
      secrets: createFakeSecretsProvider(new Map()),
      resolvedSecrets: new Map(),
      allowedRunRefs: new Set(),
      signal: controller.signal,
    }, new Set())).rejects.toBe(reason);
    expect(session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
  });

  it.each([false, true])('replays valid covered evidence with zero AI calls in cacheOnly=%s', async (cacheOnly) => {
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, coveredTrace());
    recording.resetMutations();
    const arranged = scenario(recording);

    const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
    expect(arranged.events.emitted().filter(({ type }) => type === 'ai-call')).toEqual([]);
    expect(arranged.session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
    expect(recording.writes).toEqual([]);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
  });

  it('finalizes, persists, and replays a prototype-shaped success ID as an own coverage key', async () => {
    const criteria: readonly Criterion[] = [{
      id: 'constructor',
      kind: 'success',
      sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 21 },
    }];
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, undefined, undefined, coveredPlan(criteria));
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(READY_ASSERTION, 'constructor');
        return { outcome: 'success' };
      },
    });
    const first = scenario(recording, { resolveAiExecutor: async () => executor });

    await expect(run(first.deps, OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    expect(executor.agenticRequests).toHaveLength(1);
    expect(recording.writes).toHaveLength(1);
    const grounding = JSON.parse(recording.writes[0]!.text) as {
      entries: Record<string, { trace: { verificationCoverage: Record<string, number> } }>;
    };
    const coverage = grounding.entries['reach-dashboard']?.trace.verificationCoverage;
    expect(coverage).toEqual({ constructor: 0 });
    expect(Object.prototype.hasOwnProperty.call(coverage, 'constructor')).toBe(true);

    recording.resetMutations();
    const replay = scenario(recording);
    await expect(run(replay.deps, OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });
    expect(replay.resolveAiExecutor).not.toHaveBeenCalled();
    expect(replay.events.emitted().filter(({ type }) => type === 'ai-call')).toEqual([]);
    expect(recording.writes).toEqual([]);
  });

  it('scopes a reused success ID independently across two AI steps', async () => {
    const criterion: Criterion = {
      id: 'constructor',
      kind: 'success',
      sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 21 },
    };
    const basePlan = coveredPlan([criterion]);
    const plan = {
      ...basePlan,
      steps: [
        { ...basePlan.steps[0], id: 'first-ai' },
        { ...basePlan.steps[0], id: 'second-ai' },
      ],
    } as unknown as PlanDocument;
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, undefined, undefined, plan);
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(READY_ASSERTION, 'constructor');
        return { outcome: 'success' };
      },
    });
    const arranged = scenario(recording, { resolveAiExecutor: async () => executor });

    await expect(run(arranged.deps, OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    expect(executor.agenticRequests).toHaveLength(2);
    expect(recording.writes).toHaveLength(1);
    const grounding = JSON.parse(recording.writes[0]!.text) as {
      entries: Record<string, { trace: { verificationCoverage: Record<string, number> } }>;
    };
    expect(grounding.entries['first-ai']?.trace.verificationCoverage).toEqual({ constructor: 0 });
    expect(grounding.entries['second-ai']?.trace.verificationCoverage).toEqual({ constructor: 0 });
    expect(Object.prototype.hasOwnProperty.call(
      grounding.entries['first-ai']?.trace.verificationCoverage,
      'constructor',
    )).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(
      grounding.entries['second-ai']?.trace.verificationCoverage,
      'constructor',
    )).toBe(true);
  });

  it('pre-scans safe coverage-less legacy evidence before one normal-mode fallback', async () => {
    const recording = recordingStorage();
    const legacy = {
      events: [],
      verification: [{ ...READY_ASSERTION, text: 'Cached dashboard' }],
    };
    const criteria: readonly Criterion[] = [
      { id: 'reach-action', kind: 'action', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 } },
      { id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 21 } },
    ];
    await arrangeArtifacts(recording.storage, legacy, undefined, coveredPlan(criteria));
    recording.resetMutations();
    let receivedPriorTrace: unknown;
    const executeAgentic = vi.fn(async (request) => {
      receivedPriorTrace = request.priorTrace;
      await request.controller.evaluateAssert(READY_ASSERTION, 'dashboard-reached');
      return { outcome: 'success' as const };
    });
    const executor = createFakeAiExecutor({ executeAgentic });
    const resolveAiExecutor = vi.fn(async () => executor);
    const arranged = scenario(recording, { resolveAiExecutor });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(executeAgentic).toHaveBeenCalledTimes(1);
    expect(receivedPriorTrace).toEqual(legacy);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(executor.agenticRequests[0]).toMatchObject({
      trustedInstructionCoverage: [
        {
          id: 'reach-action',
          kind: 'action',
          sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 },
          text: 'Reach',
        },
        {
          id: 'dashboard-reached',
          kind: 'success',
          sourceSpan: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 21 },
          text: 'the dashboard.',
        },
      ],
    });
    expect(executor.agenticRequests[0]).not.toHaveProperty('verificationIntent');
    expect(executor.agenticRequests[0]).not.toHaveProperty('citation');
    expect(arranged.session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
    expect(recording.writes).toHaveLength(1);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
    const groundingPath = arranged.deps.layout.groundingPathFor(TEST_PATH);
    const groundingText = await recording.storage.readText(groundingPath);
    expect(recording.writes).toEqual([{ path: groundingPath, text: groundingText }]);
    const grounding = JSON.parse(groundingText) as {
      entries: Record<string, { trace: { verificationCoverage: Record<string, number> } }>;
    };
    expect(grounding.entries['reach-dashboard']?.trace.verificationCoverage).toEqual({
      'dashboard-reached': 0,
    });
    expect(grounding.entries['reach-dashboard']?.trace.verificationCoverage)
      .not.toHaveProperty('reach-action');
  });

  it('treats safe legacy evidence as a cache-only miss without AI or browser activity', async () => {
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, { events: [], verification: [READY_ASSERTION] });
    recording.resetMutations();
    const arranged = scenario(recording);

    const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly: true });

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result.steps[0]).toMatchObject({
      id: 'reach-dashboard',
      status: 'error',
    });
    expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
    expect(arranged.browserDriver).not.toHaveBeenCalled();
    expect(arranged.session.operations()).toEqual([]);
    expect(recording.writes).toEqual([]);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
  });

  it.each([false, true])(
    'rejects an unsafe legacy literal before provider or browser access in cacheOnly=%s',
    async (cacheOnly) => {
      const recording = recordingStorage();
      await arrangeArtifacts(recording.storage, {
        events: [{
          type: 'fill',
          target: { strategy: 'accessibility', role: 'textbox', name: 'Token' },
          value: 'sk-live-secret-value',
        }],
        verification: [READY_ASSERTION],
      });
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/secret|literal/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([false, true])(
    'fails a current-provenance noncanonical coverage claim before fallback in cacheOnly=%s',
    async (cacheOnly) => {
      const recording = recordingStorage();
      await arrangeArtifacts(
        recording.storage,
        coveredTrace(),
        (grounding) => JSON.stringify(grounding, null, 4),
      );
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|canonical/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([
    ['missing claim value', { verificationCoverage: {} }],
    ['wrong claim kind', { verificationCoverage: { 'dashboard-reached': '0' } }],
    ['unknown claim key', { verificationCoverage: { unknown: 0 } }],
    ['duplicate terminal index', {
      verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Account' }],
      verificationCoverage: { 'dashboard-reached': 0, extra: 0 },
    }],
    ['terminal gap', { verificationCoverage: { 'dashboard-reached': 1 } }],
    ['terminal URL vocabulary', {
      verification: [{ type: 'assert', check: 'url-matches', pattern: '/dashboard$' }],
    }],
    ['repeated event proof', { events: [READY_ASSERTION] }],
    ['unmapped terminal index', {
      verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Account ready' }],
      verificationCoverage: { 'dashboard-reached': 0 },
    }],
  ] as const)('fails closed for present %s coverage in normal and cache-only modes', async (_name, overrides) => {
    for (const cacheOnly of [false, true]) {
      const recording = recordingStorage();
      await arrangeArtifacts(recording.storage, coveredTrace(overrides as never));
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|verification|terminal/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    }
  });

  it.each([
    ['out-of-range span', [
      { id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 99, startColumn: 1, endLine: 99, endColumn: 2 } },
    ]],
    ['whitespace-only span', [
      { id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 1, startColumn: 17, endLine: 3, endColumn: 1 } },
    ]],
    ['noncanonical source ordering', [
      { id: 'dashboard-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 21 } },
      { id: 'reach-action', kind: 'action', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 } },
    ]],
  ] as const)('rejects %s committed coverage before every side effect in normal and cache-only modes', async (_name, criteria) => {
    for (const cacheOnly of [false, true]) {
      const recording = recordingStorage();
      await arrangeArtifacts(recording.storage, undefined, undefined, coveredPlan(criteria));
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/instruction|coverage|source span/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    }
  });

  it.each([
    ['malformed run reference in events', {
      events: [{ type: 'navigate', url: '/{{run.missing' }], verification: [READY_ASSERTION],
    }, /run|reference/i],
    ['ungranted run reference in events', {
      events: [{ type: 'navigate', url: '/{{run.missing}}' }], verification: [READY_ASSERTION],
    }, /run|grant|reference/i],
    ['malformed run reference in verification', {
      events: [], verification: [{ type: 'assert', check: 'text-visible', text: '{{run.}}' }],
    }, /run|reference/i],
    ['ungranted run reference in verification', {
      events: [], verification: [{ type: 'assert', check: 'text-visible', text: '{{run.missing}}' }],
    }, /run|grant|reference/i],
    ['ungranted secret reference in events', {
      events: [{ type: 'fill-secret', target: STATUS_TARGET, secretRef: '{{secrets.UNGRANTED}}' }],
      verification: [READY_ASSERTION],
    }, /secret|grant|reference/i],
    ['ungranted secret reference in verification', {
      events: [],
      verification: [{ type: 'assert', check: 'element-visible', target: { ...STATUS_TARGET, name: '{{secrets.UNGRANTED}}' } }],
    }, /secret|grant|reference/i],
    ['literal before ungranted fill-secret', {
      events: [
        { type: 'fill', target: STATUS_TARGET, value: 'sk-live-secret-value' },
        { type: 'fill-secret', target: STATUS_TARGET, secretRef: '{{secrets.UNGRANTED}}' },
      ],
      verification: [READY_ASSERTION],
    }, /secret|literal|grant/i],
  ] as const)(
    'fully pre-scans legacy %s before provider, browser, or storage mutation',
    async (_name, trace, message) => {
      for (const cacheOnly of [false, true]) {
        const recording = recordingStorage();
        await arrangeArtifacts(recording.storage, trace);
        recording.resetMutations();
        const arranged = scenario(recording);

        const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

        expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
        expect(outcome.results[0]?.error?.message).toMatch(message);
        expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
        expect(arranged.browserDriver).not.toHaveBeenCalled();
        expect(recording.writes).toEqual([]);
        expect(recording.binaryWrites).toEqual([]);
        expect(recording.ensuredDirectories).toEqual([]);
      }
    },
  );

  it.each([
    ['missing entry kind', { 'reach-dashboard': { trace: coveredTrace() } }],
    ['wrong entry kind', { 'reach-dashboard': { kind: 'element', trace: coveredTrace() } }],
    ['non-string entry kind', { 'reach-dashboard': { kind: 7, trace: coveredTrace() } }],
    ['invalid raw entry key', { 'Bad Entry': { kind: 'ai', trace: coveredTrace() } }],
    ['mixed claimed, legacy, and valid entries', {
      'reach-dashboard': { kind: 'ai', trace: coveredTrace() },
      'legacy-step': { kind: 'ai', trace: { events: [], verification: [READY_ASSERTION] } },
      'invalid-claim': {
        kind: 'ai',
        trace: coveredTrace({ verificationCoverage: { 'dashboard-reached': '0' } as never }),
      },
    }],
  ] as const)(
    'fails exact-path current coverage with %s before all side effects in normal and cache-only modes',
    async (_name, entries) => {
      for (const cacheOnly of [false, true]) {
        const recording = recordingStorage();
        await arrangeRawGrounding(recording.storage, entries);
        recording.resetMutations();
        const arranged = scenario(recording);

        const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

        expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
        expect(outcome.results[0]?.error?.message).toMatch(/coverage|grounding|verification/i);
        expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
        expect(arranged.browserDriver).not.toHaveBeenCalled();
        expect(arranged.session.operations()).toEqual([]);
        expect(recording.writes).toEqual([]);
        expect(recording.binaryWrites).toEqual([]);
        expect(recording.ensuredDirectories).toEqual([]);
      }
    },
  );

  it('classifies a duplicate-preserving reader failure after current provenance as integrity failure', () => {
    const plan = coveredPlan();
    const raw = duplicateReaderFailureGroundingRaw(plan);
    expect(() => JSON.parse(raw)).not.toThrow();

    expect(inspectGroundingCoverageSource(raw, computePlanDigest(plan))).toEqual({
      kind: 'integrity-failure',
      reason: 'coverage-structure-invalid',
    });
  });

  it.each([false, true])(
    'fails closed when current grounding provenance survives but raw claim inspection throws in cacheOnly=%s',
    async (cacheOnly) => {
      const recording = recordingStorage();
      await arrangeRawGrounding(recording.storage, {}, { raw: duplicateReaderFailureGroundingRaw() });
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|grounding|integrity/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([
    ['duplicate entry key', false, (covered: string, legacy: string) => [
      `"reach-dashboard":{"kind":"ai","trace":${covered}}`,
      `"reach-dashboard":{"kind":"ai","trace":${legacy}}`,
    ].join(',')],
    ['duplicate entry key', true, (covered: string, legacy: string) => [
      `"reach-dashboard":{"kind":"ai","trace":${covered}}`,
      `"reach-dashboard":{"kind":"ai","trace":${legacy}}`,
    ].join(',')],
    ['duplicate trace key', false, (covered: string, legacy: string) => [
      '"reach-dashboard":{"kind":"ai",',
      `"trace":${covered},"trace":${legacy}}`,
    ].join('')],
    ['duplicate trace key', true, (covered: string, legacy: string) => [
      '"reach-dashboard":{"kind":"ai",',
      `"trace":${covered},"trace":${legacy}}`,
    ].join('')],
  ] as const)(
    'rejects a raw %s that hides an earlier exact-path coverage claim behind legacy data in cacheOnly=%s',
    async (_name, cacheOnly, entriesBody) => {
      const recording = recordingStorage();
      const covered = JSON.stringify(coveredTrace());
      const legacy = JSON.stringify({ events: [], verification: [READY_ASSERTION] });
      const planDigest = computePlanDigest(coveredPlan());
      const raw = `{"entries":{${entriesBody(covered, legacy)}},"planDigest":"${planDigest}","schemaVersion":1}`;
      await arrangeRawGrounding(recording.storage, {}, { raw });
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|duplicate|grounding|verification/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([
    ['null', false, 'null'],
    ['null', true, 'null'],
    ['scalar', false, '7'],
    ['scalar', true, '7'],
    ['array', false, '[]'],
    ['array', true, '[]'],
  ] as const)(
    'rejects an earlier covered root entries occurrence hidden by later %s entries in cacheOnly=%s',
    async (_name, cacheOnly, laterEntries) => {
      const recording = recordingStorage();
      const coveredEntries = JSON.stringify({
        'reach-dashboard': { kind: 'ai', trace: coveredTrace() },
      });
      const planDigest = computePlanDigest(coveredPlan());
      const raw = `{"entries":${coveredEntries},"entries":${laterEntries},"planDigest":"${planDigest}","schemaVersion":1}`;
      await arrangeRawGrounding(recording.storage, {}, { raw });
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|duplicate|grounding|verification/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([
    ['cold miss', {}],
    ['legacy miss', {
      'first-ai': { kind: 'ai', trace: { events: [], verification: [READY_ASSERTION] } },
    }],
  ] as const)(
    'lets a later current-provenance invalid coverage claim outrank an earlier cache-only %s',
    async (_name, firstEntry) => {
      const basePlan = coveredPlan();
      const plan = {
        ...basePlan,
        steps: [
          { ...basePlan.steps[0], id: 'first-ai' },
          { ...basePlan.steps[0], id: 'second-ai' },
        ],
      } as unknown as PlanDocument;
      const recording = recordingStorage();
      await arrangeArtifacts(recording.storage, undefined, undefined, plan, {
        ...firstEntry,
        'second-ai': {
          kind: 'ai',
          trace: coveredTrace({ verificationCoverage: { unknown: 0 } }),
        },
      });
      recording.resetMutations();
      const arranged = scenario(recording);

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly: true });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(outcome.results[0]?.error?.message).toMatch(/coverage|verification|terminal/i);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(arranged.browserDriver).not.toHaveBeenCalled();
      expect(arranged.session.operations()).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
    },
  );

  it.each([
    ['event value', false, (sentinel: string) => ({
      events: [{ type: 'navigate', url: `/users/${sentinel}` }],
      verification: [READY_ASSERTION],
    }), undefined],
    ['event value', true, (sentinel: string) => ({
      events: [{ type: 'navigate', url: `/users/${sentinel}` }],
      verification: [READY_ASSERTION],
    }), undefined],
    ['verification value', false, (sentinel: string) => ({
      events: [],
      verification: [{ type: 'assert', check: 'text-visible', text: `Welcome ${sentinel}` }],
    }), undefined],
    ['verification value', true, (sentinel: string) => ({
      events: [],
      verification: [{ type: 'assert', check: 'text-visible', text: `Welcome ${sentinel}` }],
    }), undefined],
    ['locator value', false, (sentinel: string) => ({
      events: [{
        type: 'click',
        target: { strategy: 'accessibility', role: 'button', name: `Open ${sentinel}` },
      }],
      verification: [READY_ASSERTION],
    }), undefined],
    ['locator value', true, (sentinel: string) => ({
      events: [{
        type: 'click',
        target: { strategy: 'accessibility', role: 'button', name: `Open ${sentinel}` },
      }],
      verification: [READY_ASSERTION],
    }), undefined],
    ['short event substring', false, (sentinel: string) => ({
      events: [{ type: 'navigate', url: `/before-${sentinel}-after` }],
      verification: [READY_ASSERTION],
    }), 'Q7'],
    ['short event substring', true, (sentinel: string) => ({
      events: [{ type: 'navigate', url: `/before-${sentinel}-after` }],
      verification: [READY_ASSERTION],
    }), 'Q7'],
    ['short verification substring', false, (sentinel: string) => ({
      events: [],
      verification: [{ type: 'assert', check: 'text-visible', text: `before-${sentinel}-after` }],
    }), 'Q7'],
    ['short verification substring', true, (sentinel: string) => ({
      events: [],
      verification: [{ type: 'assert', check: 'text-visible', text: `before-${sentinel}-after` }],
    }), 'Q7'],
    ['short locator substring', false, (sentinel: string) => ({
      events: [{
        type: 'click',
        target: { strategy: 'accessibility', role: 'button', name: `before-${sentinel}-after` },
      }],
      verification: [READY_ASSERTION],
    }), 'Q7'],
    ['short locator substring', true, (sentinel: string) => ({
      events: [{
        type: 'click',
        target: { strategy: 'accessibility', role: 'button', name: `before-${sentinel}-after` },
      }],
      verification: [READY_ASSERTION],
    }), 'Q7'],
  ] as const)(
    'rejects a captured literal in legacy priorTrace %s before the AI-step boundary in cacheOnly=%s',
    async (_name, cacheOnly, traceFor, capturedValue) => {
      const sentinel = capturedValue ?? `CAPTURED-RUN-LITERAL-${_name.replaceAll(' ', '-')}`;
      if (capturedValue !== undefined) expect(sentinel).toHaveLength(2);
      const basePlan = coveredPlan();
      const plan = {
        ...basePlan,
        steps: [
          { id: 'capture-value', kind: 'capture', target: STATUS_TARGET, variable: 'captured' },
          ...basePlan.steps,
        ],
      } as unknown as PlanDocument;
      const recording = recordingStorage();
      await arrangeArtifacts(
        recording.storage,
        traceFor(sentinel),
        undefined,
        plan,
        { 'capture-value': { kind: 'element', fingerprint: FINGERPRINT } },
      );
      recording.resetMutations();
      const entries = new Map([[
        elementRefKey(STATUS_TARGET),
        { exists: true, currentFingerprint: FINGERPRINT },
      ]]);
      const executor = createFakeAiExecutor();
      const resolveAiExecutor = vi.fn(async () => executor);
      const arranged = scenario(recording, { resolveAiExecutor }, { passed: true }, {
        entries,
        captureValues: new Map([[
          elementRefKey(STATUS_TARGET),
          { text: sentinel, value: '' },
        ]]),
      });

      const outcome = await run(arranged.deps, { ...OPTIONS, cacheOnly });

      expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
      expect(arranged.resolveAiExecutor).not.toHaveBeenCalled();
      expect(executor.agenticRequests).toEqual([]);
      expect(arranged.session.operations().filter((operation) => (
        operation.type === 'perform'
        || operation.type === 'fill-secret'
        || operation.type === 'evaluate-assert'
        || JSON.stringify(operation).includes(sentinel)
      ))).toEqual([]);
      expect(recording.writes).toEqual([]);
      expect(recording.binaryWrites).toEqual([]);
      expect(recording.ensuredDirectories).toEqual([]);
      expect(JSON.stringify(outcome)).not.toContain(sentinel);
    },
  );

  it.each([
    ['event type', 'click', {
      events: [{ type: 'click', target: STATUS_TARGET }],
      verification: [{ ...READY_ASSERTION, text: 'Cached dashboard' }],
    }],
    ['verification check', 'text-visible', {
      events: [],
      verification: [{ ...READY_ASSERTION, text: 'Cached dashboard' }],
    }],
  ] as const)('does not scan captured values that occur only in legacy closed vocabulary %s', async (_name, captured, trace) => {
    const basePlan = coveredPlan();
    const plan = {
      ...basePlan,
      steps: [
        { id: 'capture-value', kind: 'capture', target: STATUS_TARGET, variable: 'captured' },
        ...basePlan.steps,
      ],
    } as unknown as PlanDocument;
    const recording = recordingStorage();
    await arrangeArtifacts(
      recording.storage,
      trace,
      undefined,
      plan,
      { 'capture-value': { kind: 'element', fingerprint: FINGERPRINT } },
    );
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(READY_ASSERTION, 'dashboard-reached');
        return { outcome: 'success' };
      },
    });
    const resolveAiExecutor = vi.fn(async () => executor);
    const arranged = scenario(recording, { resolveAiExecutor }, { passed: true }, {
      entries: new Map([[
        elementRefKey(STATUS_TARGET),
        { exists: true, currentFingerprint: FINGERPRINT },
      ]]),
      captureValues: new Map([[
        elementRefKey(STATUS_TARGET),
        { text: captured, value: '' },
      ]]),
    });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(executor.agenticRequests).toHaveLength(1);
    expect(executor.agenticRequests[0]?.priorTrace).toEqual(trace);
    expect(arranged.session.operations().filter(({ type }) => type === 'perform')).toEqual([]);
    expect(arranged.session.operations().filter(({ type }) => type === 'evaluate-assert')).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
    expect(JSON.stringify(outcome)).not.toContain(captured);
  });

  it.each([
    ['invalid JSON', { raw: '{' }],
    ['stale provenance with coverage', { planDigest: 'f'.repeat(64), entries: {
      'reach-dashboard': { kind: 'ai', trace: coveredTrace() },
    } }],
    ['unrelated nested verificationCoverage', { entries: {
      'reach-dashboard': {
        kind: 'ai',
        trace: {
          events: [{ type: 'navigate', url: '/', verificationCoverage: { 'dashboard-reached': 0 } }],
          verification: [READY_ASSERTION],
        },
      },
    } }],
    ['coverage-absent malformed trace', { entries: {
      'reach-dashboard': { kind: 'ai', trace: { events: 'malformed', verification: [] } },
    } }],
  ] as const)('treats %s as a whole-cache miss and never recovers a raw prior trace', async (_name, fixture) => {
    const recording = recordingStorage();
    if ('raw' in fixture) {
      await arrangeRawGrounding(recording.storage, {}, { raw: fixture.raw });
    } else {
      await arrangeRawGrounding(
        recording.storage,
        fixture.entries,
        'planDigest' in fixture ? { planDigest: fixture.planDigest } : {},
      );
    }
    recording.writes.length = 0;
    let receivedPriorTrace: unknown = 'not-called';
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        receivedPriorTrace = request.priorTrace;
        await request.controller.evaluateAssert(READY_ASSERTION, 'dashboard-reached');
        return { outcome: 'success' };
      },
    });
    const resolveAiExecutor = vi.fn(async () => executor);
    const arranged = scenario(recording, { resolveAiExecutor });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(receivedPriorTrace).toBeUndefined();
  });

  it('persists an atomic success-ID-to-terminal-index bijection and excludes action criteria', async () => {
    const criteria: readonly Criterion[] = [
      { id: 'page-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 } },
      { id: 'navigate-action', kind: 'action', sourceSpan: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 10 } },
      { id: 'dashboard-visible', kind: 'success', sourceSpan: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 21 } },
    ];
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, undefined, undefined, coveredPlan(criteria));
    recording.writes.length = 0;
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        const { controller } = request;
        await controller.evaluateAssert({ ...READY_ASSERTION, text: 'Page reached' }, 'page-reached');
        await controller.evaluateAssert(READY_ASSERTION, 'dashboard-visible');
        return { outcome: 'success' };
      },
    });
    const arranged = scenario(recording, { resolveAiExecutor: async () => executor });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recording.writes).toHaveLength(1);
    const grounding = JSON.parse(recording.writes[0]!.text) as {
      entries: Record<string, { trace: TraceRecord & { verificationCoverage: Record<string, number> } }>;
    };
    expect(grounding.entries['reach-dashboard']?.trace.verificationCoverage).toEqual({
      'dashboard-visible': 1,
      'page-reached': 0,
    });
    expect(grounding.entries['reach-dashboard']?.trace.verificationCoverage)
      .not.toHaveProperty('navigate-action');
  });

  it.each([
    ['text-visible', { type: 'assert', check: 'text-visible', text: 'Dashboard' }],
    ['text-equals', { type: 'assert', check: 'text-equals', target: STATUS_TARGET, text: 'Dashboard' }],
    ['element-visible', { type: 'assert', check: 'element-visible', target: STATUS_TARGET }],
    ['element-count exact zero', { type: 'assert', check: 'element-count', target: STATUS_TARGET, count: 0 }],
  ] as const)('persists supported tagged %s terminal proof through fresh finalization', async (_name, assertion) => {
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage);
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.evaluateAssert(assertion, 'dashboard-reached');
        return { outcome: 'success' };
      },
    });
    const entries = new Map([[elementRefKey(STATUS_TARGET), { exists: true, currentFingerprint: FINGERPRINT }]]);
    const arranged = scenario(recording, { resolveAiExecutor: async () => executor }, { passed: true }, { entries });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recording.writes).toHaveLength(1);
    expect(JSON.parse(recording.writes[0]!.text)).toMatchObject({
      entries: {
        'reach-dashboard': {
          kind: 'ai',
          trace: { verification: [assertion], verificationCoverage: { 'dashboard-reached': 0 } },
        },
      },
    });
  });

  it.each([
    ['tagged terminal url-matches', async (controller: InstructionCoverageAiActionController) => {
      await controller.evaluateAssert(
        { type: 'assert', check: 'url-matches', pattern: '/dashboard$' },
        'dashboard-reached',
      );
    }],
    ['materialized repeated text proof', async (controller: InstructionCoverageAiActionController) => {
      await controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Hello {{run.user}}' });
      await controller.perform({ type: 'navigate', url: '/' });
      await controller.evaluateAssert(
        { type: 'assert', check: 'text-visible', text: 'Hello Ada' },
        'dashboard-reached',
      );
    }],
    ['canonical key-order repeated structured proof', async (controller: InstructionCoverageAiActionController) => {
      await controller.evaluateAssert({
        type: 'assert', check: 'text-equals', target: STATUS_TARGET, text: 'Dashboard',
      });
      await controller.perform({ type: 'navigate', url: '/' });
      await controller.evaluateAssert({
        text: 'Dashboard',
        target: { name: 'Dashboard', role: 'status', strategy: 'accessibility' },
        check: 'text-equals',
        type: 'assert',
      }, 'dashboard-reached');
    }],
  ] as const)('aborts fresh finalization for %s without persistence', async (_name, script) => {
    const recording = recordingStorage();
    const usesCapturedRunValue = _name === 'materialized repeated text proof';
    const basePlan = coveredPlan();
    const plan = usesCapturedRunValue
      ? {
          ...basePlan,
          steps: [
            { id: 'capture-user', kind: 'capture', target: STATUS_TARGET, variable: 'user' },
            ...basePlan.steps,
          ],
        } as unknown as PlanDocument
      : basePlan;
    await arrangeArtifacts(
      recording.storage,
      undefined,
      undefined,
      plan,
      usesCapturedRunValue
        ? { 'capture-user': { kind: 'element', fingerprint: FINGERPRINT } }
        : {},
    );
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await script(request.controller);
        return { outcome: 'success' };
      },
    });
    const entries = new Map([[elementRefKey(STATUS_TARGET), { exists: true, currentFingerprint: FINGERPRINT }]]);
    const arranged = scenario(recording, { resolveAiExecutor: async () => executor }, { passed: true }, {
      entries,
      ...(usesCapturedRunValue
        ? { captureValues: new Map([[elementRefKey(STATUS_TARGET), { text: 'Ada', value: '' }]]) }
        : {}),
    });

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(recording.writes).toEqual([]);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
  });

  it.each([
    ['missing tag', [undefined, 'dashboard-visible']],
    ['unknown tag', ['unknown', 'dashboard-visible']],
    ['action tag', ['navigate-action', 'dashboard-visible']],
    ['duplicate tag', ['page-reached', 'page-reached']],
  ] as const)('aborts nominal success with %s and preserves existing covered evidence', async (_name, criterionIds) => {
    const criteria: readonly Criterion[] = [
      { id: 'page-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 } },
      { id: 'navigate-action', kind: 'action', sourceSpan: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 10 } },
      { id: 'dashboard-visible', kind: 'success', sourceSpan: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 21 } },
    ];
    const recording = recordingStorage();
    const seededTrace = {
      events: [],
      verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Account ready' }],
      verificationCoverage: { 'page-reached': 0, 'dashboard-visible': 1 },
    };
    await arrangeArtifacts(recording.storage, seededTrace, undefined, coveredPlan(criteria));
    const groundingPath = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }).groundingPathFor(TEST_PATH);
    const before = await recording.storage.readText(groundingPath);
    recording.resetMutations();
    const executeAgentic = vi.fn(async (request) => {
      const { controller } = request;
      await controller.evaluateAssert({ ...READY_ASSERTION, text: 'Page reached' }, criterionIds[0]);
      await controller.evaluateAssert(READY_ASSERTION, criterionIds[1]);
      return { outcome: 'success' as const };
    });
    const executor = createFakeAiExecutor({ executeAgentic });
    const resolveAiExecutor = vi.fn(async () => executor);
    const arranged = scenario(
      recording,
      { resolveAiExecutor },
      { passed: true },
      { assertOutcomes: [
        { passed: false, message: 'The covered replay drifted.' },
        { passed: true },
        { passed: true },
      ] },
    );

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(recording.writes).toEqual([]);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
    expect(await recording.storage.readText(groundingPath)).toBe(before);
    expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
    expect(executeAgentic).toHaveBeenCalledTimes(1);
    expect(arranged.session.operations()).toEqual([
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Page reached' } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
  });

  it.each([
    ['missing tag', [undefined, 'dashboard-visible']],
    ['unknown tag', ['unknown', 'dashboard-visible']],
    ['action tag', ['navigate-action', 'dashboard-visible']],
    ['duplicate tag', ['page-reached', 'page-reached']],
  ] as const)('aborts cold nominal success with %s and performs no storage mutation', async (_name, criterionIds) => {
    const criteria: readonly Criterion[] = [
      { id: 'page-reached', kind: 'success', sourceSpan: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 6 } },
      { id: 'navigate-action', kind: 'action', sourceSpan: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 10 } },
      { id: 'dashboard-visible', kind: 'success', sourceSpan: { startLine: 3, startColumn: 11, endLine: 3, endColumn: 21 } },
    ];
    const recording = recordingStorage();
    await arrangeArtifacts(recording.storage, undefined, undefined, coveredPlan(criteria));
    recording.resetMutations();
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        const { controller } = request;
        await controller.evaluateAssert({ ...READY_ASSERTION, text: 'Page reached' }, criterionIds[0]);
        await controller.evaluateAssert(READY_ASSERTION, criterionIds[1]);
        return { outcome: 'success' };
      },
    });
    const arranged = scenario(
      recording,
      { resolveAiExecutor: async () => executor },
      { passed: true },
      { assertOutcomes: [{ passed: true }, { passed: true }] },
    );

    const outcome = await run(arranged.deps, OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('error');
    expect(recording.writes).toEqual([]);
    expect(recording.binaryWrites).toEqual([]);
    expect(recording.ensuredDirectories).toEqual([]);
    const grounding = JSON.parse(await recording.storage.readText(
      arranged.deps.layout.groundingPathFor(TEST_PATH),
    )) as { entries: Record<string, unknown> };
    expect(grounding.entries).toEqual({});
  });

  it.each([
    ['cold snapshot', false, 'snapshot'],
    ['cold failed assertion without tag', false, 'failed-assert'],
    ['legacy fallback snapshot', true, 'snapshot'],
    ['legacy fallback failed assertion with tag', true, 'failed-assert'],
  ] as const)(
    'preserves pass-without-new-grounding for %s',
    async (_name, hasLegacyTrace, terminal) => {
      const recording = recordingStorage();
      await arrangeArtifacts(
        recording.storage,
        hasLegacyTrace ? { events: [], verification: [READY_ASSERTION] } : undefined,
      );
      recording.writes.length = 0;
      const executor = createFakeAiExecutor({
        async executeAgentic(request) {
          if (terminal === 'snapshot') {
            await request.controller.snapshotForResolution();
          } else {
            await request.controller.evaluateAssert(
                { ...READY_ASSERTION, text: 'Not ready' },
                hasLegacyTrace ? 'dashboard-reached' : undefined,
              );
          }
          return { outcome: 'success' };
        },
      });
      const resolveAiExecutor = vi.fn(async () => executor);
      const arranged = scenario(
        recording,
        { resolveAiExecutor },
        { passed: false, message: 'Not ready.' },
      );

      const outcome = await run(arranged.deps, OPTIONS);

      expect(outcome.results[0]?.result.status).toBe('passed');
      expect(resolveAiExecutor).toHaveBeenCalledTimes(1);
      expect(recording.writes).toHaveLength(hasLegacyTrace ? 1 : 0);
      const grounding = JSON.parse(await recording.storage.readText(
        arranged.deps.layout.groundingPathFor(TEST_PATH),
      )) as { entries: Record<string, unknown> };
      expect(grounding.entries).toEqual({});
    },
  );
});
