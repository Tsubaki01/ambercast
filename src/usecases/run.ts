import type { ResolvedConfig } from '#core/config/schema.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { MissingPlanError } from '#core/errors/missing-plan-error.js';
import { SecretUnresolvedError } from '#core/errors/secret-unresolved-error.js';
import { StaleIrError } from '#core/errors/stale-ir-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { AmbercastError, type AmbercastError as AmbercastErrorType } from '#core/errors/types.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  GroundingDocument,
  PlanDocument,
  type ActionStep,
  type AssertStep,
  type CaptureStep,
  type ElementRef,
  type GroundingDocument as GroundingDocumentType,
  type JsonValueT,
  type PlanDocument as PlanDocumentType,
  type RunVariableName,
  type Step,
  type TargetDefinition,
} from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { joinPath, relativeWithin } from '#core/paths.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { AssertCheck, BrowserSession, PerformableAction } from '#ports/browser.js';
import type { BrowserDriverResolver } from '#ports/index.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock, EventSink, SecretsProvider } from '#ports/system.js';
import type { RunResult, StepResult } from '#report/schema.js';

type ResultWithoutDuration = Omit<RunResult, 'durationMs'>;

type DispatchOutcome =
  | { readonly kind: 'passed' }
  | { readonly kind: 'assertion-failed'; readonly message: string };

interface DispatchContext {
  readonly session: BrowserSession;
  readonly grounding: GroundingDocumentType;
  readonly runState: Map<RunVariableName, string>;
  readonly secrets: SecretsProvider;
}

type StepExecutor = (step: Step, context: DispatchContext) => Promise<DispatchOutcome>;

const RUN_REFERENCE_PATTERN = /\{\{run\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}\}/g;

/**
 * Marks an abort that has no reportable error kind while retaining a useful
 * case-level explanation. Issue #8 replaces this temporary fallback with
 * AI-assisted resolution rather than extending a second error vocabulary.
 */
class CaseAbort extends Error {}

function fsIoError(message: string, cause: unknown): FsIoError {
  return new FsIoError(message, undefined, { cause });
}

function resolveTarget(
  config: RunDeps['config'],
  options: RunOptions,
): Readonly<Record<string, TargetDefinition>> | TargetUnresolvedError {
  const targetName = options.target ?? config.defaultTarget;
  const target = targetName === undefined ? undefined : config.targets[targetName];

  if (targetName === undefined || target === undefined) {
    return new TargetUnresolvedError('The requested replay target is not configured.', { target: targetName ?? '(default)' });
  }

  return { [targetName]: target };
}

function emptyGrounding(plan: PlanDocumentType): GroundingDocumentType {
  return { schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {} };
}

async function readTrustedPlan(
  storage: StorageAdapter,
  planPath: string,
  inputsDigest: string,
): Promise<PlanDocumentType> {
  let exists: boolean;
  try {
    exists = await storage.exists(planPath);
  } catch (error) {
    throw fsIoError('The generated plan could not be inspected.', error);
  }

  if (!exists) {
    throw new MissingPlanError('The generated plan artifact is missing.', { planPath });
  }

  let text: string;
  try {
    text = await storage.readText(planPath);
  } catch (error) {
    throw fsIoError('The generated plan could not be read.', error);
  }

  let parsed: ReturnType<typeof PlanDocument.safeParse>;
  try {
    parsed = PlanDocument.safeParse(JSON.parse(text));
  } catch (error) {
    throw new IntegrityViolationError('The generated plan is not valid JSON.', { planPath }, { cause: error });
  }

  if (!parsed.success) {
    throw new IntegrityViolationError('The generated plan does not match the required schema.', {
      planPath,
      issues: parsed.error.issues,
    });
  }

  try {
    if (toCanonicalArtifactText(parsed.data as unknown as JsonValueT) !== text) {
      throw new IntegrityViolationError('The generated plan is not canonically serialized.', { planPath });
    }
  } catch (error) {
    if (error instanceof IntegrityViolationError) {
      throw error;
    }

    throw new IntegrityViolationError('The generated plan cannot be canonically verified.', { planPath }, { cause: error });
  }

  if (parsed.data.source.inputsDigest !== inputsDigest) {
    throw new StaleIrError('The generated plan is stale for the current prompt or target.', { planPath });
  }

  return parsed.data;
}

