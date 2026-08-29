import type { AmbercastError } from '#core/errors/types.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import type { FsIoError } from '#core/errors/fs-io-error.js';
import type { StepResult } from '#report/schema.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { RunCaseOutcome, RunDeps } from './run.js';
import { run, readTrustedInstructionCoveredPlan } from './run.js';
import { generate, prepareInstructionCoveredSteps } from './generate.js';
import { inspectGroundingArtifact } from './check-grounding.js';
import { computePlanDigest } from '#core/ir/digest.js';
import { deriveCurrentPlanInputProvenance } from '#core/ai/plan-input-provenance.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { groundingRecoveryModeForStep } from '#core/ir/grounding-recovery-mode.js';
import { GROUNDING_SCHEMA_VERSION, PlanDocument, GeneratedPlanResponse, type GroundingDocument, type JsonValueT, type Step } from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { buildGeneratorTask } from '#core/ai/prompt-envelope.js';
import { resolveTarget } from '#core/target/resolve.js';
import { extractSecretGrants } from '#core/ir/secret-grant-source.js';
import { assertCommittedSecretAttributionSound, assertNoLiteralSecrets, normalizeAiStepSecretGrants } from './generator-secret-policy.js';
import { isLegacyShapedTrace, validateCommittedInstructionCoverage } from './instruction-coverage-policy.js';
import { FsIoError as FsIoErrorClass } from '#core/errors/fs-io-error.js';
import { AmbercastError as AmbercastErrorClass } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { BatchInterruptionTracker } from './batch-interruption.js';
import { obligationFingerprintMatches } from '#core/ir/obligation-fingerprint.js';
import { joinPath } from '#core/paths.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';

/**
 * Selection and write-intent choices for one healing batch.
 *
 * @remarks
 * Healing owns discovery-only listing so it can return the same selected-file
 * identities without opening plans, grounding, or a browser. `dryRun` changes
 * persistence rather than measurement: attempts still use their private
 * overlay so their reported evidence describes the candidate that was tried.
 * `yes` is retained here as the caller's authorization input, while the
 * runtime owns the interactive confirmation boundary.
 */
export interface HealOptions {
  /** Already-absolute prompt paths, or an empty list to use configured discovery. */
  readonly files: readonly string[];

  /** Optional explicit target name; an invalid name never falls back. */
  readonly target?: string;

  /** Whether provider ambiguity is rejected rather than retained for review. */
  readonly strict?: boolean;

  /** Whether an otherwise empty selected set may succeed. */
  readonly allowEmpty?: boolean;

  /** Whether candidate artifact writes remain buffered for the whole batch. */
  readonly dryRun: boolean;

  /** Whether the runtime may commit pending candidates without prompting. */
  readonly yes: boolean;

  /** Whether to return selected identities without attempting a repair. */
  readonly list: boolean;
}

/**
 * Dependencies available to healing, including its resolved case-wide limits.
 *
 * @remarks
 * Healing deliberately replaces, rather than widens, `RunDeps.config`: ordinary
 * replay must not acquire a heal-specific configuration requirement merely
 * because healing reuses it. The intersection retains the established replay
 * configuration surface while making the resolved `heal` limits available to
 * the state machine before it schedules any repair work. Containment remains
 * an injected capability because filesystem-aware adapter composition belongs
 * to runtime; each case supplies its own evidence-directory root when it
 * needs the capability.
 */
export type HealDeps = Omit<RunDeps, 'config'> & {
  readonly config: RunDeps['config'] & Pick<ResolvedConfig, 'heal'>;

  /**
   * Produces the write-only containment boundary for one case's evidence root.
   *
   * @remarks
   * This remains injected because adapter composition belongs to runtime; it is
   * a function rather than a pre-bound view because every case has a distinct root.
   */
  readonly containWrites: (root: string) => Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>;
};

/** A selected file retained for discovery-only or interruption reporting. */
export type HealListedFile = { readonly file: string };

/**
 * A case-scoped failure that prevents healing from reaching a replay result.
 *
 * Preconditions such as an untrusted plan or grounding companion remain
 * errors rather than repair candidates: healing changes execution failures
 * against trustworthy artifacts, while artifact lifecycle recovery belongs to
 * generation and ordinary replay.
 */
export interface HealCaseError {
  /** Prompt file whose precondition or storage operation failed. */
  readonly file: string;

  /** Classified failure preserved for common report and exit-code policy. */
  readonly error: AmbercastError;
}

/**
 * The execution-backed result for one healed case.
 *
 * @remarks
 * The two first-failure indices identify the first failed or errored step
 * before and after repair. They equal `plan.steps.length` when every step
 * passed, that step's index when a failed or errored step produces evidence,
 * and `-1` when failure occurs before any step produces evidence.
 * `stage3Error` records failure while producing a full regenerated candidate;
 * `finalReplayError` records the classified failure attached to the last
 * replay actually performed. They remain separate because successful
 * regeneration can still lead to a browser, integrity, AI, or I/O failure
 * while replaying its candidate.
 */
export interface HealCaseOutcome {
  /** Stable case identity shared by report rows and pending commits. */
  readonly id: string;

  /** Source prompt for the completed repair attempt. */
  readonly file: string;

  /** Companion plan path retained for execution-backed report identity. */
  readonly planFile: string;

  /**
   * Conservative progress classification for this repair attempt.
   *
   * The name distinguishes measured repair progress from the later runtime
   * application decision represented by report schema 3.0.
   */
  readonly repairOutcome: 'healed' | 'partially-healed' | 'unresolved' | 'no-changes-needed';

  /** Evidence returned by the last replay that was actually performed. */
  readonly steps: readonly StepResult[];

