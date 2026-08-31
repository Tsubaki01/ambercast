import type { AmbercastError } from '#core/errors/types.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import type { FsIoError } from '#core/errors/fs-io-error.js';
import type { StepResult } from '#report/schema.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { RunCaseOutcome, RunDeps } from './run.js';
import { run, readTrustedInstructionCoveredPlan, validateTrustedInstructionCoveredPlanText } from './run.js';
import { generate, prepareInstructionCoveredSteps } from './generate.js';
import { inspectGroundingArtifactText } from './check-grounding.js';
import { computePlanDigest } from '#core/ir/digest.js';
import { deriveCurrentPlanInputProvenance } from '#core/ai/plan-input-provenance.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { groundingRecoveryModeForStep } from '#core/ir/grounding-recovery-mode.js';
import { GROUNDING_SCHEMA_VERSION, PlanDocument, GeneratedPlanResponse, type GroundingDocument, type JsonValueT } from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { buildGeneratorTask } from '#core/ai/prompt-envelope.js';
import { resolveTarget } from '#core/target/resolve.js';
import { extractSecretGrants } from '#core/ir/secret-grant-source.js';
import { assertCommittedSecretAttributionSound, assertNoLiteralSecrets, enumerateSecretGrantClaims, normalizeAiStepSecretGrants } from './generator-secret-policy.js';
import type { StageTwoRejectionReason } from '#ports/system.js';
import { isLegacyShapedTrace, validateCommittedInstructionCoverage } from './instruction-coverage-policy.js';
import { FsIoError as FsIoErrorClass } from '#core/errors/fs-io-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { AmbercastError as AmbercastErrorClass } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { BatchInterruptionTracker } from './batch-interruption.js';
import { obligationFingerprintMatches } from '#core/ir/obligation-fingerprint.js';
import { joinPath } from '#core/paths.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { isRepairableNavigationFailure } from '#usecases/run.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import {
  buildStage2RepairContext,
  type RepairHistoryEntry,
  type ReplayMeasurement,
  type TrustedPlan,
} from './heal-provider-context.js';
import { createHealAiDispatchBudget } from './heal-ai-dispatch-budget.js';

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
   * Writes buffered tracked artifacts only while their validated snapshot preimage is intact.
   *
   * @remarks
   * The pre-pass compares plan and grounding in that order before selecting an
   * outcome. A mismatch or missing artifact on either side takes precedence over
   * any non-missing read failure, preserving the zero-write guarantee. Only when
   * neither side establishes a changed preimage does the first ordinary I/O
   * failure propagate. This accepts the existing boundary after comparison
   * finishes and before a write completes.
   */
  flush(): Promise<void>;

  /** Captures immutable buffered contents before an all-or-nothing stage attempt. */
  snapshot(): OverlaySnapshot;

  /** Discards stage-local buffering by restoring a prior in-memory snapshot. */
  restore(snapshot: OverlaySnapshot): void;
}

/**
 * Capability produced only after a case has validated the exact artifacts it
 * may later repair.
 *
 * @remarks
 * Preflight retains detached plan and grounding bytes in this capability's
 * closure and exposes no argument through
 * which a caller can substitute a preimage. Overlay creation is delayed until
 * this value exists, so an invalid artifact cannot acquire buffered-write
 * authority merely by entering the healing path. The module-private raw
 * factory below remains an implementation detail for the same reason.
 */
interface ValidatedHealPreflight {
  readonly normalized: NormalizedTestMd;
  readonly digest: string;
  readonly plan: TrustedPlan;