async function readUsableGrounding(
  storage: StorageAdapter,
  groundingPath: string,
  plan: PlanDocumentType,
): Promise<GroundingDocumentType> {
  const empty = emptyGrounding(plan);

  try {
    if (!(await storage.exists(groundingPath))) {
      return empty;
    }

    const parsed = GroundingDocument.safeParse(JSON.parse(await storage.readText(groundingPath)));
    return parsed.success && parsed.data.planDigest === empty.planDigest ? parsed.data : empty;
  } catch {
    // Grounding is a cache. A cache that cannot establish provenance is a miss,
    // while the separately trusted plan remains safe to replay.
    return empty;
  }
}

function materializeText(value: string, runState: ReadonlyMap<RunVariableName, string>): string {
  return value.replace(RUN_REFERENCE_PATTERN, (_reference, path: string) => {
    const segments = path.split('.');
    if (segments.length !== 1) {
      throw new CaseAbort('A captured run value must use exactly one name segment.');
    }

    const valueForReference = runState.get(segments[0] as RunVariableName);
    if (valueForReference === undefined) {
      throw new CaseAbort('The plan references a run value that no earlier capture produced.');
    }

    return valueForReference;
  });
}

function materializeStep(step: Step, runState: ReadonlyMap<RunVariableName, string>): Step {
  switch (step.kind) {
    case 'action':
      switch (step.action) {
        case 'navigate':
          return { ...step, url: materializeText(step.url, runState) };
        case 'fill':
          return { ...step, value: materializeText(step.value, runState) };
        default:
          return step;
      }
    case 'assert':
      switch (step.check) {
        case 'text-visible':
        case 'text-equals':
          return { ...step, text: materializeText(step.text, runState) };
        case 'url-matches':
          return { ...step, pattern: materializeText(step.pattern, runState) };
        default:
          return step;
      }
    case 'ai':
      return { ...step, instruction: materializeText(step.instruction, runState) };
    case 'capture':
      return step;
  }
}

async function groundedTarget(
  session: BrowserSession,
  grounding: GroundingDocumentType,
  step: ActionStep | AssertStep | CaptureStep,
  target: ElementRef,
): Promise<ElementRef> {
  const entry = grounding.entries[step.id];
  if (entry?.kind !== 'element') {
    throw new CaseAbort('AI-assisted re-resolution is unavailable because this step has no usable grounding entry.');
  }

  const resolved = await session.resolveGrounded(target, entry.fingerprint);
  if (resolved.kind !== 'hit') {
    throw new CaseAbort('AI-assisted re-resolution is unavailable because recorded grounding no longer matches the page.');
  }

  return resolved.ref;
}

async function executeAction(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'action') {
    throw new Error('The action dispatcher received a non-action step.');
  }

  let action: PerformableAction;
  switch (step.action) {
    case 'click':
      action = { type: 'click', target: await groundedTarget(context.session, context.grounding, step, step.target) };
      break;
    case 'navigate':
      action = { type: 'navigate', url: step.url };
      break;
    case 'press':
      action = {
        type: 'press',
        target: await groundedTarget(context.session, context.grounding, step, step.target),
        key: step.key,
      };
      break;
    case 'fill':
      action = {
        type: 'fill',
        target: await groundedTarget(context.session, context.grounding, step, step.target),
        value: step.value,
      };
      break;
    case 'fill-secret': {
      const target = await groundedTarget(context.session, context.grounding, step, step.target);
      const value = context.secrets.resolve(step.secretRef);
      if (value === undefined) {
        throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: step.secretRef });
      }

      action = { type: 'fill-secret', target, value };
      break;
    }
  }

  await context.session.perform(action);
  return { kind: 'passed' };
}

async function executeAssert(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'assert') {
    throw new Error('The assertion dispatcher received a non-assertion step.');
  }

  let check: AssertCheck;
  switch (step.check) {
    case 'text-visible':
      check = { check: 'text-visible', text: step.text };
      break;
    case 'element-visible':
      check = {
        check: 'element-visible',
        target: await groundedTarget(context.session, context.grounding, step, step.target),
      };
      break;
    case 'text-equals':
      check = {
        check: 'text-equals',
        target: await groundedTarget(context.session, context.grounding, step, step.target),
        text: step.text,
      };
      break;
    case 'url-matches':
      check = { check: 'url-matches', pattern: step.pattern };
      break;
    case 'element-count':
      check = {
        check: 'element-count',
        target: await groundedTarget(context.session, context.grounding, step, step.target),
        count: step.count,
      };
      break;
  }

  const outcome = await context.session.evaluateAssert(check);
  return outcome.passed ? { kind: 'passed' } : { kind: 'assertion-failed', message: outcome.message };
}

