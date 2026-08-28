/**
 * Defines the read-only freshness inspection for committed plan artifacts and
 * their grounding companions.
 *
 * Check deliberately observes existing files instead of composing an AI
 * provider, browser driver, event sink, or mutable storage capability. That
 * boundary keeps a CI freshness gate reproducible and makes any write or
 * execution dependency an explicit type-level design change.
 */

import type { ResolvedConfig } from '#core/config/schema.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { planProducerBundleFingerprint } from '#core/ai/plan-producer-bundle.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest } from '#core/ir/digest.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import {
  PLAN_SCHEMA_VERSION,
  PlanDocument,
  type InstructionCoveredPlanDocument,
  type JsonValueT,
  type StepId,
} from '#core/ir/schema.js';
import { GROUNDING_SUFFIX, PLAN_SUFFIX, type LayoutResolver } from '#core/layout/resolve.js';
import { matchesTestPatterns } from '#core/discovery/pattern-match.js';
import { joinPath, relativeWithin } from '#core/paths.js';
import { resolveTarget } from '#core/target/resolve.js';
import type { ReadStorageAdapter } from '#ports/storage.js';
import type { CheckResult } from '#report/schema.js';
import type {
  InstructionCoverageIssue,
  InstructionCoverageResult,
  TrustedInstructionCriterion,
} from './instruction-coverage-policy.js';
import { validateCommittedInstructionCoverage } from './instruction-coverage-policy.js';
import { BatchInterruptionTracker } from './batch-interruption.js';
import { inspectGroundingArtifact } from './check-grounding.js';

/**
 * Performs the prompt-dependent committed-coverage portion of freshness.
 *
 * @param plan - Strict, canonical Plan-v2 document under inspection.
 * @param normalizedTestMd - Current canonical source prompt.
 * @returns Trusted local criterion projections for each AI step, or the
 * complete deterministic issue list.
 * @remarks
 * Check has no AI, browser, or write capability. It invokes the same committed
 * span policy as generation and run; any impossible,
 * whitespace-only, duplicate, or out-of-order criterion makes the artifact
 * stale. Plan version 2 and its generator-policy fingerprint participate in
 * `inputsDigest`, while Grounding version 1 remains outside this read-only Plan
 * decision.
 */
export function inspectCommittedInstructionCoverage(
  plan: InstructionCoveredPlanDocument,
  normalizedTestMd: NormalizedTestMd,
): InstructionCoverageResult<ReadonlyMap<StepId, readonly TrustedInstructionCriterion[]>> {
  const trusted = new Map<StepId, readonly TrustedInstructionCriterion[]>();
  const issues: InstructionCoverageIssue[] = [];
  for (const step of plan.steps) {
    if (step.kind !== 'ai') continue;
    const result = validateCommittedInstructionCoverage(step.instructionCoverage, normalizedTestMd);
    if (!result.success) issues.push(...result.issues);
    else trusted.set(step.id, result.data);
  }
  return issues.length === 0 ? { success: true, data: trusted } : { success: false, issues };
}

/**
 * Selection and exit-policy choices for one freshness inspection batch.
 */
export interface CheckOptions {
  /** Already-absolute literal test paths supplied by runtime, or an empty list to use configured test discovery. */
  readonly files: readonly string[];

  /** Optional explicit target name; an invalid name never falls back. */
  readonly target?: string;

  /** Whether a genuinely empty inspection may succeed. */
  readonly allowEmpty: boolean;

  /**
   * Whether discovery-only listing returns selected paths without inspection.
   *
   * @remarks
   * The short-circuit is an atomic boundary after selection: it emits
   * only identity-only `listed` rows and does not read plans or grounding,
   * validate digests, scan artifacts, resolve an implicit target, or register
   * interruptible inspection work. This scope is intentionally limited to
   * `options.list`. A zero-selection invocation without list mode continues to
   * artifact scans, so orphan-only integrity findings retain their existing
   * behavior.
   */
  readonly list: boolean;
}

/**
 * Dependencies available to the read-only freshness algorithm.
 *
 * @remarks
 * This surface intentionally omits aiExecutor, resolveAiExecutor,
 * browserDriver, secrets, clock, and events. Their absence is structural: an
 * inspection neither executes work nor measures or emits lifecycle activity,
 * so exposing any of them would weaken the read-only command boundary rather
 * than merely support an unused implementation detail.
 */
