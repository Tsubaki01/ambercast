import type { AmbercastError } from '#core/errors/types.js';
import type { FsIoError } from '#core/errors/fs-io-error.js';
import type { StepResult } from '#report/schema.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { RunCaseOutcome, RunDeps } from './run.js';
import { run, readTrustedInstructionCoveredPlan } from './run.js';
import { generate, prepareInstructionCoveredSteps } from './generate.js';
import { inspectGroundingArtifact } from './check-grounding.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { PlanDocument, GeneratedPlanResponse, type GroundingDocument, type JsonValueT } from '#core/ir/schema.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { buildGeneratorTask, promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { resolveTarget } from '#core/target/resolve.js';
import { extractSecretGrants } from '#core/ir/secret-grant-source.js';
import { assertCommittedSecretAttributionSound, assertNoLiteralSecrets, normalizeAiStepSecretGrants } from './generator-secret-policy.js';
import { validateCommittedInstructionCoverage } from './instruction-coverage-policy.js';
import { FsIoError as FsIoErrorClass } from '#core/errors/fs-io-error.js';
import { AmbercastError as AmbercastErrorClass } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { BatchInterruptionTracker } from './batch-interruption.js';

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
 * Capabilities available to the healing state machine.
 *
 * @remarks
 * This extends `RunDeps` instead of copying its fields so replay keeps the
 * established dependency contract as it evolves. The state machine projects a
 * `GenerateDeps` value only when full regeneration is needed: it reuses the
 * common capabilities and resolves the lazy replay executor at that boundary,
 * where generation requires an already-resolved executor. Keeping the wider
 * surface here avoids making cache-hit-only healing resolve AI eagerly.
 */
// The named extension preserves heal's projection boundary without copying RunDeps.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HealDeps extends RunDeps {}

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
 * The two reached indices measure the furthest confirmed passed prefix before
 * and after repair, rather than counting failures in a fail-fast replay.
 * `-1` means dispatch never began for a nonempty plan, preserving the
 * distinction between a pre-launch failure and a failure at the first step.
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

  /** Furthest baseline passed-prefix index, with `-1` for pre-dispatch failure. */
  readonly baselineReachedIndex: number;

  /** Furthest final replay passed-prefix index, with the same sentinel meaning. */
  readonly finalReachedIndex: number;

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
 * after command settlement discards the capability wrapper.
 */
export type HealCommitOutcome =
  | { readonly outcome: 'committed' }
  | {
      readonly outcome: 'failed';
      readonly error: FsIoError;
      readonly partiallyWritten: readonly ('plan' | 'grounding')[];
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

  /** Plan companion that will be updated if the commit succeeds. */
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

  /** Writes only buffered tracked artifacts to the underlying storage. */
  flush(): Promise<void>;

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
 * @returns A storage view with snapshot, restore, and explicit flush controls.
 * @remarks
 * Buffering makes dry runs and non-improving candidates safe without changing
 * the storage port. A flush is intentionally an explicit capability: callers
 * decide whether it is authorized after observing the completed batch.
 */
export function createHealOverlayStorage(
  base: StorageAdapter,
  trackedPaths: { readonly planPath: string; readonly groundingPath: string },
): HealOverlayStorage {
  let buffered = new Map<string, string>();
  const tracked = (path: string) => path === trackedPaths.planPath || path === trackedPaths.groundingPath;
  const storage: StorageAdapter = {
    readText: async (path) => buffered.has(path) ? buffered.get(path)! : base.readText(path),
    exists: async (path) => buffered.has(path) ? true : base.exists(path),
    writeText: async (path, text) => {
      if (tracked(path)) {
        buffered.set(path, text);
        return;
      }
      await base.writeText(path, text);
    },
    readBinary: (path) => base.readBinary(path),
    writeBinary: (path, text) => base.writeBinary(path, text),
    listFiles: (path) => base.listFiles(path),
    ensureDir: (path) => base.ensureDir(path),
  };
  return {
    storage,
    hasBufferedWrites: () => buffered.size > 0,
    flush: async () => {
      const written: ('plan' | 'grounding')[] = [];
      try {
        for (const [kind, path] of [['plan', trackedPaths.planPath], ['grounding', trackedPaths.groundingPath]] as const) {
          if (!buffered.has(path)) continue;
          await base.writeText(path, buffered.get(path)!);
          written.push(kind);
        }
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error('Healing artifact write failed.'), { written });
      }
    },
    snapshot: () => new Map(buffered),
    restore: (snapshot) => { buffered = new Map(snapshot); },
  };
}

type TrustedPlan = Awaited<ReturnType<typeof readTrustedInstructionCoveredPlan>>['plan'];
type ResolvedAiExecutor = Awaited<ReturnType<HealDeps['resolveAiExecutor']>>;
type ResolveCaseAiExecutor = () => Promise<ResolvedAiExecutor>;