async function executeCapture(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'capture') {
    throw new Error('The capture dispatcher received a non-capture step.');
  }

  const target = await groundedTarget(context.session, context.grounding, step, step.target);
  const value = await context.session.captureValue(target, 'text');
  context.runState.set(step.variable, value);
  return { kind: 'passed' };
}

const DISPATCH_TABLE = {
  action: executeAction,
  assert: executeAssert,
  capture: executeCapture,
} satisfies Record<Exclude<Step['kind'], 'ai'>, StepExecutor>;

function stepResult(step: Step, status: StepResult['status'], kind?: StepResult['kind']): StepResult {
  return {
    id: step.id,
    type: step.kind,
    status,
    ...(kind === undefined ? {} : { kind }),
  };
}

function skippedSteps(steps: readonly Step[], after: number): StepResult[] {
  return steps.slice(after + 1).map((step) => stepResult(step, 'skipped'));
}

function resultForAbort(
  identity: Pick<RunResult, 'id' | 'file' | 'planFile'>,
  steps: readonly Step[],
  completed: readonly StepResult[],
  currentStep: Step | undefined,
  explanation: string,
): ResultWithoutDuration {
  const currentIndex = currentStep === undefined ? -1 : steps.indexOf(currentStep);
  return {
    ...identity,
    status: 'error',
    steps: currentStep === undefined
      ? [...completed]
      : [...completed, stepResult(currentStep, 'error', 'environment'), ...skippedSteps(steps, currentIndex)],
    explanation,
  };
}

function grepMatches(grep: RegExp, path: string, testDir: string): boolean {
  const relativePath = relativeWithin(testDir, path) ?? path;
  grep.lastIndex = 0;
  const matches = grep.test(relativePath);
  grep.lastIndex = 0;
  return matches;
}

/**
 * Declares zero-AI replay policy for one run batch.
 *
 * @remarks
 * A caller may give literal prompt paths or let the use case ask the injected
 * discovery seam for them. Target selection is also batch-wide because it
 * participates in the plan's input digest: selecting a different configured
 * target must fail as stale rather than replaying a plan against a silently
 * different browser target.
 */
export interface RunOptions {
  /** Literal prompt paths, or an empty list to use configured discovery. */
  readonly files: readonly string[];

  /**
   * Optional path filter already validated by the command parser.
   *
   * The compiled pattern tests every discovered-or-literal `.test.md` path in
   * its POSIX-relative form: the same path shape `generate --list` inspects,
   * not a test name or step content.
   */
  readonly grep?: RegExp;

  /** Optional configured target name whose definition contributes to freshness. */
  readonly target?: string;

  /** Accepted compatibility policy; replay remains cache-only without an AI fallback. */
  readonly cacheOnly: boolean;

  /** Parsed stale-artifact policy; regeneration is rejected before replay begins. */
  readonly stale: 'fail' | 'regenerate';
}

/**
 * Dependencies at the deterministic replay boundary.
 *
 * @remarks
 * This deliberately has no `AiExecutor` dependency. Unlike generation, a
 * fully grounded replay must run on a machine without an AI provider, and a
 * grounding miss is an explicit case abort rather than a request to repair
 * the artifact. Storage, target configuration, and browser launch are kept
 * separate so plan trust can be established before a browser process exists.
 */
export interface RunDeps {
  /** Reads the source prompt and generated plan/grounding artifacts. */
  readonly storage: StorageAdapter;

  /** Derives the committed plan and grounding paths for a source prompt. */
  readonly layout: LayoutResolver;

  /** Monotonic time source used to measure each case's duration. */
  readonly clock: Clock;

  /**
   * Selects a driver after this case's target has been resolved.
   *
   * The resolver captures batch-wide launch policy such as `--headed` during
   * composition, while the engine remains unknown until this case is ready to
   * launch. Replay therefore calls `deps.browserDriver(resolvedTarget.browser)`
   * per case rather than choosing a driver while composing the command.
   */
  readonly browserDriver: BrowserDriverResolver;

  /** Resolves a `fill-secret` reference only at the point that needs its value. */
  readonly secrets: SecretsProvider;

