/**
 * Defines the read-only freshness inspection for committed plan artifacts and
 * their grounding companions.
 *
 * Check deliberately observes existing files instead of composing an AI
 * provider, browser driver, event sink, or mutable storage capability. That
 * boundary keeps a CI freshness gate reproducible and makes a future write or
 * execution dependency a type-level design change rather than an incidental
 * implementation detail.
 */

import type { ResolvedConfig } from '#core/config/schema.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { PlanDocument, type JsonValueT } from '#core/ir/schema.js';
import { GROUNDING_SUFFIX, PLAN_SUFFIX, type LayoutResolver } from '#core/layout/resolve.js';
import { joinPath } from '#core/paths.js';
import { resolveTarget } from '#core/target/resolve.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { CheckResult } from '#report/schema.js';

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
   * Whether a genuinely empty inspection suppresses exit 5.
   *
   * @remarks
   * Unlike generation and replay listing, this does not short-circuit
   * discovery or artifact inspection: check has no expensive action to avoid,
   * and its report schema has no discovery-only result state.
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
   * Narrowing this port prevents a future inspection implementation from
   * acquiring a write capability by accident; reads and existence checks are
   * sufficient for every plan, prompt, and orphan finding.
   */
  readonly storage: Pick<StorageAdapter, 'readText' | 'exists'>;

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

  /** The resolved configuration fields that affect selection and digest inputs. */
  readonly config: Pick<
    ResolvedConfig,
    'testDir' | 'testMatch' | 'testIgnore' | 'targets' | 'defaultTarget'
  >;

  /** Caller cancellation that stops scheduling further selected test files. */
  readonly signal?: AbortSignal;
}

/**
 * A report-compatible freshness finding for one test or orphaned companion.
 *
 * @remarks
 * This direct alias keeps the usecase and report contracts aligned while
 * allowing report construction to preserve outcomes without unsafe casting or
 * a duplicate mapping contract.
 */
export type CheckFileOutcome = CheckResult;

/**
 * A storage read failure isolated to one selected test file.
 */
export interface CheckFileError {
  /** The selected prompt whose required read failed. */
  readonly file: string;

  /**
   * The classified storage failure for that prompt or its existing plan.
   *
   * This intentionally accepts only `FsIoError`: freshness states belong in
   * `CheckFileOutcome`, while target resolution remains a command-level
   * failure. The narrow type prevents either category from being silently
   * reintroduced as a case error that the report boundary cannot represent.
   */
  readonly error: FsIoError;
}

/**
 * Ordered findings and isolated errors from one freshness inspection.
 */
export interface CheckOutcome {
  /** Freshness and orphan findings in deterministic inspection order. */
  readonly results: readonly CheckFileOutcome[];

  /** I/O failures that affect one selected file without stopping later files. */
  readonly errors: readonly CheckFileError[];

  /**
   * Whether neither selected tests nor orphaned companion artifacts exist.
   *
   * The selection-size fact is known before any per-file work begins. The
   * independent orphan-scan fact comes from an unconditional whole-tree scan
   * whose outcome does not depend on selected-file processing. Combining them
   * avoids treating cancellation or a case-scoped I/O failure as no matches.
   */
  readonly noTestsFound: boolean;
}

/**
 * Inspects selected plans for freshness and the configured test tree for
 * orphaned companion artifacts.
 *
 * @param deps - Read-only storage, layout, discovery, configuration, and
 * optional cancellation dependencies.
 * @param options - Literal selection, target, and zero-match reporting policy.
 * @returns Ordered freshness findings, case-scoped I/O failures, and the
 * zero-match fact needed by report exit policy.
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
 * Selected files are sequential so cancellation stops newly scheduled work
 * while a case-scoped storage failure leaves later selections inspectable.
 *
 * Freshness accepts only canonical plans whose digest reflects the normalized
 * prompt and the resolved target. Grounding content is deliberately excluded:
 * it is a recoverable replay cache rather than a freshness input. Orphan
 * detection is instead a whole-tree integrity invariant, independent of
 * literal selection and selected-file outcomes; its stable ordering follows
 * selected findings with plans before grounding. This preserves the shared
 * report exit priority between integrity findings, case errors, and genuine
 * zero-match inspections.
 */