type ReplayMeasurement =
  | { readonly interrupted: true }
  | { readonly interrupted: false; readonly replay: RunCaseOutcome; readonly reachedIndex: number };

type RepairKind = 'grounding' | 'tail' | 'full-plan';

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
): Promise<ReplayMeasurement> {
  const batch = await run({ ...deps, storage: overlay.storage }, replayOptions(file, options, cacheOnly));
  const replay = batch.results[0];
  if (batch.interrupted || replay === undefined) return { interrupted: true };

  return {
    interrupted: false,
    replay,
    reachedIndex: reachedIndex(replay, plan),
  };
}

/**
 * Computes the furthest passed prefix while retaining pre-launch failures.
 *
 * `run()` has no step evidence when it fails before dispatch, and treating
 * that state as a failure of the first step would make repair scope falsely
 * specific. The negative sentinel remains ordered below every real index.
 */
function reachedIndex(replay: RunCaseOutcome, plan: TrustedPlan): number {
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

  const digest = computeInputsDigest({
    normalizedTestMd: normalized,
    schemaVersion: 2,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    targetDefinitions: target.definitions,
  });
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
 * Attempts the element-only grounding refresh without widening AI scope.
 *
 * Deleting an AI trace would request a fresh agentic execution, so only an
 * element entry is eligible for this narrow retry. All other failures proceed
 * directly to tail regeneration with their existing replay evidence.
 */
async function tryGroundingRepair(
  deps: HealDeps,
  options: HealOptions,
  file: string,
  groundingFile: string,
  overlay: HealOverlayStorage,
  plan: TrustedPlan,
  baseline: ReplayMeasurement & { readonly interrupted: false },
): Promise<ReplayMeasurement> {
  if (baseline.reachedIndex < 0 || baseline.reachedIndex >= plan.steps.length) return baseline;
  const grounding = JSON.parse(await overlay.storage.readText(groundingFile)) as GroundingDocument;
  const failingStep = plan.steps[baseline.reachedIndex]!;
  if (grounding.entries[failingStep.id]?.kind !== 'element') return baseline;

  delete grounding.entries[failingStep.id];
  await overlay.storage.writeText(groundingFile, toCanonicalArtifactText(grounding as JsonValueT));
  return measureReplay(deps, options, file, overlay, plan, false);
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
 * Replaces the failing tail and verifies its full committed form before replay.
 *
 * The overlay snapshot keeps an invalid provider response or partial pair from
 * contaminating the later full-regeneration attempt; only a fully validated
 * candidate may become the next measurement input.
 */
async function tryTailRepair(
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
): Promise<{ readonly plan: TrustedPlan; readonly measurement: ReplayMeasurement }> {
  if (measurement.reachedIndex >= plan.steps.length) return { plan, measurement };

  const snapshot = overlay.snapshot();
  const start = Math.max(0, measurement.reachedIndex);
  const ids = plan.steps.slice(start).map((step) => step.id);
  try {
    const executor = await resolveAiExecutor();
    const response = await executor.execute({
      prompt: buildGeneratorTask('Repair the requested failing plan tail. Return replacement steps only for the requested step IDs, preserving each ID and their original order. Use the supplied test prompt, target definitions, plan continuity, and replay evidence to repair the failure.'),
      responseSchema: typedJsonSchema(GeneratedPlanResponse),
      context: {
        testMd: normalized,
        targets: plan.targets,
        replacement: {
          stepIds: ids,
          startIndex: start,
          prefix: plan.steps.slice(0, start),
          tail: plan.steps.slice(start),
        },
        baselineFailure: {
          explanation: baseline.replay.result.explanation,
          failingStep: baseline.reachedIndex < 0 ? undefined : plan.steps[baseline.reachedIndex],
          steps: baseline.replay.result.steps,
        },
        currentFailure: {
          explanation: measurement.replay.result.explanation,
          failingStep: measurement.reachedIndex < 0 ? undefined : plan.steps[measurement.reachedIndex],
          steps: measurement.replay.result.steps,
        },
      } as unknown as JsonValueT,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    const generated = GeneratedPlanResponse.parse(response.data);
    const generatedIds = generated.steps.map((step) => step.id);
    if (generatedIds.length !== ids.length || new Set(generatedIds).size !== ids.length || ids.some((id) => !generatedIds.includes(id))) {
      throw new Error('Replacement IDs mismatch.');
    }

    const prepared = prepareInstructionCoveredSteps(generated, normalized, claimedPrefixGrantOffsets(plan, start, normalized));
    if (!prepared.success) throw new Error('Instruction coverage is invalid.');
    const replacementById = new Map(normalizeAiStepSecretGrants(prepared.data).map((step) => [step.id, step]));
    const candidate = PlanDocument.parse({
      ...plan,
      steps: [...plan.steps.slice(0, start), ...ids.map((id) => replacementById.get(id)!)],
    });
    assertCommittedSecretAttributionSound(candidate, normalized);
    for (const step of candidate.steps) {
      if (step.kind !== 'ai') continue;
      const coverage = validateCommittedInstructionCoverage(step.instructionCoverage, normalized);
      if (!coverage.success) throw new Error('Instruction coverage is invalid.');
    }
    assertNoLiteralSecrets(candidate);

    const previousGrounding = JSON.parse(await overlay.storage.readText(groundingFile)) as GroundingDocument;
    const entries = Object.fromEntries(Object.entries(previousGrounding.entries).filter(([id]) => !ids.includes(id)));
    await overlay.storage.writeText(planFile, toCanonicalArtifactText(candidate as JsonValueT));
    await overlay.storage.writeText(groundingFile, toCanonicalArtifactText({
      schemaVersion: 1,
      planDigest: computePlanDigest(candidate),
      entries,
    } as JsonValueT));

    const replay = await measureReplay(deps, options, file, overlay, candidate, false);
    if (replay.interrupted) overlay.restore(snapshot);
    return { plan: replay.interrupted ? plan : candidate, measurement: replay.interrupted ? { interrupted: true } : replay };
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
    const replay = await measureReplay(deps, options, file, overlay, regeneratedPlan, false);
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
  options: HealOptions,
  baseline: number,
  measurement: ReplayMeasurement & { readonly interrupted: false },
  plan: TrustedPlan,
  stage3Error: AmbercastError | undefined,
  fullPlanReplayed: boolean,
): HealCaseOutcome {
  const repairOutcome = fullPlanReplayed
    ? (measurement.reachedIndex === plan.steps.length ? 'healed' : 'unresolved')
    : baseline === plan.steps.length
      ? 'no-changes-needed'
      : measurement.reachedIndex === plan.steps.length
        ? 'healed'
        : measurement.reachedIndex > baseline
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
    baselineReachedIndex: baseline,
    finalReachedIndex: measurement.reachedIndex,
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
 */
async function healCase(deps: HealDeps, options: HealOptions, file: string): Promise<CaseProcessingResult> {
  const planFile = deps.layout.planPathFor(file);
  const groundingFile = deps.layout.groundingPathFor(file);
  const overlay = createHealOverlayStorage(deps.storage, { planPath: planFile, groundingPath: groundingFile });
  const preflight = await preflightCase(deps, options, file, planFile, groundingFile, overlay);
  let resolvedAiExecutor: ResolvedAiExecutor | undefined;
  const resolveCaseAiExecutor: ResolveCaseAiExecutor = async () => {
    if (resolvedAiExecutor !== undefined) return resolvedAiExecutor;
    const executor = await deps.resolveAiExecutor(deps.signal);
    resolvedAiExecutor = executor;
    return executor;
  };
  const caseDeps: HealDeps = { ...deps, resolveAiExecutor: resolveCaseAiExecutor };
  let plan = preflight.plan;
  let measurement = await measureReplay(caseDeps, options, file, overlay, plan, true);
  if (measurement.interrupted) return measurement;

  const baseline = measurement.reachedIndex;
  let repairKind: RepairKind | undefined;
  let stage3Error: AmbercastError | undefined;
  let fullPlanReplayed = false;

  if (baseline !== plan.steps.length) {
    const beforeGrounding = measurement;
    measurement = await tryGroundingRepair(caseDeps, options, file, groundingFile, overlay, plan, measurement);
    if (measurement.interrupted) return measurement;
    if (measurement !== beforeGrounding) repairKind = 'grounding';

    if (measurement.reachedIndex >= 0 && measurement.reachedIndex < plan.steps.length) {
      const planBeforeTail = plan;
      const tail = await tryTailRepair(caseDeps, resolveCaseAiExecutor, options, file, planFile, groundingFile, overlay, preflight.normalized, plan, beforeGrounding, measurement);
      plan = tail.plan;
      measurement = tail.measurement;
      if (measurement.interrupted) return measurement;
      if (plan !== planBeforeTail) repairKind = 'tail';
    }

    if (measurement.reachedIndex < plan.steps.length) {
      const full = await tryFullPlanRepair(caseDeps, resolveCaseAiExecutor, options, file, planFile, overlay, preflight.normalized, preflight.digest, plan, measurement);
      plan = full.plan;
      measurement = full.measurement;
      if (measurement.interrupted) return measurement;
      stage3Error = full.stage3Error;
      fullPlanReplayed = full.replayed;
      if (full.replayed) repairKind = 'full-plan';
    }
  }

  const outcome = caseOutcome(file, planFile, options, baseline, measurement, plan, stage3Error, fullPlanReplayed);
  const commit = (outcome.repairOutcome === 'healed' || outcome.repairOutcome === 'partially-healed') && overlay.hasBufferedWrites()
    ? commitFor(file, planFile, overlay, repairKind ?? 'grounding')
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
  const healingSummary = repairKind === 'grounding'
    ? 're-resolved a changed page element'
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