  /**
   * Receives successful grounded-step lifecycle events without affecting replay.
   *
   * Successful steps emit their start and grounded result through this port;
   * deterministic replay never emits an `ai-call` event.
   */
  readonly events: EventSink;

  /**
   * Configured prompt discovery supplied by runtime.
   *
   * This structural callback avoids a usecase-to-runtime import: runtime owns
   * filesystem walking, ordering, and deduplication, while replay owns how a
   * resolved prompt is executed.
   */
  readonly discoverTestFiles: (config: {
    readonly testDir: string;
    readonly testMatch: readonly string[];
    readonly testIgnore: readonly string[];
  }) => Promise<readonly string[]>;

  /** The configuration subset used for discovery and target/digest resolution. */
  readonly config: Pick<
    ResolvedConfig,
    'testDir' | 'testMatch' | 'testIgnore' | 'targets' | 'defaultTarget'
  >;

  /**
   * Caller cancellation that stops scheduling later cases.
   *
   * Completed case outcomes are retained, matching `generate()`'s partial
   * outcome contract rather than treating cancellation as permission to erase
   * work that has already completed.
   */
  readonly signal?: AbortSignal;
}

/**
 * The reportable outcome of one replayed prompt.
 *
 * @remarks
 * A classified `AmbercastError` is retained so report construction can emit
 * one case-scoped error. The unified case-abort stopgap intentionally leaves
 * `error` absent: it has no reserved `ErrorKind`, yet its result is still
 * `status: 'error'` so the report's priority scan selects a nonzero exit.
 */
export interface RunCaseOutcome {
  /** The complete per-case execution evidence and status. */
  readonly result: RunResult;

  /** The first classified failure that aborted this case, when one exists. */
  readonly error?: AmbercastError;
}

/**
 * Ordered replay outcomes plus the structural zero-match fact.
 *
 * The separate flag distinguishes an empty discovery result from a batch that
 * ran and happened to produce no passing cases, which matters to report exit
 * selection.
 */
export interface RunOutcome {
  /** Completed cases in literal or deterministic discovery order. */
  readonly results: readonly RunCaseOutcome[];

  /** Whether discovery resolved no prompt files before case work began. */
  readonly noTestsFound: boolean;
}