export interface CheckDeps {
  /**
   * The only storage capabilities check may use.
   *
   * This no-write contract is an invariant of check's design, not merely a
   * description of its current calls: inspection must never gain authority to
   * modify storage. Reads and existence checks are sufficient for
   * every plan, prompt, grounding companion, and orphan finding.
   */
  readonly storage: ReadStorageAdapter;

  /** Deterministic companion-path and inverse orphan-path arithmetic. */
  readonly layout: LayoutResolver;

  /**
   * Runtime-owned recursive discovery for prompts and companion artifacts.
   *
   * The callback keeps filesystem traversal outside this usecase while letting
   * artifact scans apply their own fixed match patterns without introducing a
   * second traversal port.
   */
  readonly discoverTestFiles: (config: {
    readonly testDir: string;
    readonly testMatch: readonly string[];
    readonly testIgnore: readonly string[];
  }) => Promise<readonly string[]>;

  /*
   * The resolved configuration fields that affect selection and digest inputs.
   * grounding is the exception: it affects only the report-status mapping
   * for an already-fresh plan's grounding companion, never selection or the
   * digest itself.
   */
  readonly config: Pick<
    ResolvedConfig,
    'testDir' | 'testMatch' | 'testIgnore' | 'targets' | 'defaultTarget' | 'grounding'
  >;

  /**
   * Caller cancellation observed across selected, plan-orphan, and
   * grounding-orphan inspection phases.
   *
   * Terminal findings and case errors remain visible, while known identities
   * not yet inspected become strict identity-only skipped rows.
   */
  readonly signal?: AbortSignal;
}

/**
 * A report-compatible freshness finding for one test or orphaned companion.
 *
 * @remarks
 * This direct alias keeps the usecase and report contracts aligned while
 * allowing report construction to preserve outcomes without unsafe casting or
 * a duplicate mapping contract. Completed inspection findings carry `id`,
 * `file`, `planFile`, `status`, and a fixed path-free `reason`, plus the
 * relevant optional `groundingFile` or `artifactFile`. Discovery-only
 * `listed`, inverse-incapable `invalid-artifact-name`, and interruption-only
 * `skipped` rows each use their dedicated minimal evidence shape.
 */
export type CheckFileOutcome = CheckResult;

/**
 * A storage read failure isolated to one selected test file.
 */
export interface CheckFileError {
  /** The selected prompt whose required read failed. */
  readonly file: string;

  /**
   * The classified storage failure for that prompt, its existing plan, or an
   * existing grounding companion.
   *
   * This intentionally accepts only `FsIoError`: freshness states belong in
   * `CheckFileOutcome`, while target resolution remains a command-level
   * failure. A grounding read rejection becomes this per-file error rather
   * than an invalid-grounding finding or a deferred fresh row, while later
   * files remain inspectable. The narrow type prevents either category from
   * being silently reintroduced as a case error that the report boundary
   * cannot represent.
   */
  readonly error: FsIoError;
}

/**
 * Ordered findings, isolated errors, and interruption state from one
 * freshness inspection.
 *
 * One ordered work-key tracker spans selected tests and the valid inverse
 * identities learned by the plan and grounding orphan scans. Distinct work
 * keys may share a public identity, allowing both terminal artifact findings
 * to remain visible. A latched cancellation stops the active phase and
 * suppresses later phases, while retaining terminal findings and exposing
 * known nonterminal identities as skipped. The batch-level fact remains
 * separate so report construction emits interruption only at run scope.
 */
export interface CheckOutcome {
  /** Freshness and orphan findings in deterministic inspection order. */
  readonly results: readonly CheckFileOutcome[];

  /** I/O failures that affect one selected file without stopping later files. */
  readonly errors: readonly CheckFileError[];

  /**
   * Whether neither selected tests nor artifact-scan findings exist.
   *
   * The exact formula is
   * `!interrupted && selectedWorkItems.length === 0 && orphanFindingRows.length === 0`
   * after every non-suppressed discovery phase completes. Healthy companion
   * candidates that emit no finding do not change the existing zero-match
   * meaning, while known pending work prevents a cancelled batch from being
   * reported as empty. `options.list` bypasses this formula entirely and
   * always reports `false`, because its discovery-only short circuit never
   * reaches the phases measured here.
   */
  readonly noTestsFound: boolean;