  /**
   * Creates the write-capable overlay associated with this validation.
   *
   * @param containedWrites - Evidence-directory writer already contained by
   * the runtime for this case.
   * @returns An overlay whose tracked reads return detached
   * validated snapshots before buffering and detached buffered bytes after it.
   *
   * @remarks
   * The narrow argument intentionally excludes both base storage and preimage
   * data. That keeps snapshot ownership inside the successful-preflight
   * closure, while allowing the runtime to retain its established evidence
   * containment boundary. Repeated creation is tolerated while preserving
   * that boundary.
   */
  createOverlay(containedWrites: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>): HealOverlayStorage;
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
function createHealOverlayStorage(
  base: StorageAdapter,
  trackedPaths: { readonly planPath: string; readonly groundingPath: string },
  containedWrites: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>,
  validatedSnapshots: { readonly plan: { readonly text: string; readonly bytes: Uint8Array }; readonly grounding: { readonly text: string; readonly bytes: Uint8Array } },
): HealOverlayStorage {
  let buffered = new Map<string, string>();
  const tracked = (path: string) => path === trackedPaths.planPath || path === trackedPaths.groundingPath;
  const snapshotFor = (path: string) => path === trackedPaths.planPath ? validatedSnapshots.plan : validatedSnapshots.grounding;
  const bufferedBytes = (path: string) => new TextEncoder().encode(buffered.get(path)!);
  const storage: StorageAdapter = {
    readText: async (path) => tracked(path) ? (buffered.has(path) ? buffered.get(path)! : snapshotFor(path).text) : base.readText(path),
    readTextSnapshot: async (path) => {
      if (!tracked(path)) return base.readTextSnapshot(path);
      const bytes = buffered.has(path) ? bufferedBytes(path) : new Uint8Array(snapshotFor(path).bytes);
      return { text: buffered.has(path) ? buffered.get(path)! : snapshotFor(path).text, bytes };
    },
    exists: async (path) => tracked(path) ? true : base.exists(path),
    writeText: async (path, text) => {
      if (tracked(path)) {
        buffered.set(path, text);
        return;
      }
      await containedWrites.writeText(path, text);
    },
    readBinary: async (path) => tracked(path) ? (buffered.has(path) ? bufferedBytes(path) : new Uint8Array(snapshotFor(path).bytes)) : base.readBinary(path),
    writeBinary: (path, text) => containedWrites.writeBinary(path, text),
    listFiles: (path) => base.listFiles(path),
    ensureDir: (path) => containedWrites.ensureDir(path),
  };
  return {
    storage,
    hasBufferedWrites: () => buffered.size > 0,
    flush: async () => {
      if (buffered.size === 0) return;

      const written: ('plan' | 'grounding')[] = [];
      try {
        const mismatched: ('plan' | 'grounding')[] = [];
        let firstReadError: unknown;
        for (const [kind, path, expected] of [
          ['plan', trackedPaths.planPath, validatedSnapshots.plan.bytes],
          ['grounding', trackedPaths.groundingPath, validatedSnapshots.grounding.bytes],
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
            firstReadError ??= error;
          }
        }
        if (mismatched.length > 0) {
          throw new IntegrityViolationError('Healing artifacts changed after preflight.', { mismatched });
        }
        if (firstReadError !== undefined) throw firstReadError;

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

type ResolvedAiExecutor = Awaited<ReturnType<HealDeps['resolveAiExecutor']>>;
type ResolveCaseAiExecutor = (signal?: AbortSignal) => Promise<ResolvedAiExecutor>;

/**
 * Separates an adopted Stage 2 candidate from an intentional rejection or an
 * interrupted attempt.
 *
 * The result makes the caller's control flow explicit instead of inferring a
 * rejection from object identity. The implementation checks for
 * cancellation before every rejection classification, maps executor-thrown
 * `AiResponseInvalidError` to `provider-error`, reserves `response-shape` for
 * local safe-parse and count checks after a valid executor response, and then
 * evaluates the fixed `id-mismatch`, `secret-attribution`, `coverage-invalid`,
 * `obligation-mismatch`, `literal-secret`, and `no-advance` sequence.
 */
type SingleStepRepairResult =
  | {
    readonly kind: 'accepted';
    readonly plan: TrustedPlan;
    readonly measurement: ReplayMeasurement & { readonly interrupted: false };
  }
  | { readonly kind: 'rejected'; readonly reason: StageTwoRejectionReason }
  | { readonly kind: 'interrupted' };

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
 * result row from absent evidence. The integrity check precedes
 * that interruption decision: an interrupted measurement otherwise discards
 * its replay and embedded error together, making a genuine integrity
 * violation permanently unobservable. Integrity observation has precedence
 * here, including when cancellation or interruption is present, except for
 * the closed repairable deterministic-navigation resolution class.
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
  if (replay?.error instanceof IntegrityViolationError && !isRepairableNavigationFailure(replay.error)) throw replay.error;
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

async function readStorageText(storage: StorageAdapter, path: string, message: string): Promise<string> {
  try {
    return await storage.readText(path);
  } catch (error) {
    throw new FsIoErrorClass(message, undefined, { cause: error });
  }
}

async function writeStorageText(storage: StorageAdapter, path: string, text: string, message: string): Promise<void> {
  try {
    await storage.writeText(path, text);
  } catch (error) {
    throw new FsIoErrorClass(message, undefined, { cause: error });
  }
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
): Promise<ValidatedHealPreflight> {
  const normalized = normalizeTestMd(await readStorageText(deps.storage, file, 'The test prompt could not be read.'));
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
  let planSnapshot: { readonly text: string; readonly bytes: Uint8Array };
  try {
    if (!(await deps.storage.exists(planFile))) {
      throw new MissingPlanError('The generated plan artifact is missing.', { planPath: planFile });
    }
    planSnapshot = await deps.storage.readTextSnapshot(planFile);
  } catch (error) {
    if (error instanceof MissingPlanError) throw error;
    throw new FsIoErrorClass('The generated plan could not be read.', undefined, { cause: error });
  }
  const plan = validateTrustedInstructionCoveredPlanText(planSnapshot.text, planFile, digest, normalized).plan;
  assertCommittedSecretAttributionSound(plan, normalized);

  let inspection;
  try {
    if (!(await deps.storage.exists(groundingFile))) {
      inspection = { kind: 'missing' } as const;
    } else {
      const groundingSnapshot = await deps.storage.readTextSnapshot(groundingFile);
      inspection = inspectGroundingArtifactText(groundingSnapshot.text, plan);
      if (inspection.kind === 'valid') {
        return {
          normalized,
          digest,
          plan,
          createOverlay: (containedWrites) => createHealOverlayStorage(
            deps.storage,
            { planPath: planFile, groundingPath: groundingFile },
            containedWrites,
            {
              plan: { text: planSnapshot.text, bytes: new Uint8Array(planSnapshot.bytes) },
              grounding: { text: groundingSnapshot.text, bytes: new Uint8Array(groundingSnapshot.bytes) },
            },
          ),
        };
      }
    }
  } catch (error) {
    throw new FsIoErrorClass('The grounding artifact could not be inspected.', undefined, { cause: error });
  }
  throw new FsIoErrorClass('The grounding artifact is not valid and current.');
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

  const grounding = JSON.parse(await readStorageText(overlay.storage, groundingFile, 'The grounding artifact could not be read.')) as GroundingDocument;
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
    await writeStorageText(overlay.storage, groundingFile, toCanonicalArtifactText(grounding as JsonValueT), 'The grounding artifact could not be written.');
  }
  const measurement = await measureReplay(deps, options, file, overlay, plan, false, nextAttemptOrdinal());
  if (measurement.interrupted || measurement.firstFailureIndex <= baseline.firstFailureIndex) {
    overlay.restore(snapshot);
    return measurement.interrupted ? measurement : baseline;
  }
  return measurement;
}

/**
 * Builds the prompt-grant offsets already owned outside a replacement step.
 *
 * Partial attribution receives only provider-shaped replacement steps, while
 * prompt-wide coverage still includes untouched prefix and suffix ownership.
 * The lookup excludes only `replacedIndex`, enumerates
 * the remaining claims, and resolves `ref`, `startLine`, and `endLine` exactly
 * to `grant.offsetStart` values. `offsetStart`, explicitly not `startLine`,
 * is the ownership key because distinct grants can otherwise collide.
 *
 * @param plan - The committed plan whose untouched steps retain ownership.
 * @param replacedIndex - The old step omitted so its replacement may reclaim a
 * matching prompt grant.
 * @param normalized - Canonical prompt from which exact grant offsets are read.
 * @returns Offset-based ownership seed for partial secret attribution.
 */
export function claimedRetainedGrantOffsets(
  plan: Pick<TrustedPlan, 'steps'>,
  replacedIndex: number,
  normalized: NormalizedTestMd,
): ReadonlySet<number> {
  const grants = extractSecretGrants(normalized);
  return new Set(enumerateSecretGrantClaims(plan.steps.filter((_, index) => index !== replacedIndex))
    .flatMap((claim) => grants.filter((grant) => (
      grant.ref === claim.ref
      && grant.startLine === claim.sourceSpan.startLine
      && grant.endLine === claim.sourceSpan.endLine
    )).map((grant) => grant.offsetStart)));
}

/**
 * Replaces one failing step and verifies its full committed form before replay.
 *
 * The overlay snapshot keeps an invalid provider response or partial pair from
 * contaminating the later full-regeneration attempt; only a fully validated
 * candidate may become the next measurement input. Its rejection finalizer
 * restores the snapshot, records the phase's rejection event, and then returns
 * the typed result. A phase rejected before work starts produces neither
 * event. This function's `ai-call` becomes observable by the real sink only
 * when its named dispatch is admitted, and that admitted event remains there
 * even if a later dispatch denies the phase. A denied dispatch discards only
 * its own still-pending event. The rejection recorded by `reject()` follows
 * the same phase-final decision: it flushes once for an admitted phase and is
 * discarded when that phase is denied.
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
  caseBaseline: {
    readonly plan: TrustedPlan;
    readonly measurement: ReplayMeasurement & { readonly interrupted: false };
  },
  measurement: ReplayMeasurement & { readonly interrupted: false },
  repairHistory: readonly RepairHistoryEntry[],
  nextAttemptOrdinal: () => number,
): Promise<SingleStepRepairResult> {
  if (measurement.firstFailureIndex >= plan.steps.length) return { kind: 'rejected', reason: 'no-advance' };

  const snapshot = overlay.snapshot();
  const start = measurement.firstFailureIndex;
  const step = plan.steps[start]!;
  const reject = (reason: StageTwoRejectionReason): SingleStepRepairResult => {
    overlay.restore(snapshot);
    if (deps.signal?.aborted) return { kind: 'interrupted' };
    deps.events.emit({ type: 'heal-stage2-rejected', stepId: step.id, reason });
    return { kind: 'rejected', reason };
  };
  const propagate = (error: unknown): SingleStepRepairResult => {
    overlay.restore(snapshot);
    if (deps.signal?.aborted) return { kind: 'interrupted' };
    throw error;
  };

  let executor: ResolvedAiExecutor;
  try {
    executor = await resolveAiExecutor();
  } catch (error) {
    if (deps.signal?.aborted) return reject('provider-error');
    if (error instanceof AiExecutorUnavailableError || error instanceof AiResponseInvalidError) return reject('provider-error');
    return propagate(error);
  }

  let response;
  try {
    deps.events.emit({ type: 'ai-call', stepId: step.id });
    response = await executor.execute({
      prompt: buildGeneratorTask('Repair the requested failing plan step. Return exactly one replacement step with the requested ID, preserving its kind and obligations. Use the supplied test prompt, target definitions, plan continuity, and replay evidence to repair the failure.'),
      responseSchema: typedJsonSchema(GeneratedPlanResponse),
      context: buildStage2RepairContext({
        normalizedTestMd: normalized,
        baseline: caseBaseline,
        current: { plan, measurement },
        repairHistory,
      }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch (error) {
    if (deps.signal?.aborted) return reject('provider-error');
    if (error instanceof AiExecutorUnavailableError || error instanceof AiResponseInvalidError) return reject('provider-error');
    return propagate(error);
  }

  const parsed = GeneratedPlanResponse.safeParse(response.data);
  if (!parsed.success || parsed.data.steps.length !== 1) return reject('response-shape');
  const generated = parsed.data;
  if (generated.steps[0]?.id !== step.id) return reject('id-mismatch');

  let prepared;
  try {
    prepared = prepareInstructionCoveredSteps(generated, normalized, claimedRetainedGrantOffsets(plan, start, normalized));
  } catch (error) {
    if (error instanceof SecretGrantUnattributableError) return reject('secret-attribution');
    return propagate(error);
  }
  if (!prepared.success) return reject('coverage-invalid');
  const replacement = normalizeAiStepSecretGrants(prepared.data)[0]!;
  if (!obligationFingerprintMatches(step, replacement)) return reject('obligation-mismatch');
  const candidate = PlanDocument.parse({
      ...plan,
      steps: [...plan.steps.slice(0, start), replacement, ...plan.steps.slice(start + 1)],
  });
  try {
    assertCommittedSecretAttributionSound(candidate, normalized);
  } catch (error) {
    if (error instanceof SecretGrantUnattributableError) return reject('secret-attribution');
    return propagate(error);
  }
  for (const candidateStep of candidate.steps) {
    if (candidateStep.kind !== 'ai') continue;
    const coverage = validateCommittedInstructionCoverage(candidateStep.instructionCoverage, normalized);
    if (!coverage.success) return reject('coverage-invalid');
  }
  try {
    assertNoLiteralSecrets(candidate);
  } catch (error) {
    if (error instanceof SecretLiteralRejectedError) return reject('literal-secret');
    return propagate(error);
  }

  let previousGrounding: GroundingDocument;
  try {
    previousGrounding = JSON.parse(await readStorageText(overlay.storage, groundingFile, 'The grounding artifact could not be read.')) as GroundingDocument;
    const entries = Object.fromEntries(Object.entries(previousGrounding.entries).filter(([id]) => id !== step.id));
    await writeStorageText(overlay.storage, planFile, toCanonicalArtifactText(candidate as JsonValueT), 'The repaired plan could not be written.');
    await writeStorageText(overlay.storage, groundingFile, toCanonicalArtifactText({
      schemaVersion: GROUNDING_SCHEMA_VERSION,
      planDigest: computePlanDigest(candidate),
      entries,
    } as JsonValueT), 'The repaired grounding artifact could not be written.');
  } catch (error) {
    return propagate(error);
  }

  const replay = await measureReplay(deps, options, file, overlay, candidate, false, nextAttemptOrdinal());
  if (replay.interrupted) {
    overlay.restore(snapshot);
    return { kind: 'interrupted' };
  }
  if (replay.firstFailureIndex <= measurement.firstFailureIndex) return reject('no-advance');
  return { kind: 'accepted', plan: candidate, measurement: replay };
}

/**
 * Regenerates one whole case only after narrower repair has not completed it.
 *
 * A generation result that is interrupted, failed, or partially buffered is
 * never replayed: restoring the snapshot preserves the last trustworthy
 * evidence and keeps an inconsistent candidate out of a later commit. The
 * sole exception is a non-repairable integrity violation, which is rethrown
 * before restoration so it remains fail-closed.
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
      if (item.error instanceof IntegrityViolationError && !isRepairableNavigationFailure(item.error)) throw item.error;
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
    // The non-repairable IntegrityViolationError rethrow precedes snapshot
    // restoration and generic stage-three packaging, so every such violation
    // remains fail-closed instead of becoming a recoverable regeneration
    // error, including ones thrown directly by generation.
    if (error instanceof IntegrityViolationError && !isRepairableNavigationFailure(error)) throw error;
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
 * to an earlier index cannot dispatch work there again. Each iteration uses
 * its retained measurement, runs Stage 1, and runs Stage 2 only when Stage 1
 * does not advance the frontier. The deadline is checked both at phase entry,
 * where it can deny even a non-dispatching recovery, and immediately before
 * every real dispatch inside an admitted phase; the attempt ceiling applies
 * only to chargeable dispatches within an admitted incremental phase. A failed,
 * discarded, exhausted, or revisited
 * incremental path enters Stage 3, whose unsuccessful full-plan replay
 * restores the best pre-Stage-3 incremental candidate. The resulting full
 * pass, resource-bound, and Stage-3 states are classified from the retained
 * measurement and stop reason, keeping measured progress separate from why
 * iteration stopped.
 */
async function healCase(deps: HealDeps, options: HealOptions, file: string): Promise<CaseProcessingResult> {
  const planFile = deps.layout.planPathFor(file);
  const groundingFile = deps.layout.groundingPathFor(file);
  const preflight = await preflightCase(deps, options, file, planFile, groundingFile);
  const overlay = preflight.createOverlay(deps.containWrites(deps.layout.runsDirFor(file, deps.runId)));
  const caseDeps = deps;
  let plan = preflight.plan;
  let attemptOrdinal = 0;
  const nextAttemptOrdinal = () => ++attemptOrdinal;
  const deadline = caseDeps.clock.monotonicMs() + caseDeps.config.heal.caseTimeoutMs;
  const budget = createHealAiDispatchBudget({
    resolveAiExecutor: deps.resolveAiExecutor,
    signal: deps.signal,
    clock: deps.clock,
    events: caseDeps.events,
    deadlineMs: deadline,
    maxDispatches: caseDeps.config.heal.maxStepRepairs ?? Infinity,
  });
  const cacheBaseline = await measureReplay(caseDeps, options, file, overlay, plan, true, nextAttemptOrdinal());
  if (cacheBaseline.interrupted) return cacheBaseline;
  let measurement = cacheBaseline;

  let stopReason: HealCaseOutcome['stopReason'] = 'settled';
  if (measurement.firstFailureIndex !== plan.steps.length) {
    const snapshot = overlay.snapshot();
    const initial = await budget.runPhase('incremental', (phaseDeps) => measureReplay(
      { ...caseDeps, resolveAiExecutor: phaseDeps.resolveAiExecutor, events: phaseDeps.events },
      options,
      file,
      overlay,
      plan,
      false,
      nextAttemptOrdinal(),
    ));
    if (!initial.admitted) {
      overlay.restore(snapshot);
      stopReason = initial.deniedReason;
    } else if (!initial.result.ok) {
      throw initial.result.error;
    } else {
      const initialMeasurement = initial.result.value;
      if (initialMeasurement.interrupted) return initialMeasurement;
      measurement = initialMeasurement;
    }
  }
  const caseBaseline = { plan: preflight.plan, measurement: cacheBaseline };
  const baselineFirstFailureIndex = cacheBaseline.firstFailureIndex;
  let repairKind: RepairKind | undefined;
  let stage3Error: AmbercastError | undefined;
  let fullPlanReplayed = false;
  let stage3Required = baselineFirstFailureIndex !== plan.steps.length;
  const visitedFrontiers = new Set<number>();
  const repairHistory: RepairHistoryEntry[] = [];

  while (stage3Required && stopReason === 'settled') {
    if (measurement.firstFailureIndex === plan.steps.length) {
      stage3Required = false;
      stopReason = 'settled';
      break;
    }
    if (measurement.firstFailureIndex === -1 || visitedFrontiers.has(measurement.firstFailureIndex)) break;
    const frontier = measurement.firstFailureIndex;
    visitedFrontiers.add(frontier);
    const mode = groundingRecoveryModeForStep(plan.steps[frontier]!);
    const stage1Snapshot = overlay.snapshot();
    const stage1 = await budget.runPhase('incremental', (phaseDeps) => tryGroundingRepair(
      { ...caseDeps, resolveAiExecutor: phaseDeps.resolveAiExecutor, events: phaseDeps.events }, options, file, groundingFile, overlay, plan, measurement, nextAttemptOrdinal,
    ));
    if (!stage1.admitted) {
      overlay.restore(stage1Snapshot);
      stopReason = stage1.deniedReason;
      break;
    }
    if (!stage1.result.ok) throw stage1.result.error;
    const stage1Measurement = stage1.result.value;
    if (stage1Measurement.interrupted) return stage1Measurement;
    measurement = stage1Measurement;
    if (measurement.firstFailureIndex > frontier) {
      repairKind = mode === 'element-reground' ? 'grounding-element' : 'grounding-ai-retrace';
      continue;
    }
    const stage2Snapshot = overlay.snapshot();
    const beforePlan = plan;
    const beforeMeasurement = measurement;
    const stage2 = await budget.runPhase('incremental', (phaseDeps) => trySingleStepRepair(
      { ...caseDeps, resolveAiExecutor: phaseDeps.resolveAiExecutor, events: phaseDeps.events }, phaseDeps.resolveAiExecutor, options, file, planFile, groundingFile, overlay, preflight.normalized, plan, caseBaseline, measurement, repairHistory, nextAttemptOrdinal,
    ));
    if (!stage2.admitted) {
      overlay.restore(stage2Snapshot);
      stopReason = stage2.deniedReason;
      break;
    }
    if (!stage2.result.ok) throw stage2.result.error;
    const repaired = stage2.result.value;
    if (repaired.kind === 'interrupted') return { interrupted: true };
    if (repaired.kind === 'rejected') break;
    plan = repaired.plan;
    if (repaired.measurement.interrupted) return { interrupted: true };
    measurement = repaired.measurement;
    if (measurement.firstFailureIndex <= frontier) break;
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

  if (stage3Required && measurement.firstFailureIndex < plan.steps.length && stopReason !== 'deadline') {
      const bestPlan = plan;
      const bestMeasurement = measurement;
      const bestSnapshot = overlay.snapshot();
      const fullPhase = await budget.runPhase('stage3', (phaseDeps) => tryFullPlanRepair(
        { ...caseDeps, resolveAiExecutor: phaseDeps.resolveAiExecutor, events: phaseDeps.events }, phaseDeps.resolveAiExecutor, options, file, planFile, overlay, preflight.normalized, preflight.digest, plan, measurement, nextAttemptOrdinal,
      ));
      if (!fullPhase.admitted) {
        overlay.restore(bestSnapshot);
        stopReason = fullPhase.deniedReason;
      } else if (!fullPhase.result.ok) {
        throw fullPhase.result.error;
      } else {
      const full = fullPhase.result.value;
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

  const outcome = caseOutcome(file, planFile, baselineFirstFailureIndex, measurement, plan, stage3Error, fullPlanReplayed, stopReason);
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
    const selectedFiles = options.files.length
      ? [...options.files]
      : (await deps.discoverTestFiles({
        testDir: deps.config.testDir,
        testMatch: deps.config.testMatch,
        testIgnore: deps.config.testIgnore,
      })).map((file) => `${deps.config.testDir}/${file}`);
    // F5i keeps each case's independent budget and commit capability unique.
    const files = Array.from(new Set(selectedFiles));
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
            : new UnexpectedCrashError('Healing failed for this case.', undefined, { cause: error }),
        });
      } finally {
        tracker.markTerminal(file);
      }
    }

    const pending = new Set([...tracker.pendingIdentities, ...interruptedMidCase]);
    const skipped = files
      .filter((file) => pending.has(file) && !errors.some((error) => error.file === file))
      .map((file) => ({ file }));
    return {
      outcome: {
        results,
        errors,
        noTestsFound: files.length === 0,
        listed: [],
        skipped,
        // A skipped file can only result from the batch stopping early; an
        // erroring file is excluded so it is never reported twice as skipped.
        interrupted: skipped.length > 0,
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