export async function check(deps: CheckDeps, options: CheckOptions): Promise<CheckOutcome> {
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

  const results: CheckFileOutcome[] = [];
  const errors: CheckFileError[] = [];

  if (selectedTestFiles.length > 0) {
    const targetSelection = explicitSelection ?? resolveTarget({
      targets: deps.config.targets,
      defaultTarget: deps.config.defaultTarget,
      explicitTarget: options.target,
    });
    if (targetSelection instanceof TargetUnresolvedError) {
      throw targetSelection;
    }

    for (const file of selectedTestFiles) {
      if (deps.signal?.aborted) {
        break;
      }

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

      const inputsDigest = computeInputsDigest({
        normalizedTestMd: normalizeTestMd(testMd),
        schemaVersion: 1,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        targetDefinitions: targetSelection.definitions,
      });
      results.push({
        ...identity,
        status: parsedPlan.data.source.inputsDigest === inputsDigest ? 'fresh' : 'stale',
        reason: parsedPlan.data.source.inputsDigest === inputsDigest
          ? 'The plan matches the current prompt and target.'
          : 'The plan is stale for the current prompt or target.',
      });
    }
  }

  const artifactIgnore = artifactTestIgnore(deps.config.testIgnore);
  const planPaths = (await deps.discoverTestFiles({
    testDir: deps.config.testDir,
    testMatch: [`**/*${PLAN_SUFFIX}`],
    testIgnore: artifactIgnore,
  })).map((path) => joinPath(deps.config.testDir, path));
  const groundingPaths = (await deps.discoverTestFiles({
    testDir: deps.config.testDir,
    testMatch: [`**/*${GROUNDING_SUFFIX}`],
    testIgnore: artifactIgnore,
  })).map((path) => joinPath(deps.config.testDir, path));
  const orphanFindings: CheckFileOutcome[] = [];

  for (const planPath of planPaths) {
    const testPath = deps.layout.testPathForPlan(planPath);
    if (testPath !== undefined && !(await deps.storage.exists(testPath))) {
      orphanFindings.push({
        id: testPath,
        file: testPath,
        planFile: planPath,
        status: 'orphaned-plan',
        reason: 'No corresponding test file exists for this plan.',
      });
    }
  }

  for (const groundingPath of groundingPaths) {
    const testPath = deps.layout.testPathForGrounding(groundingPath);
    if (testPath !== undefined && !(await deps.storage.exists(testPath))) {
      orphanFindings.push({
        id: testPath,
        file: testPath,
        planFile: deps.layout.planPathFor(testPath),
        status: 'orphaned-grounding',
        reason: `No corresponding test file exists for the grounding artifact at ${groundingPath}.`,
      });
    }
  }

  return {
    results: [...results, ...orphanFindings],
    errors,
    noTestsFound: selectedTestFiles.length === 0 && orphanFindings.length === 0,
  };
}

/**
 * Preserves configured ignores except companions that would hide their own
 * orphan scans.
 *
 * @param testIgnore - Project-configured ignore patterns for ordinary test
 * discovery.
 * @returns The ignore list plan and grounding scans use.
 * @remarks
 * Exact-match removal limits the exception to the two known self-excluding
 * patterns. A broader predicate could override a project's intentional ignore
 * for run output, fixtures, or another artifact namespace.
 */
function artifactTestIgnore(testIgnore: readonly string[]): readonly string[] {
  const selfIgnore = new Set([
    `**/*${PLAN_SUFFIX}`,
    `**/*${GROUNDING_SUFFIX}`,
  ]);

  return testIgnore.filter((pattern) => !selfIgnore.has(pattern));
}
