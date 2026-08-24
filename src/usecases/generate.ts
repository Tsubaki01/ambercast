/**
 * Defines deterministic orchestration for turning source Markdown prompts
 * into validated, reviewable ambercast plan artifacts.
 */

import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { composeAiDeadline, isAiDeadlineTimeout } from '#core/ai/ai-deadline.js';
import {
  buildGeneratorTask,
  promptTemplateFingerprint,
} from '#core/ai/prompt-envelope.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { AmbercastError, type AmbercastError as AmbercastErrorType } from '#core/errors/types.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import {
  GeneratedAiStep,
  GeneratedPlanResponse,
  GeneratedStep,
  GROUNDING_SCHEMA_VERSION,
  GroundingDocument,
  InstructionCriterionId,
  JsonValue,
  PLAN_SCHEMA_VERSION,
  PlanDocument,
  type GroundingDocument as GroundingDocumentType,
  type GeneratedInstructionCoveredPlanResponse,
  type InstructionCoveredStep,
  type JsonValueT,
  type PlanDocument as PlanDocumentType,
} from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { joinPath } from '#core/paths.js';
import { resolveTarget } from '#core/target/resolve.js';
import type { AiExecutor } from '#ports/ai.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { EventSink } from '#ports/system.js';
import { z } from 'zod';
import {
  assertCommittedSecretAttributionSound,
  assertNoLiteralSecrets,
  attributeSecretGrants,
  InstructionCoverageAttributionError,
  type InstructionPolicyGeneratedStep,
  normalizeAiStepSecretGrants,
} from './generator-secret-policy.js';
import {
  validateCommittedInstructionCoverage,
  type InstructionCoverageResult,
} from './instruction-coverage-policy.js';
import { BatchInterruptionTracker } from './batch-interruption.js';

const GENERATED_PLAN_RESPONSE_SCHEMA = typedJsonSchema(GeneratedPlanResponse);

/*
 * Empty transient intent remains policy input only for an action-only AI step,
 * whose actionable failure is the missing success criterion. An arbitrary
 * JSON assertion likewise reaches the policy's supported-vocabulary check.
 * Relaxing only this transient provider field after transport validation
 * avoids coupling either diagnostic to Zod's issue-code and union-path
 * representation while every other provider field still passes the strict
 * generated response authority.
 */
const GENERATED_PLAN_RESPONSE_FOR_POLICY = GeneratedPlanResponse.extend({
  steps: z.array(z.union([
    GeneratedStep,
    GeneratedAiStep.extend({
      verificationIntent: z.array(z.strictObject({
        criterionId: InstructionCriterionId,
        assertion: JsonValue,
      })),
    }),
  ])),
});

type GeneratedPlanResponseForPolicy = Omit<
  GeneratedInstructionCoveredPlanResponse,
  'steps'
> & {
  readonly steps: readonly InstructionPolicyGeneratedStep[];
};

/**
 * Attributes and validates provider instruction coverage before Plan assembly.
 *
 * @param response - Strict provider response with citations and full intents.
 * @param normalizedTestMd - Canonical prompt used for local attribution.
 * @returns Committed-shape steps without citation or intent data, or the
 * complete deterministic provider issue list.
 * @remarks
 * Generation composes this phase with secret attribution, but neither policy
 * grants authority to the other. Instruction validation runs
 * for every AI step, requires exact step-local success/intent bijections, and
 * discards transient fields before Plan construction. Failure maps to
 * `AiResponseInvalidError` with raw provider output and performs no artifact
 * write.
 */
export function prepareInstructionCoveredSteps(
  response: GeneratedPlanResponseForPolicy,
  normalizedTestMd: NormalizedTestMd,
): InstructionCoverageResult<InstructionCoveredStep[]> {
  try {
    return { success: true, data: attributeSecretGrants(response.steps, normalizedTestMd) };
  } catch (error) {
    if (error instanceof InstructionCoverageAttributionError) {
      return { success: false, issues: error.issues };
    }
    throw error;
  }
}

function asArtifactText(value: JsonValueT): string {
  return toCanonicalArtifactText(value);
}

function fsIoError(message: string, cause: unknown): FsIoError {
  return new FsIoError(message, undefined, { cause });
}