  /** Whether cancellation intersected discovered nonterminal work. */
  readonly interrupted: boolean;
}

/**
 * Inspects selected plans for freshness and the configured test tree for
 * orphaned companion artifacts.
 *
 * @param deps - Read-only storage, layout, discovery, configuration, and
 * optional cancellation dependencies.
 * @param options - Literal selection, target, and zero-match reporting policy.
 * @returns Ordered freshness findings, case-scoped I/O failures, the
 * zero-match fact needed by report exit policy, and whether cancellation
 * intersected known nonterminal work.
 * @throws {TargetUnresolvedError} When an explicit target is not configured,
 * or when the selected-file set is non-empty and no target can be selected
 * implicitly.
 * @throws A rejection from `discoverTestFiles` during test selection, plan
 * orphan scanning, or grounding orphan scanning propagates without
 * reclassification.
 * @remarks
 * The shared core resolver treats an explicit target as a caller-supplied
 * validity requirement, so an invalid explicit name resolves before discovery
 * and throws its classified failure at this command boundary without fallback.
 * When the selected-file set is non-empty, implicit selection runs once before
 * per-file work and applies the loader-validated default followed by the sole
 * enumerable own target. With zero selected files, that resolution is skipped,
 * allowing an orphan-only scan to avoid an unrelated target ambiguity.
 * Selected files are sequential so a case-scoped storage failure leaves later
 * selections inspectable. Their occurrence-qualified scheduling keys are
 * `selected:<index>:<file>`; plan and grounding candidates use
 * `plan:<index>:<artifact-path>` and
 * `grounding:<index>:<artifact-path>`. These keys preserve duplicate
 * occurrence rows and keep plan and grounding findings independently terminal
 * even when they derive the same public test identity.
 *
 * After each plan or grounding discovery call resolves, the usecase
 * inverse-maps every valid returned element and registers that whole response
 * in order before evaluating the interruption latch. Each registered work key
 * becomes terminal when its `exists(testPath)` inspection completes, including
 * the healthy no-finding case that emits no result or case error. Pending
 * public identities retain first-seen work order and are deduplicated only for
 * skipped-row emission; a terminal sibling row with the same identity remains
 * visible.
 *
 * Only a latched interruption suppresses a later phase. A raw aborted signal
 * with no known pending work permits the next discovery phase, so an empty plan
 * response cannot hide grounding-only work. Once pending plan work latches
 * interruption, grounding discovery and all later storage calls are
 * suppressed. The listener is disposed in `finally` after both normal
 * completion and rejection.
 *
 * Freshness accepts only canonical plans whose digest reflects the normalized
 * prompt and the resolved target. Grounding content is deliberately excluded:
 * it is a recoverable replay cache rather than a freshness input. `--list`
 * handling ends immediately after selection, before implicit target
 * resolution or any inspection phase, so even an empty listing succeeds
 * without relying on the ordinary zero-match path.
 *
 * Artifact detection remains a whole-tree integrity invariant, independent of
 * literal selection and selected-file outcomes. Each scan enumerates by
 * its fixed suffix without applying configured ignores, then inverse-derive a
 * virtual test path and judge that path against `testMatch` and `testIgnore`.
 * An inverse-incapable artifact becomes an `invalid-artifact-name` finding in
 * `orphanFindings`, which preserves the existing zero-match formula and puts
 * it before that phase's later orphan findings. The registration and terminal
 * loops remain separate so the batch tracker still knows the whole discovered
 * phase before asynchronous existence checks begin. Stable ordering follows
 * selected findings with plans before grounding. Orphan grounding findings
 * place the artifact path only in `groundingFile` and use the exact path-free reason
 * `No corresponding test file exists for this grounding artifact.`, so free
 * text cannot disclose a host path. These boundaries preserve shared exit
 * priority between integrity findings, case errors, interruption, and genuine
 * zero matches.
 */
