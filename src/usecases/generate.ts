/**
 * Defines deterministic orchestration for turning source Markdown prompts
 * into validated, reviewable ambercast plan artifacts.
 */

import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import { AmbercastError, type AmbercastError as AmbercastErrorType } from '#core/errors/types.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  GeneratedPlanResponse,
  GroundingDocument,
  PlanDocument,
  type GroundingDocument as GroundingDocumentType,
  type JsonValueT,
  type PlanDocument as PlanDocumentType,
  type TargetDefinition,
} from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { joinPath } from '#core/paths.js';
import type { AiExecutor } from '#ports/ai.js';
import type { StorageAdapter } from '#ports/storage.js';
import {
  assertNoLiteralSecrets,
  assertSecretRefsGrounded,
  extractDeclaredSecretRefs,
  normalizeAiStepSecretGrants,
} from './generator-secret-policy.js';

const GENERATED_PLAN_RESPONSE_SCHEMA = typedJsonSchema(GeneratedPlanResponse);

function asArtifactText(value: JsonValueT): string {
  return toCanonicalArtifactText(value);
}

function fsIoError(message: string, cause: unknown): FsIoError {
  return new FsIoError(message, undefined, { cause });
}

function fileFailure(error: unknown, message: string): AmbercastErrorType {
  return error instanceof AmbercastError ? error : fsIoError(message, error);
}

function resolveTarget(
  config: GenerateDeps['config'],
  options: GenerateOptions,
): Readonly<Record<string, TargetDefinition>> | TargetUnresolvedError {
  const targetName = options.target ?? config.defaultTarget;
  const target = targetName === undefined ? undefined : config.targets[targetName];

  if (targetName === undefined || target === undefined) {
    return new TargetUnresolvedError('The requested generation target is not configured.', { target: targetName ?? '(default)' });
  }

  return { [targetName]: target };
}