/**
 * Replays canonical, fresh plan artifacts against their configured browser targets.
 *
 * @param deps - Replay I/O, target, clock, browser, secret, event, discovery,
 * and cancellation dependencies.
 * @param options - Batch selection and replay policy.
 * @returns Completed per-case outcomes and the zero-match fact needed by the
 * command report.
 * @remarks
 * Literal files retain caller order and discovered files retain the injected
 * discovery order. Cases run sequentially. A caller `AbortSignal` stops the
 * scheduler before another case starts, but returns the outcomes already
 * completed; it does not discard them.
 *
 * Each `RunResult.durationMs` brackets one case's work with
 * `deps.clock.monotonicMs()`: timing starts before target and freshness
 * resolution and ends once that case's `RunCaseOutcome` is ready. This follows
 * the monotonic-duration convention already used for command-level batch
 * timing in `generate-command.ts`.
 *
 * Each case resolves its configured target before recomputing the same inputs
 * digest used by generation: normalized prompt text, schema version, generator
 * prompt-template fingerprint, and the one resolved target definition all
 * participate. It then establishes plan trust in this fixed order, before
 * `driver.launch()` is ever called: an absent plan raises
 * `MissingPlanError`; unreadable JSON, a schema-invalid document, or bytes
 * that differ from canonical serialization raise `IntegrityViolationError`;
 * and only a valid canonical plan whose current digest differs raises
 * `StaleIrError`. This ordering preserves the no-browser-startup-cost failure
 * path for every invalid artifact. In particular, parseable but non-canonical
 * text is an integrity violation, not stale IR: `generate()` may treat such
 * text as merely not fresh and regenerate it, but replay has no regeneration
 * path and must reject an untrustworthy committed artifact.
 *
 * Grounding has a deliberately softer trust rule than the plan. A missing
 * grounding file, malformed grounding text, or a grounding document whose own
 * digest differs from the plan digest is legal: replay creates an empty-entry
 * grounding document keyed to the valid plan's digest, and every
 * element-bearing step consequently misses. Only the plan document takes the
 * strict integrity and staleness path; a stale or unusable grounding cache
 * degrades gracefully instead of becoming an integrity failure.
 *
 * Execution uses one dispatch executor for each outer plan-step kind:
 * `action`, `assert`, and `capture`. The action executor alone selects among
 * click, navigation, key press, ordinary fill, and secret fill when it builds
 * a `PerformableAction`; this keeps outer-kind ownership unambiguous. `ai`
 * steps are rejected outright through the unified case-abort path because
 * deterministic replay does not execute recorded AI traces. Element-bearing work proceeds only after
 * its grounding entry and `resolveGrounded` produce a hit, so stale grounding
 * cannot reach the browser action or check.
 *
 * A case owns a `Map<RunVariableName, string>` populated by successful
 * captures. Immediately before the use case builds a step's materialized
 * action or assertion check, and before it consults grounding, it scans every
 * interpolatable text field for `{{run.<name>}}` substrings and replaces every
 * occurrence with the captured string. This is substring replace-all rather
 * than whole-value substitution because free text may contain surrounding
 * content. Captures are plain strings, so only one name segment is supported:
 * `{{run.a.b}}`, or a single segment not captured earlier in the same case,
 * takes the unified case-abort path rather than inventing another error kind.
 * Capture itself always requests `'text'`; keeping that choice in replay
 * leaves the browser adapter's two capture modes explicit rather than making
 * the adapter silently choose a default.
 *
 * A `fill-secret` resolves through `SecretsProvider.resolve()` immediately
 * before its `PerformableAction` is built. An absent value raises
 * `SecretUnresolvedError` (exit 2) and never reaches `BrowserSession.perform`,
 * which fails closed against unresolved secret references.
 *
 * An assertion outcome of `{ passed: false }` is a result, not a thrown
 * failure: the case becomes `status: 'failed'`, the failing `StepResult` is
 * `status: 'failed', kind: 'assertion'`, later steps are `status: 'skipped'`,
 * and no `errors[]` entry is emitted. Its diagnostic belongs in
 * `RunResult.explanation`, because `StepResult` deliberately has no message
 * field. The
 * `error-code-correspondence.test.ts` contract also requires that
 * `assertion-failed` never be passed to report-error serialization.
 *
 * A failure before step dispatch begins—`target-unresolved`, `missing-plan`,
 * `stale-ir`, `integrity-violation`, or `browser-launch-failed`—produces a
 * `RunResult` with `status: 'error'` and empty `steps: []`: no step was
 * attempted, so there is no step evidence to record. `RunResult.explanation`
 * still carries the diagnostic. `RunResult` legally permits an empty
 * `StepResult` array, making this the correct empty-evidence shape rather
 * than a degenerate error state.
 *
 * A failure while dispatching a specific step, whether a classified error
 * arises mid-step or the unified case-abort stopgap applies, follows the
 * step-level progression: completed steps have `status: 'passed'`; the
 * aborting step has `status: 'error', kind: 'environment'`; and later steps
 * have `status: 'skipped'`. The case-level explanation carries the diagnostic
 * because a `StepResult` has no message field.
 *
 * The per-case try/catch boundary lets the first classified failure abort only
 * its own case, not merely one step, and preserves later cases; failures
 * scoped to the usecase call itself, such as configuration loading before any
 * case, propagate to command-level reporting. Every launched session closes
 * in `finally`, even after a failed assertion or abort. The same case-abort
 * result is used for a grounding miss, an uncaptured single-segment run
 * reference or any multi-segment run reference, and any `BrowserSession` error
 * not classified here. It records `status: 'error'`, skips later steps, and
 * explains the unavailable fallback, but deliberately has no `ErrorKind` and
 * therefore no `errors[]` entry: none of the twelve reportable kinds describes
 * an unavailable fallback, and `error-code-correspondence.test.ts` fixes that
 * set. `buildRunReport()` recognizes this error status during its whole-batch
 * scan, preventing a stopgap-only batch from exiting successfully.
 */
export async function run(deps: RunDeps, options: RunOptions): Promise<RunOutcome> {
  const discovered = options.files.length === 0
    ? (await deps.discoverTestFiles({
      testDir: deps.config.testDir,
      testMatch: deps.config.testMatch,
      testIgnore: deps.config.testIgnore,
    })).map((path) => joinPath(deps.config.testDir, path))
    : [...options.files];
  const files = options.grep === undefined
    ? discovered
    : discovered.filter((path) => grepMatches(options.grep!, path, deps.config.testDir));

  if (files.length === 0) {
    return { results: [], noTestsFound: true };
  }

  const results: RunCaseOutcome[] = [];
  for (const file of files) {
    if (deps.signal?.aborted) {
      break;
    }

    results.push(await runCase(deps, options, file));
  }

  return { results, noTestsFound: false };
}