export async function check(deps: CheckDeps, options: CheckOptions): Promise<CheckOutcome> {
  const tracker = new BatchInterruptionTracker(deps.signal);
  try {
  const explicitSelection = options.target === undefined
    ? undefined
    : resolveTarget({
      targets: deps.config.targets,
      defaultTarget: deps.config.defaultTarget,
      explicitTarget: options.target,
    });
  if (explicitSelection instanceof TargetUnresolvedError) {
    throw explicitSelection;
  }

  const selectedTestFiles = options.files.length === 0
    ? (await deps.discoverTestFiles({
      testDir: deps.config.testDir,
      testMatch: deps.config.testMatch,
      testIgnore: deps.config.testIgnore,
    })).map((path) => joinPath(deps.config.testDir, path))
    : [...options.files];

  /*
   * The list-only return belongs exactly here, after selection but
   * before implicit target resolution and every inspection phase. That atomic
   * boundary makes listing lenient for literal paths and prevents plan, grounding,
   * digest, artifact-scan, and interruption work. It must not become a general
   * zero-selection return: ordinary zero-selection checks still need orphan
   * scans, whereas only `options.list` bypasses them.
   */
  if (options.list) {
    return {
      results: selectedTestFiles.map((file) => ({ id: file, file, status: 'listed' as const })),
      errors: [],
      noTestsFound: false,
      interrupted: false,
    };
  }

  const results: CheckFileOutcome[] = [];
  const errors: CheckFileError[] = [];

  if (selectedTestFiles.length > 0) {
    const targetSelection = explicitSelection ?? resolveTarget({
      targets: deps.config.targets,
      defaultTarget: deps.config.defaultTarget,
      explicitTarget: undefined,
    });
    if (targetSelection instanceof TargetUnresolvedError) {
      throw targetSelection;
    }

    for (const [index, file] of selectedTestFiles.entries()) tracker.addDiscovered(`selected:${index}:${file}`, file);
    for (const [index, file] of selectedTestFiles.entries()) {
      const workKey = `selected:${index}:${file}`;
      if (tracker.interrupted) {
        break;
      }
      try {

      const planFile = deps.layout.planPathFor(file);
      const identity = { id: file, file, planFile };
      if (!(await deps.storage.exists(planFile))) {
        results.push({
          ...identity,
          status: 'missing-plan',
          reason: 'The plan artifact does not exist.',
        });
        continue;
      }

      let planText: string;
      try {
        planText = await deps.storage.readText(planFile);
      } catch (error) {
        errors.push({
          file,
          error: new FsIoError('The existing plan could not be read.', undefined, { cause: error }),
        });
        continue;
      }

      let rawPlan: unknown;
      try {
        rawPlan = JSON.parse(planText);
      } catch {
        results.push({ ...identity, status: 'stale', reason: 'The plan is not valid JSON.' });
        continue;
      }

      const parsedPlan = PlanDocument.safeParse(rawPlan);
      if (!parsedPlan.success) {
        results.push({ ...identity, status: 'stale', reason: 'The plan does not match the plan schema.' });
        continue;
      }
      let canonicalPlanText: string;
      try {
        canonicalPlanText = toCanonicalArtifactText(parsedPlan.data as unknown as JsonValueT);
      } catch {
        results.push({ ...identity, status: 'stale', reason: 'The plan cannot be canonically verified.' });
        continue;
      }
      if (canonicalPlanText !== planText) {
        results.push({ ...identity, status: 'stale', reason: 'The plan is not canonically serialized.' });
        continue;
      }

      let testMd: string;
      try {
        testMd = await deps.storage.readText(file);
      } catch (error) {
        errors.push({
          file,
          error: new FsIoError('The test prompt could not be read.', undefined, { cause: error }),
        });
        continue;
      }

      const normalizedTestMd = normalizeTestMd(testMd);
      const coverage = inspectCommittedInstructionCoverage(parsedPlan.data, normalizedTestMd);
      if (!coverage.success) {
        results.push({
          ...identity,
          status: 'stale',
          reason: 'The plan has invalid instruction coverage or source spans.',
        });
        continue;
      }
      const inputsDigest = computeInputsDigest({
        normalizedTestMd,
        schemaVersion: PLAN_SCHEMA_VERSION,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        planProducerBundleFingerprint: planProducerBundleFingerprint(),
        targetDefinitions: targetSelection.definitions,
      });
      if (parsedPlan.data.source.inputsDigest === inputsDigest) {
        /*
         * Grounding is inspected only after the plan has passed its own
         * freshness contract, so an already stale or invalid plan keeps its
         * established outcome. The mapping replaces this file's deferred fresh
         * row rather than appending a second row. These statuses add lifecycle
         * evidence to an otherwise fresh plan; they do not redefine plan
         * freshness itself.
         *
         * An existing grounding companion whose read rejects instead produces
         * this file's FsIoError in errors[], with neither a grounding
         * row nor the deferred fresh row; that isolated error does not stop
         * later selected files.
         *
         * An emitted stale-grounding or invalid-grounding row includes
         * groundingFile because the existing artifact is evidence of that
         * finding. A missing-grounding or fresh-without-grounding row omits
         * it because no artifact exists, or the uncommitted waiver deliberately
         * withholds its identity. Fixed path-free reasons keep the status
         * mapping reportable without disclosing a host path.
         */
        const groundingPath = deps.layout.groundingPathFor(file);
        let groundingInspection;
        try {
          groundingInspection = await inspectGroundingArtifact(
            deps.storage,
            groundingPath,
            parsedPlan.data,
          );
        } catch (error) {
          errors.push({
            file,
            error: new FsIoError('The existing grounding cache could not be read.', undefined, { cause: error }),
          });
          continue;
        }

        if (groundingInspection.kind !== 'valid') {
          if (deps.config.grounding.repositoryPolicy === 'uncommitted') {
            results.push({
              ...identity,
              status: 'fresh-without-grounding',
              reason: "The plan is fresh; a grounding cache is not required by this project's repository policy.",
            });
          } else if (groundingInspection.kind === 'missing') {
            results.push({
              ...identity,
              status: 'missing-grounding',
              reason: 'The grounding cache does not exist.',
            });
          } else if (groundingInspection.kind === 'invalid') {
            results.push({
              ...identity,
              groundingFile: groundingPath,
              status: 'invalid-grounding',
              reason: 'The grounding cache is not valid or does not match the grounding schema.',
            });
          } else {
            results.push({
              ...identity,
              groundingFile: groundingPath,
              status: 'stale-grounding',
              reason: 'The grounding cache does not match the current plan.',
            });
          }
          continue;
        }
      }
      results.push({
        ...identity,
        status: parsedPlan.data.source.inputsDigest === inputsDigest ? 'fresh' : 'stale',
        reason: parsedPlan.data.source.inputsDigest === inputsDigest
          ? 'The plan matches the current prompt and target.'
          : 'The plan is stale for the current prompt or target.',
      });
      } finally {
        tracker.markTerminal(workKey);
      }
    }
  }

  if (tracker.interrupted) {
    return { results: [...results, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))], errors, noTestsFound: false, interrupted: true };
  }

  /*
   * Artifact enumeration passes no configured ignores. Ignoring
   * an artifact by its own path decides ownership before its virtual test path
   * is known; the later inverse-then-judge step instead applies the complete
   * configured matcher to that derived path.
   */
  const planPaths = (await deps.discoverTestFiles({
    testDir: deps.config.testDir,
    testMatch: [`**/*${PLAN_SUFFIX}`],
    testIgnore: [],
  })).map((path) => joinPath(deps.config.testDir, path));
  if (tracker.interrupted) {
    return { results: [...results, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))], errors, noTestsFound: false, interrupted: true };
  }
  /*
   * The registration pass inverse-derives each plan path before
   * judging its virtual test path. An un-derivable artifact is recorded as an
   * `invalid-artifact-name` finding in `orphanFindings` without tracker work;
   * a derived but unmanaged path is skipped. This keeps every artifact-scan
   * finding in one accumulator, so the established zero-match formula needs no
   * parallel count or exception.
   */
  const orphanFindings: CheckFileOutcome[] = [];
  for (const [index, planPath] of planPaths.entries()) {
    const testPath = deps.layout.testPathForPlan(planPath);
    if (testPath === undefined) {
      orphanFindings.push({
        id: planPath,
        file: planPath,
        status: 'invalid-artifact-name',
        reason: 'The artifact name could not be inverse-derived into a corresponding test path.',
        artifactFile: planPath,
      });
      continue;
    }
    const relativeTestPath = relativeWithin(deps.config.testDir, testPath)!;
    if (matchesTestPatterns(relativeTestPath, deps.config.testMatch, deps.config.testIgnore)) {
      tracker.addDiscovered(`plan:${index}:${planPath}`, testPath);
    }
  }
  if (tracker.interrupted) {
    return { results: [...results, ...orphanFindings, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))], errors, noTestsFound: false, interrupted: true };
  }
  /*
   * The terminal pass repeats the pure inverse and match judgment
   * before checking existence. Repeating cheap pure work preserves the
   * register-whole-phase-then-inspect tracker contract; inverse-incapable and
   * unmanaged paths have already been reported or intentionally excluded and
   * never gain a second row here.
   */
  for (const [index, planPath] of planPaths.entries()) {
    const testPath = deps.layout.testPathForPlan(planPath);
    if (testPath === undefined) continue;
    const relativeTestPath = relativeWithin(deps.config.testDir, testPath)!;
    if (!matchesTestPatterns(relativeTestPath, deps.config.testMatch, deps.config.testIgnore)) continue;
    if (!(await deps.storage.exists(testPath))) {
      orphanFindings.push({
        id: testPath,
        file: testPath,
        planFile: planPath,
        status: 'orphaned-plan',
        reason: 'No corresponding test file exists for this plan.',
      });
    }
    tracker.markTerminal(`plan:${index}:${planPath}`);
    if (tracker.interrupted) break;
  }

  if (tracker.interrupted) {
    return { results: [...results, ...orphanFindings, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))], errors, noTestsFound: false, interrupted: true };
  }

  const groundingPaths = (await deps.discoverTestFiles({
    testDir: deps.config.testDir,
    testMatch: [`**/*${GROUNDING_SUFFIX}`],
    testIgnore: [],
  })).map((path) => joinPath(deps.config.testDir, path));
  /*
   * Grounding artifacts follow the same inverse-then-judge boundary as plans,
   * rather than letting their filename decide configured ownership. An
   * inverse-incapable name joins `orphanFindings` as an
   * `invalid-artifact-name` row using the artifact as its only concrete
   * identity, before this phase's asynchronous orphan checks.
   */
  for (const [index, groundingPath] of groundingPaths.entries()) {
    const testPath = deps.layout.testPathForGrounding(groundingPath);
    if (testPath === undefined) {
      orphanFindings.push({
        id: groundingPath,
        file: groundingPath,
        status: 'invalid-artifact-name',
        reason: 'The artifact name could not be inverse-derived into a corresponding test path.',
        artifactFile: groundingPath,
      });
      continue;
    }
    const relativeTestPath = relativeWithin(deps.config.testDir, testPath)!;
    if (matchesTestPatterns(relativeTestPath, deps.config.testMatch, deps.config.testIgnore)) {
      tracker.addDiscovered(`grounding:${index}:${groundingPath}`, testPath);
    }
  }
  if (tracker.interrupted) {
    return { results: [...results, ...orphanFindings, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))], errors, noTestsFound: false, interrupted: true };
  }

  /*
   * The second grounding loop re-derives and re-judges before its
   * existing terminal check. Keeping the two-loop shape makes interruption
   * accounting identical across artifact kinds while preserving deterministic
   * phase ordering without interleaved bookkeeping.
   */
  for (const [index, groundingPath] of groundingPaths.entries()) {
    const testPath = deps.layout.testPathForGrounding(groundingPath);
    if (testPath === undefined) continue;
    const relativeTestPath = relativeWithin(deps.config.testDir, testPath)!;
    if (!matchesTestPatterns(relativeTestPath, deps.config.testMatch, deps.config.testIgnore)) continue;
    if (!(await deps.storage.exists(testPath))) {
      orphanFindings.push({
        id: testPath,
        file: testPath,
        planFile: deps.layout.planPathFor(testPath),
        status: 'orphaned-grounding',
        groundingFile: groundingPath,
        reason: 'No corresponding test file exists for this grounding artifact.',
      });
    }
    tracker.markTerminal(`grounding:${index}:${groundingPath}`);
    if (tracker.interrupted) break;
  }

  return {
    results: [...results, ...orphanFindings, ...tracker.pendingIdentities.map((file) => ({ id: file, file, status: 'skipped' as const }))],
    errors,
    noTestsFound: !tracker.interrupted && selectedTestFiles.length === 0 && orphanFindings.length === 0,
    interrupted: tracker.interrupted,
  };
  } finally {
    tracker.dispose();
  }
}