  /** Human-readable replay explanation paired with the retained evidence. */
  readonly explanation: string;

  /** Measured case duration before report-boundary integer normalization. */
  readonly durationMs: number;

  /** Baseline first-failure index: all passed → N (`plan.steps.length`); first failed/error step → its index; pre-evidence failure → -1 (below every real index). */
  readonly baselineFirstFailureIndex: number;

  /** Final first-failure index: all passed → N (`plan.steps.length`); first failed/error step → its index; pre-evidence failure → -1 (below every real index). */
  readonly finalFirstFailureIndex: number;

  /**
   * Completed-loop exit cause, kept separate from the measured repair result.
   *
   * A deadline and an attempt ceiling constrain whether another dispatch may
   * start; neither changes whether the retained measurement advanced beyond
   * the baseline. Consumers can therefore distinguish a settled repair from
   * an otherwise identical partial result stopped by a resource boundary.
   */
  readonly stopReason: 'settled' | 'attempt-limit' | 'deadline';

  /** Classified failure encountered while constructing a full-plan candidate. */
  readonly stage3Error: AmbercastError | undefined;

  /** Classified failure attached to the replay supplying the retained evidence. */
  readonly finalReplayError: AmbercastError | undefined;
}

/**
 * Ordered healing observations, lifecycle failures, and batch facts.
 *
 * This is deliberately neither a `RunOutcome` nor a `CheckOutcome` mirror:
 * healing needs replay-style listed and skipped identities as well as a
 * check-style top-level error channel for preconditions that must not become
 * repair attempts.
 */
export interface HealOutcome {
  readonly results: readonly HealCaseOutcome[];
  readonly errors: readonly HealCaseError[];
  readonly noTestsFound: boolean;
  readonly listed: readonly HealListedFile[];
  readonly skipped: readonly HealListedFile[];
  readonly interrupted: boolean;
}

/**
 * Result of applying one case's buffered artifact changes.
 *
 * A two-file transaction is unavailable at the storage boundary, so a failed
 * commit reports every artifact that became visible instead of attempting an
 * unreliable compensating write. Its `error.details.partiallyWritten` carries
 * the same list as this outcome so report mapping can preserve the evidence
 * after command settlement discards the capability wrapper. Integrity failures
 * form a separate arm so their zero-write guarantee remains checked by the
 * type system rather than depending on callers to interpret an error class.
 */
export type HealCommitOutcome =
  | { readonly outcome: 'committed' }
  | {
      readonly outcome: 'failed';
      readonly error: FsIoError;
      readonly partiallyWritten: readonly ('plan' | 'grounding')[];
    }
  | {
      readonly outcome: 'failed';
      readonly error: IntegrityViolationError;
      readonly partiallyWritten: readonly [];
    };

/**
 * The narrowly scoped capability for persisting one improved case.
 *
 * @remarks
 * `commit` closes over the case's overlay rather than exposing it, preventing
 * the runtime from inspecting, mutating, or flushing another case's buffered
 * state. `healingSummary` lets confirmation describe the concrete repair kind
 * without turning internal numbered attempts into an external wording
 * contract.
 */
export interface HealCaseCommit {
  /** Prompt file whose buffered artifacts this capability may persist. */
  readonly file: string;

  /** Plan companion updated by a successful commit. */
  readonly planFile: string;

  /** Neutral repair description for a confirmation prompt. */
  readonly healingSummary: string;

  /** Flushes this case's buffered artifacts once the caller has authorized it. */
  commit(): Promise<HealCommitOutcome>;
}

/**
 * Two-phase healing result returned before any real artifact write.
 *
 * The outcome is sufficient for reporting, while commits preserve only the
 * per-case capabilities eligible for confirmation. Returning both keeps
 * measurement and user authorization separate: `heal` never chooses to flush
 * real storage itself.
 */
export interface HealBatchResult {
  readonly outcome: HealOutcome;
  readonly commits: ReadonlyMap<string, HealCaseCommit>;
}

/** Immutable buffered contents for the tracked artifact pair. */
export type OverlaySnapshot = ReadonlyMap<string, string>;

/**
 * Path-scoped storage decorator for candidate plan and grounding artifacts.
 *
 * @remarks
 * Only the current case's artifact pair is buffered. Other storage operations,
 * including diagnostic evidence, pass through so replay retains its normal
 * observability. This intentionally small overlay defers the only writes that
 * require an explicit commit decision without shadowing another case.
 */
export interface HealOverlayStorage {
  /** Storage view supplied to internal replay and generation calls. */
  readonly storage: StorageAdapter;

  /** Whether either tracked artifact has buffered content awaiting a decision. */
  hasBufferedWrites(): boolean;

  /**
   * Writes buffered tracked artifacts only while their captured preimage is intact.
   *
   * @remarks
   * Before writing anything, the overlay re-reads both tracked artifacts' real
   * bytes and compares them with the preimage retained by `capturePreimage()`.
   * Any mismatch, including either artifact having been deleted, throws
   * `IntegrityViolationError` before either write begins, so an integrity
   * failure can never produce a partial commit. A filesystem read error other
   * than a missing artifact, such as a permission error, is not reclassified
   * as a mismatch and propagates as an ordinary I/O failure, like a write-loop
   * error. The pre-pass detects changes completed before it starts, but the
   * accepted TOCTOU boundary means it cannot detect a change landing strictly
   * between the pre-pass finishing and the write loop's write call completing.
   */
  flush(): Promise<void>;

  /**
   * Captures the current real bytes for the tracked artifact pair before repair.
   *
   * @remarks
   * The overlay retains this preimage instead of accepting one from `flush`, so
   * a caller cannot pair a commit with bytes captured for another case. `healCase`
   * must call this only after preflight succeeds: preflight owns the established
   * classification of missing or invalid artifacts, while this capture observes
   * only changes that occur after those checks.
   */
  capturePreimage(): Promise<void>;

