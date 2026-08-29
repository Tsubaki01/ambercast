import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
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
  type GeneratedPlanResponse,
  type JsonValueT,
  GROUNDING_SCHEMA_VERSION,
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
  afterRun: undefined as undefined | ((deps: Pick<HealDeps, 'layout' | 'runId'>, storage: { readonly readText: (path: string) => Promise<string> }, options: { readonly files: readonly string[]; readonly cacheOnly?: boolean }) => void | Promise<void>),
}));

vi.mock('#usecases/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#usecases/run.js')>();
  return {
    ...actual,
    run: async (...args: Parameters<typeof actual.run>) => {
      const outcome = await actual.run(...args);
      await replayRunObserver.afterRun?.(args[0], args[0].storage, args[1]);
      return outcome;
    },
  };
});

afterEach(() => { replayRunObserver.afterRun = undefined; });

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

function recordingStorage(): { readonly storage: StorageAdapter; readonly textWrites: ReturnType<typeof vi.fn>; } {
  const base = createInMemoryStorage();
  const textWrites = vi.fn<StorageAdapter['writeText']>(base.writeText);
  return { storage: { ...base, writeText: textWrites }, textWrites };
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

describe('createHealOverlayStorage', () => {
  it('reads buffered plan and grounding text and reports both paths as existing', async () => {
    const { storage: base } = recordingStorage();
    await base.writeText(PLAN, 'old-plan');
    await base.writeText(GROUNDING, 'old-grounding');
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(base));

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
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(base));
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
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));

    await overlay.flush();

    expect(textWrites).not.toHaveBeenCalled();
    expect(overlay.hasBufferedWrites()).toBe(false);
  });

  it('flushes only grounding for an element-only Stage-1 candidate', async () => {
    const { storage, textWrites } = recordingStorage();
    await storage.writeText(PLAN, 'old-plan');
    await storage.writeText(GROUNDING, 'old-grounding');
    textWrites.mockClear();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.capturePreimage();
    await overlay.storage.writeText(GROUNDING, 'stage-1-grounding');

    await overlay.flush();

    expect(textWrites).toHaveBeenCalledTimes(1);
    expect(textWrites).toHaveBeenCalledWith(GROUNDING, 'stage-1-grounding');
    await expect(storage.exists(PLAN)).resolves.toBe(true);
  });

  it('flushes plan before grounding for a Stage-2 or Stage-3 candidate', async () => {
    const { storage, textWrites } = recordingStorage();
    await storage.writeText(PLAN, 'old-plan');
    await storage.writeText(GROUNDING, 'old-grounding');
    textWrites.mockClear();
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.capturePreimage();
    await overlay.storage.writeText(PLAN, 'healed-plan');
    await overlay.storage.writeText(GROUNDING, 'healed-grounding');

    await overlay.flush();

    expect(textWrites.mock.calls).toEqual([[PLAN, 'healed-plan'], [GROUNDING, 'healed-grounding']]);
  });

  it('restores a snapshot and discards a partial Stage-3 pair before any commit', async () => {
    const { storage } = recordingStorage();
    await storage.writeText(PLAN, 'old-plan');
    await storage.writeText(GROUNDING, 'old-grounding');
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.capturePreimage();
    await overlay.storage.writeText(GROUNDING, 'stage-1-grounding');
    const snapshot = overlay.snapshot();
    await overlay.storage.writeText(PLAN, 'partially-generated-plan');

    overlay.restore(snapshot);

    await expect(overlay.storage.readText(GROUNDING)).resolves.toBe('stage-1-grounding');
    await expect(overlay.storage.exists(PLAN)).resolves.toBe(true);
    await overlay.flush();
    await expect(storage.exists(PLAN)).resolves.toBe(true);
    await expect(storage.readText(GROUNDING)).resolves.toBe('stage-1-grounding');
  });

  it('keeps base artifact bytes unchanged when a dry-run candidate is replayed only from the overlay', async () => {
    const { storage } = recordingStorage();
    await storage.writeText(PLAN, 'base-plan');
    await storage.writeText(GROUNDING, 'base-grounding');
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.storage.writeText(PLAN, 'stage-3-plan');
    await overlay.storage.writeText(GROUNDING, 'stage-3-grounding');

    // This is the storage boundary used by the Stage-3 replay: it must observe the
    // regenerated pair even though dry-run deliberately never invokes flush().
    await expect(Promise.all([overlay.storage.readText(PLAN), overlay.storage.readText(GROUNDING)]))
      .resolves.toEqual(['stage-3-plan', 'stage-3-grounding']);
    await expect(Promise.all([storage.readText(PLAN), storage.readText(GROUNDING)]))
      .resolves.toEqual(['base-plan', 'base-grounding']);
  });

  it.each([
    ['plan only', ['plan'] as const],
    ['grounding only', ['grounding'] as const],
    ['both artifacts', ['plan', 'grounding'] as const],
  ])('rejects a preimage mismatch on $0 before any write', async (_name, mismatched) => {
    const { storage: base, textWrites } = recordingStorage();
    await base.writeText(PLAN, 'preflight-plan');
    await base.writeText(GROUNDING, 'preflight-grounding');
    textWrites.mockClear();
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(base));
    await overlay.capturePreimage();
    await overlay.storage.writeText(PLAN, 'candidate-plan');
    await overlay.storage.writeText(GROUNDING, 'candidate-grounding');
    if ((mismatched as readonly string[]).includes('plan')) await base.writeText(PLAN, 'externally-mutated-plan');
    if ((mismatched as readonly string[]).includes('grounding')) await base.writeText(GROUNDING, 'externally-mutated-grounding');
    textWrites.mockClear();

    await expect(overlay.flush()).rejects.toMatchObject({
      constructor: IntegrityViolationError,
      details: { mismatched },
    });
    expect(textWrites).not.toHaveBeenCalled();
    await expect(base.readText(PLAN)).resolves.toBe((mismatched as readonly string[]).includes('plan') ? 'externally-mutated-plan' : 'preflight-plan');
    await expect(base.readText(GROUNDING)).resolves.toBe((mismatched as readonly string[]).includes('grounding') ? 'externally-mutated-grounding' : 'preflight-grounding');
  });

  it('re-verifies an unbuffered plan before committing a grounding-only candidate', async () => {
    const { storage: base, textWrites } = recordingStorage();
    await base.writeText(PLAN, 'preflight-plan');
    await base.writeText(GROUNDING, 'preflight-grounding');
    textWrites.mockClear();
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(base));
    await overlay.capturePreimage();
    await overlay.storage.writeText(GROUNDING, 'candidate-grounding');
    await base.writeText(PLAN, 'externally-mutated-plan');
    textWrites.mockClear();

    await expect(overlay.flush()).rejects.toBeInstanceOf(IntegrityViolationError);
    expect(textWrites).not.toHaveBeenCalled();
    await expect(base.readText(GROUNDING)).resolves.toBe('preflight-grounding');
  });

  it.each([
    ['plan', ['plan'] as const],
    ['grounding', ['grounding'] as const],
    ['both', ['plan', 'grounding'] as const],
  ])('classifies commit-time deletion of $0 as a zero-write integrity failure', async (_name, missing) => {
    const base = createInMemoryStorage();
    const textWrites = vi.fn<StorageAdapter['writeText']>(base.writeText);
    const storage: StorageAdapter = { ...base, writeText: textWrites };
    await storage.writeText(PLAN, 'preflight-plan');
    await storage.writeText(GROUNDING, 'preflight-grounding');
    textWrites.mockClear();
    const captured = new Set<string>();
    const readBinary: StorageAdapter['readBinary'] = async (path) => {
      const deletedAfterPreimage = (path === PLAN && (missing as readonly string[]).includes('plan')) || (path === GROUNDING && (missing as readonly string[]).includes('grounding'));
      if (deletedAfterPreimage && captured.has(path)) {
        throw Object.assign(new Error('deleted after preflight'), { code: 'ENOENT' });
      }
      captured.add(path);
      return base.readBinary(path);
    };
    const overlay = createHealOverlayStorage({ ...storage, readBinary }, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.capturePreimage();
    await overlay.storage.writeText(PLAN, 'candidate-plan');
    await overlay.storage.writeText(GROUNDING, 'candidate-grounding');

    await expect(overlay.flush()).rejects.toMatchObject({ constructor: IntegrityViolationError, details: { mismatched: missing } });
    expect(textWrites).not.toHaveBeenCalled();
  });

  it('detects byte-distinct malformed UTF-8 preimage and commit-time bytes', async () => {
    const base = createInMemoryStorage();
    const preimage = new Uint8Array([0x80]);
    const reread = new Uint8Array([0x81]);
    const decoder = new TextDecoder();
    const textWrites = vi.fn<StorageAdapter['writeText']>(base.writeText);
    await base.writeBinary(PLAN, preimage);
    await base.writeText(GROUNDING, 'preflight-grounding');
    textWrites.mockClear();
    let useCommitTimeBytes = false;
    const storage: StorageAdapter = {
      ...base,
      writeText: textWrites,
      async readBinary(path) {
        if (path === PLAN && useCommitTimeBytes) return reread;
        return base.readBinary(path);
      },
    };
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));

    expect(decoder.decode(preimage)).toBe(decoder.decode(reread));
    await overlay.capturePreimage();
    useCommitTimeBytes = true;
    await overlay.storage.writeText(PLAN, 'candidate-plan');

    await expect(overlay.flush()).rejects.toMatchObject({
      constructor: IntegrityViolationError,
      details: { mismatched: ['plan'] },
    });
    expect(textWrites).not.toHaveBeenCalled();
  });

  it('preserves a non-missing pre-pass read failure as an ordinary I/O failure at commit', async () => {
    const base = createInMemoryStorage();
    await base.writeText(PLAN, 'preflight-plan');
    await base.writeText(GROUNDING, 'preflight-grounding');
    let failRead = false;
    const storage: StorageAdapter = {
      ...base,
      readBinary: async (path) => {
        if (failRead && path === PLAN) throw new Error('disk fault');
        return base.readBinary(path);
      },
    };
    const overlay = createHealOverlayStorage(storage, { planPath: PLAN, groundingPath: GROUNDING }, permissiveContainedWrites(storage));
    await overlay.capturePreimage();
    failRead = true;
    await overlay.storage.writeText(PLAN, 'candidate-plan');

    await expect(overlay.flush()).rejects.toThrow('disk fault');
  });

  it('routes untracked writes through containment while tracked text bypasses it', async () => {
    const { storage: base } = recordingStorage();
    await base.writeText(PLAN, 'preflight-plan');
    await base.writeText(GROUNDING, 'preflight-grounding');
    const rejected = new IntegrityViolationError('outside runs directory');
    const containedWrites = {
      writeText: vi.fn<StorageAdapter['writeText']>(async () => { throw rejected; }),
      writeBinary: vi.fn<StorageAdapter['writeBinary']>(async () => { throw rejected; }),
      ensureDir: vi.fn<StorageAdapter['ensureDir']>(async () => { throw rejected; }),
    };
    const overlay = createHealOverlayStorage(base, { planPath: PLAN, groundingPath: GROUNDING }, containedWrites);

    await expect(overlay.storage.writeText('/workspace/tests/.runs/note.txt', 'note')).rejects.toBe(rejected);
    await expect(overlay.storage.writeBinary('/workspace/tests/.runs/evidence.png', new Uint8Array([1]))).rejects.toBe(rejected);
    await expect(overlay.storage.ensureDir('/workspace/tests/.runs/empty')).rejects.toBe(rejected);
    await overlay.capturePreimage();
    await overlay.storage.writeText(PLAN, 'candidate-plan');
    await overlay.storage.writeText(GROUNDING, 'candidate-grounding');
    await overlay.flush();

    expect(containedWrites.writeText).toHaveBeenCalledOnce();
    expect(containedWrites.writeBinary).toHaveBeenCalledOnce();
    expect(containedWrites.ensureDir).toHaveBeenCalledOnce();
    await expect(base.readText(PLAN)).resolves.toBe('candidate-plan');
    await expect(base.readText(GROUNDING)).resolves.toBe('candidate-grounding');
  });
});