async function runCase(deps: RunDeps, options: RunOptions, file: string): Promise<RunCaseOutcome> {
  const startedAt = deps.clock.monotonicMs();
  const planPath = deps.layout.planPathFor(file);
  const identity = { id: file, file, planFile: planPath };
  const completed: StepResult[] = [];
  let planSteps: readonly Step[] = [];
  let currentStep: Step | undefined;
  let session: BrowserSession | undefined;
  let classifiedError: AmbercastErrorType | undefined;
  let result: ResultWithoutDuration | undefined;

  try {
    let testMd: string;
    try {
      testMd = await deps.storage.readText(file);
    } catch (error) {
      throw fsIoError('The test prompt could not be read.', error);
    }

    const resolvedTargets = resolveTarget(deps.config, options);
    if (resolvedTargets instanceof TargetUnresolvedError) {
      throw resolvedTargets;
    }

    const normalizedTestMd = normalizeTestMd(testMd);
    const inputsDigest = computeInputsDigest({
      normalizedTestMd,
      schemaVersion: 1,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      targetDefinitions: resolvedTargets,
    });
    const plan = await readTrustedPlan(deps.storage, planPath, inputsDigest);
    planSteps = plan.steps;
    const groundingPath = deps.layout.groundingPathFor(file);
    const grounding = await readUsableGrounding(deps.storage, groundingPath, plan);
    const [targetName] = Object.keys(resolvedTargets);
    const target = targetName === undefined ? undefined : resolvedTargets[targetName];

    // `resolveTarget` establishes this record, but preserving this guard keeps
    // the browser boundary closed if a future target representation changes.
    if (target === undefined) {
      throw new TargetUnresolvedError('The requested replay target is not configured.');
    }

    try {
      session = await deps.browserDriver(target.browser).launch(target);
    } catch (error) {
      if (error instanceof BrowserLaunchFailedError) {
        throw error;
      }

      throw new BrowserLaunchFailedError('The browser session could not be launched.', undefined, { cause: error });
    }

    const context: DispatchContext = {
      session,
      grounding,
      runState: new Map<RunVariableName, string>(),
      secrets: deps.secrets,
    };

    for (const [index, originalStep] of planSteps.entries()) {
      currentStep = originalStep;
      const step = materializeStep(originalStep, context.runState);
      const dispatcher = step.kind === 'ai' ? undefined : DISPATCH_TABLE[step.kind];

      if (dispatcher === undefined) {
        throw new CaseAbort('AI-directed plan steps have no deterministic replay path.');
      }

      const outcome = await dispatcher(step, context);
      if (outcome.kind === 'assertion-failed') {
        result = {
          ...identity,
          status: 'failed',
          steps: [
            ...completed,
            stepResult(originalStep, 'failed', 'assertion'),
            ...skippedSteps(planSteps, index),
          ],
          explanation: outcome.message,
        };
        break;
      }

      completed.push(stepResult(originalStep, 'passed'));
      deps.events.emit({ type: 'step-start', stepId: originalStep.id });
      deps.events.emit({ type: 'step-result', stepId: originalStep.id, via: 'grounding' });
    }

    result ??= {
      ...identity,
      status: 'passed',
      steps: completed,
      explanation: 'Replay completed successfully.',
    };
  } catch (error) {
    if (error instanceof AmbercastError) {
      classifiedError = error;
      result = resultForAbort(identity, planSteps, completed, currentStep, error.message);
    } else {
      const explanation = error instanceof CaseAbort
        ? error.message
        : 'The browser session could not complete this case and no deterministic fallback is available.';
      result = resultForAbort(identity, planSteps, completed, currentStep, explanation);
    }
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
      } catch {
        // Teardown cannot leak an unclassified rejection after the case already
        // has a stable outcome; the session port remains responsible for release.
      }
    }
  }

  const durationMs = deps.clock.monotonicMs() - startedAt;
  return {
    result: { ...result!, durationMs },
    ...(classifiedError === undefined ? {} : { error: classifiedError }),
  };
}