  /** Captures immutable buffered contents before an all-or-nothing stage attempt. */
  snapshot(): OverlaySnapshot;

  /** Discards stage-local buffering by restoring a prior in-memory snapshot. */
  restore(snapshot: OverlaySnapshot): void;
}

/**
 * Creates a per-case view that buffers only a plan and its grounding companion.
 *
 * @param base - Real storage used for reads, untracked operations, and commits.
 * @param trackedPaths - The sole artifact pair whose text writes are deferred.
 * @param containedWrites - Write-only storage constrained to this case's evidence directory.
 * @returns A storage view with snapshot, restore, and explicit flush controls.
 * @remarks
 * Buffering makes dry runs and non-improving candidates safe without changing
 * the storage port. A flush is intentionally an explicit capability: callers
 * decide whether it is authorized after observing the completed batch. The
 * containment view is deliberately narrower than `StorageAdapter` because it
 * only guards binary writes, directory creation, and untracked text writes.
 * It remains separate from `base`: tracked plan and grounding writes are
 * committed through the unwrapped base storage because they legitimately lie
 * outside the evidence directory.
 */
export function createHealOverlayStorage(
  base: StorageAdapter,
  trackedPaths: { readonly planPath: string; readonly groundingPath: string },
  containedWrites: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>,
): HealOverlayStorage {
  let buffered = new Map<string, string>();
  let preimage: { readonly plan: Uint8Array; readonly grounding: Uint8Array } | undefined;
  const tracked = (path: string) => path === trackedPaths.planPath || path === trackedPaths.groundingPath;
  const storage: StorageAdapter = {
    readText: async (path) => buffered.has(path) ? buffered.get(path)! : base.readText(path),
    exists: async (path) => buffered.has(path) ? true : base.exists(path),
    writeText: async (path, text) => {
      if (tracked(path)) {
        buffered.set(path, text);
        return;
      }
      await containedWrites.writeText(path, text);
    },
    readBinary: (path) => base.readBinary(path),
    writeBinary: (path, text) => containedWrites.writeBinary(path, text),
    listFiles: (path) => base.listFiles(path),
    ensureDir: (path) => containedWrites.ensureDir(path),
  };
  return {
    storage,
    hasBufferedWrites: () => buffered.size > 0,
    capturePreimage: async () => {
      preimage = {
        plan: await base.readBinary(trackedPaths.planPath),
        grounding: await base.readBinary(trackedPaths.groundingPath),
      };
    },
    flush: async () => {
      if (buffered.size === 0) return;

      const written: ('plan' | 'grounding')[] = [];
      try {
        if (preimage === undefined) {
          throw new Error('Healing artifact preimage was not captured.');
        }

        const mismatched: ('plan' | 'grounding')[] = [];
        for (const [kind, path, expected] of [
          ['plan', trackedPaths.planPath, preimage.plan],
          ['grounding', trackedPaths.groundingPath, preimage.grounding],
        ] as const) {
          try {
            const actual = await base.readBinary(path);
            if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) {
              mismatched.push(kind);
            }
          } catch (error) {
            if (isMissingArtifactError(error)) {
              mismatched.push(kind);
              continue;
            }
            throw error;
          }
        }
        if (mismatched.length > 0) {
          throw new IntegrityViolationError('Healing artifacts changed after preflight.', { mismatched });
        }

        for (const [kind, path] of [['plan', trackedPaths.planPath], ['grounding', trackedPaths.groundingPath]] as const) {
          if (!buffered.has(path)) continue;
          await base.writeText(path, buffered.get(path)!);
          written.push(kind);
        }
      } catch (error) {
        if (error instanceof IntegrityViolationError) {
          throw error;
        }
        throw Object.assign(error instanceof Error ? error : new Error('Healing artifact write failed.'), { written });
      }
    },
    snapshot: () => new Map(buffered),
    restore: (snapshot) => { buffered = new Map(snapshot); },
  };
}

function isMissingArtifactError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

type TrustedPlan = Awaited<ReturnType<typeof readTrustedInstructionCoveredPlan>>['plan'];
type ResolvedAiExecutor = Awaited<ReturnType<HealDeps['resolveAiExecutor']>>;
type ResolveCaseAiExecutor = () => Promise<ResolvedAiExecutor>;

type ReplayMeasurement =
  | { readonly interrupted: true }
  | {
    readonly interrupted: false;
    readonly replay: RunCaseOutcome;
    readonly firstFailureIndex: number;
    readonly attemptOrdinal: number;
    readonly evidenceDir: string;
  };

/**
 * One adopted frontier replacement retained as provider context for later repairs.
 *
 * Only improvements enter this closed record: rejected or discarded candidates
 * must not influence a later request. The paired indices prove strict frontier
 * progress, and the nullable category preserves the meaningful absence of a
 * step classification when replay produced no step evidence.
 */
interface RepairHistoryEntry {
  readonly stepId: string;
  readonly before: Step;
  readonly after: Step;
  readonly fromFirstFailureIndex: number;
  readonly toFirstFailureIndex: number;
  readonly failureCategory: StepResult['type'] | null;
}

/**
 * Projects replay results into the minimal evidence allowed in provider context.
 *
 * The projection retains only step identity and pass/fail status. It excludes
 * screenshots and every page-evidence field, because provider context must not
 * acquire filesystem locations or browser evidence merely as repair history
 * grows across iterations.
 */
function toProviderReplayEvidence(steps: readonly StepResult[]): readonly StepResult[] {
  return steps.map(({ id, type, status }) => ({ id, type, status }));
}