function fileFailure(error: unknown, message: string): AmbercastErrorType {
  return error instanceof AmbercastError ? error : fsIoError(message, error);
}

/**
 * Treats committed provenance failure as not fresh so generation regenerates.
 *
 * The instruction-coverage implementation composes local span re-extraction
 * with the existing secret check here. A Plan-v2 artifact is reusable only
 * when strict schema, canonical bytes, input digest, and every committed AI
 * criterion agree with the current normalized prompt.
 */
function validFreshPlan(
  text: string,
  inputsDigest: string,
  normalizedTestMd: NormalizedTestMd,
): PlanDocumentType | undefined {
  try {
    const parsed = PlanDocument.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.source.inputsDigest !== inputsDigest) {
      return undefined;
    }

    if (asArtifactText(parsed.data as unknown as JsonValueT) !== text) {
      return undefined;
    }

    assertCommittedSecretAttributionSound(parsed.data, normalizedTestMd);
    for (const step of parsed.data.steps) {
      if (step.kind === 'ai'
        && !validateCommittedInstructionCoverage(step.instructionCoverage, normalizedTestMd).success) {
        return undefined;
      }
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function freshPlan(
  storage: StorageAdapter,
  planPath: string,
  inputsDigest: string,
  normalizedTestMd: NormalizedTestMd,
): Promise<PlanDocumentType | undefined> {
  if (!(await storage.exists(planPath))) {
    return undefined;
  }

  return validFreshPlan(await storage.readText(planPath), inputsDigest, normalizedTestMd);
}

function emptyGrounding(plan: PlanDocumentType): GroundingDocumentType {
  return { schemaVersion: GROUNDING_SCHEMA_VERSION, planDigest: computePlanDigest(plan), entries: {} };
}

async function groundingIsCurrent(
  storage: StorageAdapter,
  groundingPath: string,
  plan: PlanDocumentType,
): Promise<boolean> {
  if (!(await storage.exists(groundingPath))) {
    return false;
  }

  try {
    const parsed = GroundingDocument.safeParse(JSON.parse(await storage.readText(groundingPath)));
    return parsed.success && parsed.data.planDigest === computePlanDigest(plan);
  } catch {
    return false;
  }
}

async function repairGroundingIfNeeded(
  storage: StorageAdapter,
  groundingPath: string,
  plan: PlanDocumentType,
): Promise<void> {
  if (!(await groundingIsCurrent(storage, groundingPath, plan))) {
    await storage.writeText(groundingPath, asArtifactText(emptyGrounding(plan) as unknown as JsonValueT));
  }
}

/**
 * Converts a rejected AI request into its reportable failure classification.
 *
 * The caller supplies the already-established local-deadline classification
 * so this presentation boundary does not repeat a name-based timeout guess or
 * diverge from the cancellation contract used by other AI call sites.
 *
 * @param error - Rejection value from the provider request.
 * @param isTimeout - Whether the error is this request's own timeout reason.
 * @returns The existing Ambercast error or a classified unavailable-provider error.
 */
function aiFailure(error: unknown, isTimeout: boolean): AmbercastErrorType {
  if (error instanceof AmbercastError) {
    return error;
  }

  if (isTimeout) {
    return new AiExecutorUnavailableError('The AI provider did not respond within the configured timeout.', undefined, { cause: error });
  }

  return new AiExecutorUnavailableError('The AI provider call failed.', undefined, { cause: error });
}

/**
 * Command policy for one generation batch.
 */
export interface GenerateOptions {
  /** Literal prompt paths, or an empty list to use configured discovery. */
  readonly files: readonly string[];

  /** Whether non-empty ambiguities escalate after generation. */
  readonly strict: boolean;

  /** Whether a fresh existing plan still regenerates. */
  readonly force: boolean;

  /** Whether validated artifacts are previewed instead of written. */
  readonly dryRun: boolean;

  /** Optional explicit target name; an invalid name never falls back. */
  readonly target?: string;

  /** Whether zero discovered files are an allowed empty outcome. */
  readonly allowEmpty: boolean;

  /** Whether discovery is reported without reading prompts or calling AI. */
  readonly list: boolean;
}

/**
 * Dependencies supplied at the generation application boundary.
 */
export interface GenerateDeps {
  /** Artifact persistence for prompts, plans, and grounding documents. */
  readonly storage: StorageAdapter;

  /** Deterministic companion-path arithmetic for discovered prompt paths. */
  readonly layout: LayoutResolver;

  /** The already-selected structured-response provider. */
  readonly aiExecutor: AiExecutor;

  /**
   * Receives lifecycle accounting for structured provider invocations.
   *
   * Every attempted `aiExecutor.execute` call emits one `ai-call`; paths that
   * avoid the provider emit none.
   */
  readonly events: EventSink;

  /**
   * Configured prompt discovery injected from runtime.
   *
   * This structural callback mirrors runtime's `TestFileDiscovery` without a
   * forbidden usecase-to-runtime import; runtime owns the filesystem walk and
   * supplies the compatible function at composition time.
   */
  readonly discoverTestFiles: (config: {
    readonly testDir: string;
    readonly testMatch: readonly string[];
    readonly testIgnore: readonly string[];
  }) => Promise<readonly string[]>;

  /** The subset of resolved configuration the generation algorithm reads. */
  readonly config: Pick<
    ResolvedConfig,
    'testDir' | 'testMatch' | 'testIgnore' | 'targets' | 'defaultTarget' | 'ai'
  >;

  /**
   * Caller cancellation observed at the sequential scheduling boundary.
   *
   * Cancellation retains terminal outcomes and turns every discovered but
   * nonterminal identity into an evidence-free skipped row.
   */
  readonly signal?: AbortSignal;
}

/**
 * The per-file state represented in a generation outcome.
 *
 * Interrupted work uses the shared identity-only skipped state; it never
 * borrows plan, provider, ambiguity, or dry-run evidence from completed work.
 */
export type GenerateFileStatus = 'generated' | 'skipped-fresh' | 'would-generate' | 'listed' | 'skipped' | 'failed';

/**
 * Serializable-identifying data plus any live error for one prompt path.
 */
export interface GenerateFileOutcome {
  /** Source Markdown prompt path. */
  readonly file: string;

  /** The completed state for this source prompt. */
  readonly status: GenerateFileStatus;

  /** Plan path retained only for generated, fresh, or previewed results. */
  readonly planFile?: string;

  /** Provider ambiguities retained only for generated or previewed plans. */
  readonly ambiguities?: readonly JsonValueT[];

  /** Classified per-file failure retained only for a failed result. */
  readonly error?: AmbercastError;
}

/**
 * Ordered terminal and interruption results of one generation invocation.
 *
 * The batch interruption fact is distinct from any individual result. It is
 * true only when caller cancellation was observed while a discovered work key
 * remained nonterminal, allowing report construction to add one run-scoped
 * interruption error without converting skipped identities into case errors.
 */
export interface GenerateOutcome {
  /** Per-file results in literal or deterministic discovery order. */
  readonly results: readonly GenerateFileOutcome[];

  /** Whether resolution found no files before any per-file work began. */
  readonly noTestsFound: boolean;

  /** Whether cancellation intersected discovered nonterminal work. */
  readonly interrupted: boolean;
}

/**
 * Generates or previews deterministic plan artifacts for resolved prompt files.
 *
 * @param deps - I/O, layout, provider, event delivery, discovery,
 * configuration, and optional cancellation dependencies.
 * @param options - Batch selection and generation policy.
 * @returns Ordered file outcomes, the zero-match fact, and whether cancellation
 * intersected incomplete discovered work.
 * @remarks
 * Literal paths retain caller order and discovered paths retain the injected
 * discovery order, including duplicate occurrences. Each occurrence receives
 * a key such as `generate:<index>:<file>`, so duplicate public identities keep
 * their existing visible result rows without sharing scheduling terminality.
 * List mode is an atomic boundary after selection: it returns every listed row
 * and `GenerateOutcome.interrupted` is false even when its caller signal is
 * already aborted. It does not read prompt files, invoke AI, emit lifecycle
 * events, or write artifacts. Every attempted
 * provider invocation emits one `ai-call` event; paths that avoid the
 * provider emit none. Other files run sequentially, so a caller cancellation
 * prevents new work without discarding earlier terminal outcomes, while an
 * individual file failure does not block later files.
 *
 * Freshness requires both semantic validity and canonical artifact bytes,
 * preventing malformed or reformatted plans from skipping generation. A
 * non-dry-run fresh plan repairs only its grounding cache, while dry-run leaves
 * that cache untouched; `force` is the explicit opt-out from fresh-plan reuse.
 * The provider receives a smaller response contract than the committed plan:
 * the shared core resolver supplies one target while this use case owns
 * provenance, then validates the assembled plan and its duplicate-ID invariant
 * before the literal-secret policy permits persistence. Restricting the target
 * record to that selection prevents unrelated definitions from changing the
 * digest or entering provider context. A classified selection failure remains
 * attached to its file and stops that case before digest computation, existing
 * plan inspection, provider invocation, or artifact writes. Later prompts
 * retain the same isolation as other generation failures.
 *
 * The caller signal is distinct from the per-call timeout. A synchronous
 * tracker records discovered work keys and their public identities. A work key
 * becomes terminal whenever its scheduled file processing completes,
 * independently of whether completion creates a public row. Cancellation
 * leaves every still-pending public identity as an ordered, deduplicated,
 * identity-only skipped row and latches even when in-flight work later
 * completes; the listener is disposed in `finally` on success or rejection. A
 * timeout instead fails only the current file as an unavailable executor. Plan
 * text precedes grounding text so a grounding write failure leaves a
 * repairable fresh plan rather than a partial plan. Cross-process generation
 * against the same prompt is undefined behavior.
 */
export async function generate(deps: GenerateDeps, options: GenerateOptions): Promise<GenerateOutcome> {
  const tracker = new BatchInterruptionTracker(deps.signal);
  try {
  const discovered = options.files.length === 0
    ? (await deps.discoverTestFiles({
      testDir: deps.config.testDir,
      testMatch: deps.config.testMatch,
      testIgnore: deps.config.testIgnore,
    })).map((path) => joinPath(deps.config.testDir, path))
    : [...options.files];

  if (discovered.length === 0) {
    return { results: [], noTestsFound: true, interrupted: false };
  }

  if (options.list) {
    return {
      results: discovered.map((file) => ({ file, status: 'listed' })),
      noTestsFound: false,
      interrupted: false,
    };
  }

  for (const [index, file] of discovered.entries()) tracker.addDiscovered(`generate:${index}:${file}`, file);
  const results: GenerateFileOutcome[] = [];
  for (const [index, file] of discovered.entries()) {
    const workKey = `generate:${index}:${file}`;
    let interruptedDuringAi = false;
    if (tracker.interrupted) {
      break;
    }
    try {

    let testMd: string;
    try {
      testMd = await deps.storage.readText(file);
    } catch (error) {
      results.push({ file, status: 'failed', error: fsIoError('The test prompt could not be read.', error) });
      continue;
    }

    const targetSelection = resolveTarget({
      targets: deps.config.targets,
      defaultTarget: deps.config.defaultTarget,
      explicitTarget: options.target,
    });
    if (targetSelection instanceof TargetUnresolvedError) {
      results.push({ file, status: 'failed', error: targetSelection });
      continue;
    }
    const resolvedTargets = targetSelection.definitions;

    const normalizedTestMd = normalizeTestMd(testMd);
    const inputsDigest = computeInputsDigest({
      normalizedTestMd,
      schemaVersion: PLAN_SCHEMA_VERSION,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      targetDefinitions: resolvedTargets,
    });
    const planPath = deps.layout.planPathFor(file);
    const groundingPath = deps.layout.groundingPathFor(file);

    let existingPlan: PlanDocumentType | undefined;
    try {
      existingPlan = await freshPlan(deps.storage, planPath, inputsDigest, normalizedTestMd);
    } catch (error) {
      results.push({ file, status: 'failed', error: fsIoError('The existing plan could not be read.', error) });
      continue;
    }

    if (existingPlan !== undefined && !options.force) {
      try {
        if (!options.dryRun) {
          await repairGroundingIfNeeded(deps.storage, groundingPath, existingPlan);
        }
        results.push({ file, status: 'skipped-fresh', planFile: planPath });
      } catch (error) {
        results.push({ file, status: 'failed', error: fsIoError('The grounding cache could not be repaired.', error) });
      }
      continue;
    }

    const deadline = composeAiDeadline(deps.signal, deps.config.ai.timeoutMs);
    let response;
    try {
      deps.events.emit({ type: 'ai-call' });
      response = await deps.aiExecutor.execute({
        prompt: buildGeneratorTask('Generate a deterministic ambercast execution plan.'),
        responseSchema: GENERATED_PLAN_RESPONSE_SCHEMA,
        context: { testMd: normalizedTestMd, targets: resolvedTargets } as unknown as JsonValueT,
        signal: deadline.signal,
      });
    } catch (error) {
      const isTimeout = isAiDeadlineTimeout(deadline, error);

      if (!isTimeout && deps.signal?.aborted) {
        interruptedDuringAi = true;
        break;
      }

      results.push({ file, status: 'failed', error: aiFailure(error, isTimeout) });
      continue;
    }

    if (tracker.interrupted) {
      interruptedDuringAi = true;
      break;
    }

    const parsedResponse = GENERATED_PLAN_RESPONSE_FOR_POLICY.safeParse(response.data);
    if (!parsedResponse.success) {
      results.push({
        file,
        status: 'failed',
        error: new AiResponseInvalidError(
          'The AI provider response did not match the generation contract.',
          { raw: response.raw, issues: parsedResponse.error.issues },
        ),
      });
      continue;
    }

    let prepared: InstructionCoverageResult<InstructionCoveredStep[]>;
    try {
      prepared = prepareInstructionCoveredSteps(
        parsedResponse.data,
        normalizedTestMd,
      );
    } catch (error) {
      results.push({ file, status: 'failed', error: fileFailure(error, 'The generated plan could not be inspected.') });
      continue;
    }
    if (!prepared.success) {
      results.push({
        file,
        status: 'failed',
        error: new AiResponseInvalidError(
          'The AI provider response contains invalid instruction coverage.',
          { raw: response.raw, issues: prepared.issues },
        ),
      });
      continue;
    }

    const normalizedSteps = normalizeAiStepSecretGrants(prepared.data);
    const candidate = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      source: { inputsDigest },
      ...(response.data.generatorMeta === undefined ? {} : { generatorMeta: response.data.generatorMeta }),
      targets: resolvedTargets,
      steps: normalizedSteps,
    };
    const parsedPlan = PlanDocument.safeParse(candidate);
    if (!parsedPlan.success) {
      results.push({
        file,
        status: 'failed',
        error: new AiResponseInvalidError(
          'The AI provider response could not form a valid plan.',
          { raw: response.raw, issues: parsedPlan.error.issues },
        ),
      });
      continue;
    }

    try {
      assertNoLiteralSecrets(parsedPlan.data);
    } catch (error) {
      results.push({ file, status: 'failed', error: fileFailure(error, 'The generated plan could not be inspected.') });
      continue;
    }

    if (options.dryRun) {
      try {
        assertNoLiteralSecrets(response.data.ambiguities);
      } catch (error) {
        results.push({ file, status: 'failed', error: fileFailure(error, 'The generated ambiguities could not be inspected.') });
        continue;
      }
      results.push({ file, status: 'would-generate', planFile: planPath, ambiguities: response.data.ambiguities });
      continue;
    }

    try {
      assertNoLiteralSecrets(response.data.ambiguities);
    } catch (error) {
      results.push({ file, status: 'failed', error: fileFailure(error, 'The generated ambiguities could not be inspected.') });
      continue;
    }

    try {
      await deps.storage.writeText(planPath, asArtifactText(parsedPlan.data as unknown as JsonValueT));
      await deps.storage.writeText(groundingPath, asArtifactText(emptyGrounding(parsedPlan.data) as unknown as JsonValueT));
      results.push({ file, status: 'generated', planFile: planPath, ambiguities: response.data.ambiguities });
    } catch (error) {
      results.push({ file, status: 'failed', error: fsIoError('The generated artifacts could not be written.', error) });
    }
    } finally {
      if (!interruptedDuringAi) tracker.markTerminal(workKey);
    }
  }

  if (tracker.interrupted) results.push(...tracker.pendingIdentities.map((file) => ({ file, status: 'skipped' as const })));
  return { results, noTestsFound: false, interrupted: tracker.interrupted };
  } finally {
    tracker.dispose();
  }
}