describe('heal state-machine contract', () => {
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

  it('returns no-changes-needed for a fully replayable trusted plan and never creates a commit', async () => {
    const base = createInMemoryStorage();
    const readBinary = vi.fn<StorageAdapter['readBinary']>(base.readBinary);
    const scenario = await createScenario({
      storage: { ...base, readBinary },
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
    expect(readBinary).toHaveBeenCalledTimes(2);
    expect(readBinary).toHaveBeenNthCalledWith(1, PLAN);
    expect(readBinary).toHaveBeenNthCalledWith(2, GROUNDING);
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
        if ((request.context as { replacement?: unknown }).replacement !== undefined) repairRequest = request;
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
      testMd: normalizeTestMd(SECRET_PROMPT),
      targets: TARGETS,
      replacement: {
        stepId: 'click-submit',
        index: 1,
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

    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', stopReason: 'settled' });
    expect(resolveAiExecutor).toHaveBeenCalledOnce();
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
      const replacement = (request.context as { readonly replacement?: { readonly index: number } }).replacement;
      return {
        data: {
          steps: replacement?.index === 0
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
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'healed', stopReason: 'settled', finalFirstFailureIndex: 1 });
    expect(execute.mock.calls.filter(([request]) => (request.context as { replacement?: unknown }).replacement !== undefined)).toHaveLength(0);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && (request.context as { replacement?: unknown }).replacement === undefined)).toHaveLength(1);
  });

  it('discards a non-advancing candidate then makes exactly one Stage 3 request and no further Stage 2 request', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => request.prompt.startsWith('Confirm whether')
      ? { data: { confirmed: true }, raw: '{}' }
      : { data: (request.context as { replacement?: unknown }).replacement === undefined ? { steps: [{ id: 'full', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] } : { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }], ambiguities: [] }, raw: '{}' });
    const scenario = await createScenario({ sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]), aiExecutor: createFakeAiExecutor({ execute }) });
    await heal(scenario.deps, OPTIONS);
    expect(execute.mock.calls.filter(([request]) => (request.context as { replacement?: unknown }).replacement !== undefined)).toHaveLength(0);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && (request.context as { replacement?: unknown }).replacement === undefined)).toHaveLength(1);
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
      const replacement = (request.context as { readonly replacement?: { readonly index: number } }).replacement;
      return {
        data: {
          steps: replacement === undefined
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
    expect(execute.mock.calls.filter(([request]) => (request.context as { replacement?: unknown }).replacement !== undefined)).toHaveLength(0);
    expect(execute.mock.calls.filter(([request]) => !request.prompt.startsWith('Confirm whether') && (request.context as { replacement?: unknown }).replacement === undefined)).toHaveLength(1);
  });

  it('sends a -1 loop entry to Stage 3 with zero Stage 1 or Stage 2 dispatches', async () => {
    const execute = vi.fn(async () => ({ data: { steps: [], ambiguities: [] }, raw: '{}' }));
    const scenario = await createScenario({ launchFailure: true, aiExecutor: createFakeAiExecutor({ execute }) });
    await heal(scenario.deps, OPTIONS);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('reports attempt-limit after a prior advance and enters Stage 3', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const replacement = (request.context as { replacement?: { index: number } }).replacement;
      if (replacement?.index === 0) return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
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
    expect(result.outcome.results[0]).toMatchObject({ repairOutcome: 'unresolved', stopReason: 'settled' });
  });

  it('reports settled when an attempt-limit Stage 3 replay fully heals the plan', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      const replacement = (request.context as { readonly replacement?: { readonly index: number } }).replacement;
      return {
        data: {
          steps: replacement === undefined
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

  it('returns partially-healed at a deadline after an advance and remains confirmation eligible', async () => {
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
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, finalFirstFailureIndex: outcome.finalFirstFailureIndex }).toEqual({ repairOutcome: 'healed', stopReason: 'settled', finalFirstFailureIndex: 1 });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(true);
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
    expect(execute.mock.calls.filter(([request]) => (request.context as { replacement?: unknown }).replacement !== undefined)).toHaveLength(0);
  });

  it('restores the best incremental candidate when Stage 3 replay does not fully pass', async () => {
    const execute = vi.fn(async (request: { readonly prompt: string; readonly context?: unknown }) => {
      if (request.prompt.startsWith('Confirm whether')) return { data: { confirmed: true }, raw: '{}' };
      if ((request.context as { replacement?: unknown }).replacement !== undefined) {
        return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      }
      return { data: { steps: [{ id: 'regenerated-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }, { id: 'regenerated-after', kind: 'action', action: 'click', target: AFTER_SUBMIT }], ambiguities: [] }, raw: '{}' };
    });
    const scenario = await createScenario({ steps: [Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }), Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT })], sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], [elementRefKey(AFTER_SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]), aiExecutor: createFakeAiExecutor({ execute }) });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, finalFirstFailureIndex: outcome.finalFirstFailureIndex }).toEqual({ repairOutcome: 'unresolved', stopReason: 'settled', finalFirstFailureIndex: 0 });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
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
      const replacement = (request.context as { readonly replacement?: { readonly index: number } }).replacement;
      if (replacement?.index === 0) {
        return { data: { steps: [{ id: 'click-submit', kind: 'action', action: 'click', target: REPAIRED_SUBMIT }], ambiguities: [] }, raw: '{}' };
      }
      throw new Error('No further candidate is available.');
    });
    const scenario = await createScenario({
      steps: [Step.parse({ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }), Step.parse({ id: 'click-after', kind: 'action', action: 'click', target: AFTER_SUBMIT })],
      sessionEntries: new Map([[elementRefKey(SUBMIT), { exists: false, currentFingerprint: FINGERPRINT }], ...liveEntries(REPAIRED_SUBMIT)]),
      aiExecutor: createFakeAiExecutor({ execute }),
    });
    const result = await heal(scenario.deps, OPTIONS);
    const outcome = result.outcome.results[0]!;
    expect({ repairOutcome: outcome.repairOutcome, stopReason: outcome.stopReason, baselineFirstFailureIndex: outcome.baselineFirstFailureIndex, finalFirstFailureIndex: outcome.finalFirstFailureIndex, stage3Error: outcome.stage3Error }).toEqual({ repairOutcome: 'unresolved', stopReason: 'settled', baselineFirstFailureIndex: 0, finalFirstFailureIndex: 0, stage3Error: expect.any(Error) });
    expect(result.commits.has(OPTIONS.files[0]!)).toBe(false);
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
    const replacementDispatches = execute.mock.calls.filter(([request]) => (request.context as { readonly replacement?: unknown }).replacement !== undefined);
    const nonReplacementDispatches = execute.mock.calls.filter(([request]) => (request.context as { readonly replacement?: unknown }).replacement === undefined);
    const expected = mode === 'none'
      ? { replacement: 1, nonReplacement: 1, aiRetrace: 0 }
      : mode === 'ai-retrace'
        ? { replacement: 0, nonReplacement: 1, aiRetrace: 2 }
        : { replacement: 0, nonReplacement: 1, aiRetrace: 0 };
    expect({ replacement: replacementDispatches.length, nonReplacement: nonReplacementDispatches.length, aiRetrace: executeAgentic.mock.calls.length }).toEqual(expected);
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