/**
 * Creates the layout view for one monotonically numbered replay attempt.
 *
 * The decorator preserves every injected layout capability except
 * `runsDirFor`, whose result gains an attempt-specific child directory. A
 * single case-wide ordinal prevents baseline, Stage 1, Stage 2, and Stage 3
 * screenshots from overwriting one another while keeping discarded evidence
 * available for diagnosis.
 */
function attemptScopedLayout(layout: LayoutResolver, attemptOrdinal: number): LayoutResolver {
  return { ...layout, runsDirFor: (file, runId) => joinPath(layout.runsDirFor(file, runId), `attempt-${attemptOrdinal}`) };
}

type RepairKind = 'grounding-element' | 'grounding-ai-retrace' | 'tail' | 'full-plan';

type CaseProcessingResult =
  | { readonly interrupted: true }
  | { readonly interrupted: false; readonly outcome: HealCaseOutcome; readonly commit: HealCaseCommit | undefined };

/**
 * Runs one replay with the only two cache policies healing needs.
 *
 * Baselines must expose an existing artifact's behavior without creating new
 * grounding, while repair replays deliberately update the private overlay so
 * later stages measure the best candidate rather than the original artifact.
 */
function replayOptions(file: string, options: HealOptions, cacheOnly: boolean) {
  return {
    files: [file],
    ...(options.target === undefined ? {} : { target: options.target }),
    cacheOnly,
    updateCache: !cacheOnly,
    allowEmpty: true,
    list: false,
    stale: 'fail' as const,
  };
}

/**
 * Converts one inner single-file run into healing's usable replay evidence.
 *
 * A skipped inner identity means cancellation reached the same case while an
 * attempt was in flight; it is not a failed repair and must not manufacture a
 * result row from absent evidence.
 */
async function measureReplay(
  deps: HealDeps,
  options: HealOptions,
  file: string,
  overlay: HealOverlayStorage,
  plan: TrustedPlan,
  cacheOnly: boolean,
  attemptOrdinal: number,
): Promise<ReplayMeasurement> {
  const evidenceDir = attemptScopedLayout(deps.layout, attemptOrdinal).runsDirFor(file, deps.runId);
  const batch = await run({ ...deps, storage: overlay.storage, layout: attemptScopedLayout(deps.layout, attemptOrdinal) }, replayOptions(file, options, cacheOnly));
  const replay = batch.results[0];
  if (batch.interrupted || replay === undefined) return { interrupted: true };

  return {
    interrupted: false,
    replay,
    firstFailureIndex: firstFailureIndex(replay, plan),
    attemptOrdinal,
    evidenceDir,
  };
}

/**
 * Computes the first-failure index: all passed steps yield N
 * (`plan.steps.length`); the first failed or errored step yields its index;
 * and failure before any step produces evidence yields -1, ordered below every
 * real index.
 *
 * `run()` has no step evidence when it fails before dispatch, and treating
 * that state as a failure of the first step would make repair scope falsely
 * specific.
 */
function firstFailureIndex(replay: RunCaseOutcome, plan: TrustedPlan): number {
  const steps = replay.result.steps;
  if (steps.filter((step) => step.status === 'passed').length === plan.steps.length) return plan.steps.length;
  return steps.findIndex((step) => step.status === 'failed' || step.status === 'error');
}

/**
 * Loads only artifacts trustworthy enough to be repaired.
 *
 * Healing changes execution drift, not artifact lifecycle failures. Keeping
 * this preflight before every browser attempt prevents a stale or malformed
 * artifact from becoming an accidental regeneration candidate.
 */
async function preflightCase(
  deps: HealDeps,
  options: HealOptions,
  file: string,
  planFile: string,
  groundingFile: string,
  overlay: HealOverlayStorage,
): Promise<{ readonly normalized: NormalizedTestMd; readonly digest: string; readonly plan: TrustedPlan }> {
  const normalized = normalizeTestMd(await deps.storage.readText(file));
  const target = resolveTarget({
    targets: deps.config.targets,
    defaultTarget: deps.config.defaultTarget,
    explicitTarget: options.target,
  });
  if (target instanceof AmbercastErrorClass) throw target;

  const digest = deriveCurrentPlanInputProvenance({
    normalizedTestMd: normalized,
    targetDefinitions: target.definitions,
  }).inputsDigest;
  const plan = (await readTrustedInstructionCoveredPlan(overlay.storage, planFile, digest, normalized)).plan;
  assertCommittedSecretAttributionSound(plan, normalized);

  let inspection;
  try {
    inspection = await inspectGroundingArtifact(overlay.storage, groundingFile, plan);
  } catch (error) {
    throw new FsIoErrorClass('The grounding artifact could not be inspected.', undefined, { cause: error });
  }
  if (inspection.kind !== 'valid') throw new FsIoErrorClass('The grounding artifact is not valid and current.');
  return { normalized, digest, plan };
}

/**
 * Attempts the shared Stage 1 recovery selected by the failing step kind.
 *
 * Element-consuming steps qualify without a stored entry, while AI steps retry
 * only a missing, wrong-kind, or legacy-shaped trace. Retaining an eligible AI
 * entry preserves its trace as the hint for a focused retrace, whereas an
 * element retry removes its stale fingerprint before replay.
 *
 * The attempt is scoped by an overlay snapshot. A replay that does not advance
 * the frontier, including an interruption, restores that snapshot so
 * speculative cache and grounding writes cannot influence the following
 * tail-repair decision.
 */