function validFreshPlan(text: string, inputsDigest: string): PlanDocumentType | undefined {
  try {
    const parsed = PlanDocument.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.source.inputsDigest !== inputsDigest) {
      return undefined;
    }

    return asArtifactText(parsed.data as unknown as JsonValueT) === text ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function freshPlan(
  storage: StorageAdapter,
  planPath: string,
  inputsDigest: string,
): Promise<PlanDocumentType | undefined> {
  if (!(await storage.exists(planPath))) {
    return undefined;
  }

  return validFreshPlan(await storage.readText(planPath), inputsDigest);
}

function emptyGrounding(plan: PlanDocumentType): GroundingDocumentType {
  return { schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {} };
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

function aiFailure(error: unknown): AmbercastErrorType {
  if (error instanceof AmbercastError) {
    return error;
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
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

  /** Optional configured target name for this batch. */
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

  /** Caller cancellation that stops scheduling further files. */
  readonly signal?: AbortSignal;
}

/**
 * The per-file state represented in a generation outcome.
 */
export type GenerateFileStatus = 'generated' | 'skipped-fresh' | 'would-generate' | 'listed' | 'failed';

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
 * Ordered results of one generation invocation.
 */
export interface GenerateOutcome {
  /** Per-file results in literal or deterministic discovery order. */
  readonly results: readonly GenerateFileOutcome[];

  /** Whether resolution found no files before any per-file work began. */
  readonly noTestsFound: boolean;
}

/**
 * Generates or previews deterministic plan artifacts for resolved prompt files.
 *
 * @param deps - I/O, layout, provider, discovery, configuration, and optional
 * cancellation dependencies.
 * @param options - Batch selection and generation policy.
 * @returns Ordered file outcomes and the zero-match fact needed by the command
 * layer's exit policy.
 * @remarks
 * Literal paths retain caller order; discovered paths retain the order supplied
 * by the injected discovery seam, which owns sorting and deduplication. List
 * mode performs that filesystem discovery but does not read prompt files,
 * invoke AI, or write artifacts. Other files run sequentially, so a caller
 * cancellation prevents new work without discarding earlier outcomes, while
 * an individual file failure does not block later files.
 *
 * Freshness requires both semantic validity and canonical artifact bytes,
 * preventing malformed or reformatted plans from skipping generation. A
 * non-dry-run fresh plan repairs only its grounding cache, while dry-run leaves
 * that cache untouched; `force` is the explicit opt-out from fresh-plan reuse.
 * The provider receives a smaller response contract than the committed plan:
 * this use case owns provenance and target selection, then validates the
 * assembled plan and its duplicate-ID invariant before the literal-secret
 * policy permits persistence.
 *
 * The caller signal is distinct from the per-call timeout. Caller cancellation
 * stops scheduling and returns the completed partial outcome, while a timeout
 * fails only the current file as an unavailable executor. Plan text precedes
 * grounding text so a grounding write failure leaves a repairable fresh plan
 * rather than a partial plan. Cross-process generation against the same prompt
 * is undefined behavior.
 */
export async function generate(deps: GenerateDeps, options: GenerateOptions): Promise<GenerateOutcome> {
  const discovered = options.files.length === 0
    ? (await deps.discoverTestFiles({
      testDir: deps.config.testDir,
      testMatch: deps.config.testMatch,
      testIgnore: deps.config.testIgnore,
    })).map((path) => joinPath(deps.config.testDir, path))
    : [...options.files];

  if (discovered.length === 0) {
    return { results: [], noTestsFound: true };
  }

  if (options.list) {
    return {
      results: discovered.map((file) => ({ file, status: 'listed' })),
      noTestsFound: false,
    };
  }

  const results: GenerateFileOutcome[] = [];
  for (const file of discovered) {
    if (deps.signal?.aborted) {
      break;
    }

    let testMd: string;
    try {
      testMd = await deps.storage.readText(file);
    } catch (error) {
      results.push({ file, status: 'failed', error: fsIoError('The test prompt could not be read.', error) });
      continue;
    }

    const resolvedTargets = resolveTarget(deps.config, options);
    if (resolvedTargets instanceof TargetUnresolvedError) {
      results.push({ file, status: 'failed', error: resolvedTargets });
      continue;
    }

    const normalizedTestMd = normalizeTestMd(testMd);
    const inputsDigest = computeInputsDigest({
      normalizedTestMd,
      schemaVersion: 1,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      targetDefinitions: resolvedTargets,
    });
    const planPath = deps.layout.planPathFor(file);
    const groundingPath = deps.layout.groundingPathFor(file);

    let existingPlan: PlanDocumentType | undefined;
    try {
      existingPlan = await freshPlan(deps.storage, planPath, inputsDigest);
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

    const timeout = AbortSignal.timeout(deps.config.ai.timeoutMs);
    const signal = AbortSignal.any(deps.signal === undefined ? [timeout] : [deps.signal, timeout]);
    let response;
    try {
      response = await deps.aiExecutor.execute({
        prompt: 'Generate a deterministic ambercast execution plan for the supplied Markdown test.',
        responseSchema: GENERATED_PLAN_RESPONSE_SCHEMA,
        context: { testMd: normalizedTestMd, targets: resolvedTargets },
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        results.push({ file, status: 'failed', error: aiFailure(error) });
        continue;
      }

      if (deps.signal?.aborted) {
        break;
      }

      results.push({ file, status: 'failed', error: aiFailure(error) });
      continue;
    }

    const normalizedSteps = normalizeAiStepSecretGrants(response.data.steps);
    const candidate = {
      schemaVersion: 1,
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
      /*
       * Keeping declaration validation before either preview or persistence
       * makes undeclared secret usage fail uniformly without writing artifacts.
       */
      const declaredRefs = extractDeclaredSecretRefs(normalizedTestMd);
      assertSecretRefsGrounded(parsedPlan.data, declaredRefs);
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
  }

  return { results, noTestsFound: false };
}