async function tryGroundingRepair(
  deps: HealDeps,
  options: HealOptions,
  file: string,
  groundingFile: string,
  overlay: HealOverlayStorage,
  plan: TrustedPlan,
  baseline: ReplayMeasurement & { readonly interrupted: false },
  nextAttemptOrdinal: () => number,
): Promise<ReplayMeasurement> {
  if (baseline.firstFailureIndex < 0 || baseline.firstFailureIndex >= plan.steps.length) return baseline;
  const failingStep = plan.steps[baseline.firstFailureIndex]!;
  const mode = groundingRecoveryModeForStep(failingStep);
  if (mode === 'none') return baseline;

  const grounding = JSON.parse(await overlay.storage.readText(groundingFile)) as GroundingDocument;
  const entry = grounding.entries[failingStep.id];

  if (mode === 'ai-retrace') {
    // The shape check only limits Stage 1 work; executeAiStep repeats the full
    // safety scan before it can replay or send a trace to a provider.
    const eligible = entry === undefined || entry.kind !== 'ai' || isLegacyShapedTrace(entry.trace);
    if (!eligible) return baseline;
  }

  const snapshot = overlay.snapshot();
  if (mode === 'element-reground') {
    // AI retracing retains its prior trace as a focused replay hint; only an
    // element retry clears the stale fingerprint that prevents rebinding.
    delete grounding.entries[failingStep.id];
    await overlay.storage.writeText(groundingFile, toCanonicalArtifactText(grounding as JsonValueT));
  }
  const measurement = await measureReplay(deps, options, file, overlay, plan, false, nextAttemptOrdinal());
  if (measurement.interrupted || measurement.firstFailureIndex <= baseline.firstFailureIndex) {
    overlay.restore(snapshot);
    return measurement.interrupted ? measurement : baseline;
  }
  return measurement;
}

/**
 * Records grants already owned by the untouched prefix before replacing a tail.
 *
 * The shared preparation policy validates all prompt grants, so pre-seeding
 * exact prefix offsets prevents a valid prefix-owned secret from appearing
 * uncovered when only replacement steps are provider-shaped input.
 */
function claimedPrefixGrantOffsets(plan: TrustedPlan, start: number, normalized: NormalizedTestMd): ReadonlySet<number> {
  const claimed = new Set<number>();
  const grants = extractSecretGrants(normalized);
  for (const step of plan.steps.slice(0, start)) {
    const spans = step.kind === 'action' && step.action === 'fill-secret'
      ? [step.secretGrantSpan]
      : step.kind === 'ai'
        ? (step.secrets ?? []).map((secret) => secret.sourceSpan)
        : [];
    for (const span of spans) {
      const grant = grants.find((candidate) => candidate.startLine === span.startLine);
      if (grant !== undefined) claimed.add(grant.offsetStart);
    }
  }
  return claimed;
}

/**
 * Replaces one failing step and verifies its full committed form before replay.
 *
 * The overlay snapshot keeps an invalid provider response or partial pair from
 * contaminating the later full-regeneration attempt; only a fully validated
 * candidate may become the next measurement input.
 */
async function trySingleStepRepair(
  deps: HealDeps,
  resolveAiExecutor: ResolveCaseAiExecutor,
  options: HealOptions,
  file: string,
  planFile: string,
  groundingFile: string,
  overlay: HealOverlayStorage,
  normalized: NormalizedTestMd,
  plan: TrustedPlan,
  baseline: ReplayMeasurement & { readonly interrupted: false },
  measurement: ReplayMeasurement & { readonly interrupted: false },
  repairHistory: readonly RepairHistoryEntry[],
  nextAttemptOrdinal: () => number,
): Promise<{ readonly plan: TrustedPlan; readonly measurement: ReplayMeasurement }> {
  if (measurement.firstFailureIndex >= plan.steps.length) return { plan, measurement };

  const snapshot = overlay.snapshot();
  const start = measurement.firstFailureIndex;
  const step = plan.steps[start]!;
  try {
    const executor = await resolveAiExecutor();
    const response = await executor.execute({
      prompt: buildGeneratorTask('Repair the requested failing plan step. Return exactly one replacement step with the requested ID, preserving its kind and obligations. Use the supplied test prompt, target definitions, plan continuity, and replay evidence to repair the failure.'),
      responseSchema: typedJsonSchema(GeneratedPlanResponse),
      context: {
        testMd: normalized,
        targets: plan.targets,
        replacement: {
          stepId: step.id,
          index: start,
        },
        baselineFailure: {
          explanation: baseline.replay.result.explanation,
          failingStep: baseline.firstFailureIndex < 0 ? undefined : plan.steps[baseline.firstFailureIndex],
          steps: toProviderReplayEvidence(baseline.replay.result.steps),
        },
        currentFailure: {
          explanation: measurement.replay.result.explanation,
          failingStep: measurement.firstFailureIndex < 0 ? undefined : plan.steps[measurement.firstFailureIndex],
          steps: toProviderReplayEvidence(measurement.replay.result.steps),
        },
        repairHistory,
      } as unknown as JsonValueT,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    const generated = GeneratedPlanResponse.parse(response.data);
    if (generated.steps.length !== 1 || generated.steps[0]?.id !== step.id) {
      throw new Error('Replacement IDs mismatch.');
    }

    const prepared = prepareInstructionCoveredSteps(generated, normalized, claimedPrefixGrantOffsets(plan, start, normalized));
    if (!prepared.success) throw new Error('Instruction coverage is invalid.');
    const replacement = normalizeAiStepSecretGrants(prepared.data)[0]!;
    if (!obligationFingerprintMatches(step, replacement)) throw new Error('Replacement obligations mismatch.');
    const candidate = PlanDocument.parse({
      ...plan,
      steps: [...plan.steps.slice(0, start), replacement, ...plan.steps.slice(start + 1)],
    });
    assertCommittedSecretAttributionSound(candidate, normalized);
    for (const step of candidate.steps) {
      if (step.kind !== 'ai') continue;
      const coverage = validateCommittedInstructionCoverage(step.instructionCoverage, normalized);
      if (!coverage.success) throw new Error('Instruction coverage is invalid.');
    }
    assertNoLiteralSecrets(candidate);

    const previousGrounding = JSON.parse(await overlay.storage.readText(groundingFile)) as GroundingDocument;
    const entries = Object.fromEntries(Object.entries(previousGrounding.entries).filter(([id]) => id !== step.id));
    await overlay.storage.writeText(planFile, toCanonicalArtifactText(candidate as JsonValueT));
    await overlay.storage.writeText(groundingFile, toCanonicalArtifactText({
      schemaVersion: GROUNDING_SCHEMA_VERSION,
      planDigest: computePlanDigest(candidate),
      entries,
    } as JsonValueT));

    const replay = await measureReplay(deps, options, file, overlay, candidate, false, nextAttemptOrdinal());
    if (replay.interrupted) {
      overlay.restore(snapshot);
      return { plan, measurement: { interrupted: true } };
    }
    if (replay.firstFailureIndex <= measurement.firstFailureIndex) {
      overlay.restore(snapshot);
      return { plan, measurement };
    }
    return { plan: candidate, measurement: replay };
  } catch {
    overlay.restore(snapshot);
    if (deps.signal?.aborted) return { plan, measurement: { interrupted: true } };
    return { plan, measurement };
  }
}

/**
 * Regenerates one whole case only after narrower repair has not completed it.
 *
 * A generation result that is interrupted, failed, or partially buffered is
 * never replayed: restoring the snapshot preserves the last trustworthy
 * evidence and keeps an inconsistent candidate out of a later commit.
 */
async function tryFullPlanRepair(
  deps: HealDeps,
  resolveAiExecutor: ResolveCaseAiExecutor,
  options: HealOptions,
  file: string,
  planFile: string,
  overlay: HealOverlayStorage,
  normalized: NormalizedTestMd,
  digest: string,
  plan: TrustedPlan,
  measurement: ReplayMeasurement & { readonly interrupted: false },
  nextAttemptOrdinal: () => number,
): Promise<{ readonly plan: TrustedPlan; readonly measurement: ReplayMeasurement; readonly stage3Error: AmbercastError | undefined; readonly replayed: boolean }> {
  const snapshot = overlay.snapshot();
  try {
    const aiExecutor = await resolveAiExecutor();
    const generated = await generate({
      storage: overlay.storage,
      layout: deps.layout,
      aiExecutor,
      events: deps.events,
      discoverTestFiles: deps.discoverTestFiles,
      config: deps.config,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }, {
      files: [file],
      list: false,
      strict: options.strict ?? false,
      force: true,
      allowEmpty: options.allowEmpty ?? false,
      dryRun: false,
      ...(options.target === undefined ? {} : { target: options.target }),
    });
    const item = generated.results[0];
    if (generated.interrupted || item === undefined) {
      overlay.restore(snapshot);
      return { plan, measurement: { interrupted: true }, stage3Error: undefined, replayed: false };
    }
    if (item.status !== 'generated') {
      overlay.restore(snapshot);
      return { plan, measurement, stage3Error: item.error, replayed: false };
    }

    const regeneratedPlan = (await readTrustedInstructionCoveredPlan(overlay.storage, planFile, digest, normalized)).plan;
    const replay = await measureReplay(deps, options, file, overlay, regeneratedPlan, false, nextAttemptOrdinal());
    if (replay.interrupted) {
      overlay.restore(snapshot);
      return { plan, measurement: replay, stage3Error: undefined, replayed: false };
    }
    return { plan: regeneratedPlan, measurement: replay, stage3Error: undefined, replayed: true };
  } catch (error) {
    overlay.restore(snapshot);
    if (deps.signal?.aborted) return { plan, measurement: { interrupted: true }, stage3Error: undefined, replayed: false };
    return {
      plan,
      measurement,
      stage3Error: error instanceof AmbercastErrorClass
        ? error
        : new UnexpectedCrashError('Healing regeneration failed.', undefined, { cause: error }),
      replayed: false,
    };
  }
}

/**
 * Builds a case row from the last actual replay and its conservative status.
 *
 * Full regeneration deliberately receives a binary pass rule because its new
 * step sequence has no stable index correspondence with the baseline plan.
 */
function caseOutcome(
  file: string,
  planFile: string,
  baseline: number,
  measurement: ReplayMeasurement & { readonly interrupted: false },
  plan: TrustedPlan,
  stage3Error: AmbercastError | undefined,
  fullPlanReplayed: boolean,
  stopReason: HealCaseOutcome['stopReason'],
): HealCaseOutcome {
  const repairOutcome = fullPlanReplayed
    ? (measurement.firstFailureIndex === plan.steps.length ? 'healed' : 'unresolved')
    : baseline === plan.steps.length
      ? 'no-changes-needed'
      : measurement.firstFailureIndex === plan.steps.length
        ? 'healed'
        : measurement.firstFailureIndex > baseline
          ? 'partially-healed'
          : 'unresolved';
  return {
    id: file,
    file,
    planFile,
    repairOutcome,
    steps: measurement.replay.result.steps,
    explanation: measurement.replay.result.explanation,
    durationMs: measurement.replay.result.durationMs,
    baselineFirstFailureIndex: baseline,
    finalFirstFailureIndex: measurement.firstFailureIndex,
    stopReason,
    stage3Error,
    finalReplayError: measurement.replay.error,
  };
}

/**
 * Executes one complete healing case while retaining its private overlay.
 *
 * Returning interruption separately prevents a partially attempted case from
 * being mistaken for a normal error or result. The outer batch owns skipped
 * identity reporting because only it knows the remaining selected suffix.
 *
 * @remarks
 * The repair phase iterates one frontier at a time. A visited-frontier set
 * records every non-sentinel frontier before Stage 1 so a replay that regresses
 * to an earlier index cannot dispatch work there again. Each iteration
 * measures first, then runs Stage 1, and runs Stage 2 only when Stage 1 does not
 * advance the frontier. Immediately before every provider dispatch, the
 * deadline takes precedence over the attempt ceiling; neither limit applies to
 * a non-dispatching recovery. A failed, discarded, exhausted, or revisited
 * incremental path enters Stage 3, whose unsuccessful full-plan replay
 * restores the best pre-Stage-3 incremental candidate. The resulting full
 * pass, resource-bound, and Stage-3 states are classified from the retained
 * measurement and stop reason, keeping measured progress separate from why
 * iteration stopped.
 */
async function healCase(deps: HealDeps, options: HealOptions, file: string): Promise<CaseProcessingResult> {
  const planFile = deps.layout.planPathFor(file);
  const groundingFile = deps.layout.groundingPathFor(file);
  const overlay = createHealOverlayStorage(
    deps.storage,
    { planPath: planFile, groundingPath: groundingFile },
    deps.containWrites(deps.layout.runsDirFor(file, deps.runId)),
  );
  const preflight = await preflightCase(deps, options, file, planFile, groundingFile, overlay);
  await overlay.capturePreimage();
  let resolvedAiExecutor: ResolvedAiExecutor | undefined;
  const resolveCaseAiExecutor: ResolveCaseAiExecutor = async () => {
    if (resolvedAiExecutor !== undefined) return resolvedAiExecutor;
    const executor = await deps.resolveAiExecutor(deps.signal);
    resolvedAiExecutor = executor;
    return executor;
  };
  const caseDeps: HealDeps = { ...deps, resolveAiExecutor: resolveCaseAiExecutor };
  let plan = preflight.plan;
  let attemptOrdinal = 0;
  const nextAttemptOrdinal = () => ++attemptOrdinal;
  const deadline = caseDeps.clock.monotonicMs() + caseDeps.config.heal.caseTimeoutMs;
  let measurement = await measureReplay(caseDeps, options, file, overlay, plan, true, nextAttemptOrdinal());
  if (measurement.interrupted) return measurement;

  const baseline = measurement.firstFailureIndex;
  let repairKind: RepairKind | undefined;
  let stage3Error: AmbercastError | undefined;
  let fullPlanReplayed = false;
  let stopReason: HealCaseOutcome['stopReason'] = 'settled';
  let stage3Required = baseline !== plan.steps.length;
  const structuralCeiling = plan.steps.length - baseline;
  const maxDispatches = Math.min(structuralCeiling, caseDeps.config.heal.maxStepRepairs ?? Infinity);
  let chargedDispatches = 0;
  const visitedFrontiers = new Set<number>();
  const repairHistory: RepairHistoryEntry[] = [];
  let remeasureOnEntry = true;

  const dispatchAllowed = (): boolean => {
    if (caseDeps.clock.monotonicMs() >= deadline) {
      stopReason = 'deadline';
      return false;
    }
    if (chargedDispatches >= maxDispatches) {
      stopReason = 'attempt-limit';
      return false;
    }
    chargedDispatches += 1;
    return true;
  };
  const groundingRepairDispatches = async (frontier: number, mode: ReturnType<typeof groundingRecoveryModeForStep>): Promise<boolean> => {
    if (mode !== 'ai-retrace') return false;
    const grounding = JSON.parse(await overlay.storage.readText(groundingFile)) as GroundingDocument;
    const entry = grounding.entries[plan.steps[frontier]!.id];
    return entry === undefined || entry.kind !== 'ai' || isLegacyShapedTrace(entry.trace);
  };

  while (stage3Required) {
    if (remeasureOnEntry) {
      measurement = await measureReplay(caseDeps, options, file, overlay, plan, false, nextAttemptOrdinal());
      if (measurement.interrupted) return measurement;
    }
    remeasureOnEntry = true;
    if (measurement.firstFailureIndex === plan.steps.length) {
      stage3Required = false;
      stopReason = 'settled';
      break;
    }
    if (measurement.firstFailureIndex === -1 || visitedFrontiers.has(measurement.firstFailureIndex)) break;
    const frontier = measurement.firstFailureIndex;
    visitedFrontiers.add(frontier);
    const mode = groundingRecoveryModeForStep(plan.steps[frontier]!);
    if (await groundingRepairDispatches(frontier, mode) && !dispatchAllowed()) break;
    const beforeGrounding = measurement;
    measurement = await tryGroundingRepair(caseDeps, options, file, groundingFile, overlay, plan, measurement, nextAttemptOrdinal);
    if (measurement.interrupted) return measurement;
    if (measurement.firstFailureIndex > frontier) {
      repairKind = mode === 'element-reground' ? 'grounding-element' : 'grounding-ai-retrace';
      continue;
    }
    if (mode === 'element-reground' || !dispatchAllowed()) break;
    const beforePlan = plan;
    const beforeMeasurement = measurement;
    const repaired = await trySingleStepRepair(caseDeps, resolveCaseAiExecutor, options, file, planFile, groundingFile, overlay, preflight.normalized, plan, beforeGrounding, measurement, repairHistory, nextAttemptOrdinal);
    plan = repaired.plan;
    measurement = repaired.measurement;
    if (measurement.interrupted) return measurement;
    if (plan === beforePlan || measurement.firstFailureIndex <= frontier) break;
    repairKind = 'tail';
    repairHistory.push({
      stepId: beforePlan.steps[frontier]!.id,
      before: beforePlan.steps[frontier]!,
      after: plan.steps[frontier]!,
      fromFirstFailureIndex: frontier,
      toFirstFailureIndex: measurement.firstFailureIndex,
      failureCategory: beforePlan.steps[frontier]!.kind,
    });
    if (beforeMeasurement === measurement) break;
  }

  if (stage3Required && measurement.firstFailureIndex < plan.steps.length) {
    if (caseDeps.clock.monotonicMs() >= deadline) {
      stopReason = 'deadline';
    } else {
      const bestPlan = plan;
      const bestMeasurement = measurement;
      const bestSnapshot = overlay.snapshot();
      const full = await tryFullPlanRepair(caseDeps, resolveCaseAiExecutor, options, file, planFile, overlay, preflight.normalized, preflight.digest, plan, measurement, nextAttemptOrdinal);
      if (full.measurement.interrupted) return full.measurement;
      stage3Error = full.stage3Error;
      if (full.replayed && full.measurement.firstFailureIndex === full.plan.steps.length) {
        plan = full.plan;
        measurement = full.measurement;
        repairKind = 'full-plan';
        fullPlanReplayed = true;
        stopReason = 'settled';
      } else {
        overlay.restore(bestSnapshot);
        plan = bestPlan;
        measurement = bestMeasurement;
      }
    }
  }

  const outcome = caseOutcome(file, planFile, baseline, measurement, plan, stage3Error, fullPlanReplayed, stopReason);
  const commit = (outcome.repairOutcome === 'healed' || outcome.repairOutcome === 'partially-healed') && overlay.hasBufferedWrites()
    ? commitFor(file, planFile, overlay, repairKind ?? 'grounding-element')
    : undefined;
  return { interrupted: false, outcome, commit };
}

/**
 * Measures and attempts repairs for selected cases without flushing real storage.
 *
 * @param deps - Replay capabilities projected to generation only when needed.
 * @param options - Selection, preview, and authorization inputs for the batch.
 * @returns Reporting facts plus per-case commit capabilities for improved candidates.
 * @remarks
 * Each case accumulates candidate artifacts in a private overlay across its
 * ordered attempts. The returned closures are the only route to real artifact
 * writes, allowing the runtime to confirm or discard every candidate after it
 * has enough information to describe the decision to a user.
 */
export async function heal(
  deps: HealDeps,
  options: HealOptions,
): Promise<HealBatchResult> {
  const tracker = new BatchInterruptionTracker(deps.signal);
  try {
    const files = options.files.length
      ? [...options.files]
      : (await deps.discoverTestFiles({
        testDir: deps.config.testDir,
        testMatch: deps.config.testMatch,
        testIgnore: deps.config.testIgnore,
      })).map((file) => `${deps.config.testDir}/${file}`);
    if (options.list) {
      return {
        outcome: { results: [], errors: [], noTestsFound: files.length === 0, listed: files.map((file) => ({ file })), skipped: [], interrupted: false },
        commits: new Map(),
      };
    }

    for (const file of files) tracker.addDiscovered(file, file);
    const results: HealCaseOutcome[] = [];
    const errors: HealCaseError[] = [];
    const commits = new Map<string, HealCaseCommit>();
    const interruptedMidCase = new Set<string>();

    for (const file of files) {
      if (tracker.interrupted) break;
      try {
        const processed = await healCase(deps, options, file);
        if (processed.interrupted) {
          interruptedMidCase.add(file);
          break;
        }
        results.push(processed.outcome);
        if (processed.commit !== undefined) commits.set(file, processed.commit);
      } catch (error) {
        errors.push({
          file,
          error: error instanceof AmbercastErrorClass
            ? error
            : new FsIoErrorClass('Healing failed for this case.', undefined, { cause: error }),
        });
      } finally {
        tracker.markTerminal(file);
      }
    }

    const pending = new Set([...tracker.pendingIdentities, ...interruptedMidCase]);
    return {
      outcome: {
        results,
        errors,
        noTestsFound: files.length === 0,
        listed: [],
        skipped: files.filter((file) => pending.has(file)).map((file) => ({ file })),
        interrupted: tracker.interrupted || interruptedMidCase.size > 0,
      },
      commits,
    };
  } finally {
    tracker.dispose();
  }
}

/**
 * Binds a buffered write to the repair that actually produced it.
 *
 * Confirmation needs enough concrete information to describe a pending change,
 * but the numbered internal ladder is intentionally not a user-facing contract.
 */
function commitFor(file: string, planFile: string, overlay: HealOverlayStorage, repairKind: RepairKind): HealCaseCommit {
  const healingSummary = repairKind === 'grounding-element'
    ? 're-resolved a changed page element'
    : repairKind === 'grounding-ai-retrace'
      ? 'retraced an outdated AI execution trace'
      : repairKind === 'tail'
        ? 'regenerated the remaining steps after the first failure'
        : 'regenerated the test from scratch';
  return {
    file,
    planFile,
    healingSummary,
    async commit() {
      try {
        await overlay.flush();
        return { outcome: 'committed' };
      } catch (error) {
        if (error instanceof IntegrityViolationError) {
          // Preserve the integrity classification; wrapping would misstate it as an environment failure.
          return { outcome: 'failed', error, partiallyWritten: [] };
        }
        const partiallyWritten = error instanceof Error && Array.isArray((error as Error & { written?: unknown }).written)
          ? (error as Error & { written: ('plan' | 'grounding')[] }).written
          : [];
        return {
          outcome: 'failed',
          error: new FsIoErrorClass(
            'Healing artifacts could not be committed.',
            { partiallyWritten },
            { cause: error },
          ),
          partiallyWritten,
        };
      }
    },
  };
}
