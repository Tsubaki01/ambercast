import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { composeAiDeadline, isAiDeadlineTimeout } from '#core/ai/ai-deadline.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
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
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import { normalizeTestMd, type NormalizedTestMd } from '#core/ir/normalize.js';
import { isSnapshotInvalid } from '#core/ir/aria-snapshot.js';
import {
  isAllowedSecretSinkOrigin,
  resolveSecretSinkPolicy,
  type SecretSinkPolicy,
} from '#core/secrets/sink-policy.js';
import {
  GROUNDING_SCHEMA_VERSION,
  GroundingDocument,
  PLAN_SCHEMA_VERSION,
  PlanDocument,
  RunRef,
  TraceAction,
  TraceAssert,
  TraceRecord,
  type ActionStep,
  type AssertStep,
  type CaptureStep,
  type ElementRef,
  type GroundingEntry,
  type GroundingDocument as GroundingDocumentType,
  type GroundingDocumentWithCoverageStorage,
  type InstructionCoveredPlanDocument,
  type JsonValueT,
  type PlanDocument as PlanDocumentType,
  type RunVariableName,
  type Step,
  type StepId,
  type TargetDefinition,
  type TraceRecordWithCoverageStorage,
} from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { joinPath, relativeWithin } from '#core/paths.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { resolveTarget } from '#core/target/resolve.js';
import type {
  InstructionCoverageAiActionController,
  InstructionCoveredAiExecutor,
  PreScannedTraceRecord,
} from '#ports/ai.js';
import type {
  AssertCheck,
  AssertOutcome,
  AccessibilityCapture,
  BoundElement,
  BrowserSession,
  GroundingMissReason,
  PerformableAction,
} from '#ports/browser.js';
import type { BrowserDriverResolver } from '#ports/index.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock, EventSink, SecretsProvider } from '#ports/system.js';
import { OBSERVED_NOTE, type ExecutedRunResult, type Observed, type StepResult } from '#report/schema.js';
import { z } from 'zod';
import {
  assertCommittedSecretAttributionSound,
  detectSecretLiteral,
  type SecretDetector,
} from './generator-secret-policy.js';
import type {
  CoveredTraceRecord,
  TrustedInstructionCriterion,
} from './instruction-coverage-policy.js';
import {
  classifyPreScannedTraceCoverage,
  validateCommittedInstructionCoverage,
} from './instruction-coverage-policy.js';

/**
 * Execution evidence while a case is still in progress.
 *
 * Duration is attached only after teardown, so this intermediary keeps every
 * executed-result field except the clock-derived value. It intentionally does
 * not use the public union because a listed file never enters case execution.
 */
type ResultWithoutDuration = Omit<ExecutedRunResult, 'durationMs'>;

/**
 * Optional diagnostic evidence retained only for a failed dispatched step.
 *
 * Deriving this shape from {@link StepResult} keeps evidence capture aligned
 * with the public report contract as that contract evolves, without a second
 * hand-maintained copy of its field vocabulary.
 */
type FailureDetail = Pick<StepResult, 'expected' | 'actual' | 'screenshot' | 'screenshotOmitted' | 'observed'>;

type ResolutionVia = 'grounding' | 'ai-resolve' | 'trace-replay';

type DispatchOutcome =
  | { readonly kind: 'passed'; readonly via?: ResolutionVia }
  | { readonly kind: 'assertion-failed'; readonly expected: string; readonly actual: string };

/**
 * Carries a materialized secret fill through the private run dispatcher.
 *
 * This run-local counterpart to {@link PerformableAction} is never persisted
 * or passed across a port boundary as a bare value. It funnels deterministic
 * replay, trace replay, and live agentic execution through one secret-fill
 * dispatch point while the policy travels unchanged with the resolved value.
 */
type MaterializedFillSecretAction = {
  readonly type: 'fill-secret';
  readonly target: BoundElement;
  readonly value: string;
  readonly policy: SecretSinkPolicy;
};

type MaterializedAction = PerformableAction | MaterializedFillSecretAction;

interface DispatchContext {
  readonly session: BrowserSession;
  /**
   * The resolved replay target retained while actions are materialized.
   *
   * Navigate fields deliberately continue to accept relative URLs, whose
   * safety depends on the target's base URL only after case values have been
   * substituted. Keeping the target at this boundary lets the navigation
   * guard compare the materialized destination with the replay target instead of
   * imposing a schema restriction that would reject valid relative paths.
   */
  readonly target: TargetDefinition;
  readonly grounding: GroundingDocumentType;
  readonly runState: Map<RunVariableName, string>;
  readonly secrets: SecretsProvider;
  /**
   * Every non-empty value resolved for a secret reference during this case.
   *
   * A provider may legitimately return a different value for a later
   * resolution of the same reference, so this registry retains all observed
   * non-empty values until every diagnostic and persistence boundary has
   * completed.
   */
  readonly resolvedSecrets: Map<string, Set<string>>;
  readonly allowedRunRefs: ReadonlySet<RunVariableName>;
  readonly instructionCoverageByStepId: ReadonlyMap<StepId, readonly TrustedInstructionCriterion[]>;
  readonly resolveAiExecutor: () => Promise<InstructionCoveredAiExecutor>;
  readonly cacheOnly: boolean;
  readonly events: EventSink;
  readonly updateGroundingEntry: (stepId: Step['id'], entry: GroundingEntry) => void;
  readonly deleteGroundingEntry: (stepId: Step['id']) => void;
  readonly resolvedVias: Map<Step['id'], ResolutionVia>;
  readonly aiTimeoutMs: number;
  readonly signal?: AbortSignal;
}

type TraceTrustContext = Pick<
  DispatchContext,
  'target' | 'secrets' | 'resolvedSecrets' | 'allowedRunRefs'
> & {
  readonly runState: ReadonlyMap<RunVariableName, string>;
  readonly deferHighEntropyFillCheck?: boolean;
  readonly skipSecretPriming?: boolean;
  readonly rejectCapturedRunLiterals?: boolean;
};

type TraceReplayMaterializationContext = Pick<
  DispatchContext,
  'session' | 'target' | 'secrets' | 'resolvedSecrets' | 'allowedRunRefs'
> & { readonly runState: ReadonlyMap<RunVariableName, string> };

/**
 * Capabilities available to covered deterministic replay.
 *
 * @remarks
 * The surface deliberately omits AI execution and resolution. A validated
 * covered trace therefore cannot trigger an AI call by construction; browser
 * and local run-value capabilities are sufficient for replay.
 */
export interface CoveredTraceReplayContext {
  /** Live browser session used only after local coverage validation. */
  readonly session: BrowserSession;

  /** Live resolved target used for navigation and secret-sink checks. */
  readonly target: TargetDefinition;

  /** Captured case values available for trusted interpolation. */
  readonly runState: ReadonlyMap<RunVariableName, string>;

  /** Secrets provider retained behind the existing sink policy. */
  readonly secrets: SecretsProvider;

  /** Values already resolved for whole-trace taint rejection. */
  readonly resolvedSecrets: Map<string, Set<string>>;

  /** Run variables authorized by the containing plan. */
  readonly allowedRunRefs: ReadonlySet<RunVariableName>;

  /** Caller cancellation observed between deterministic replay entries. */
  readonly signal?: AbortSignal;
}

type StepExecutor = (step: Step, context: DispatchContext) => Promise<DispatchOutcome>;

const RUN_REFERENCE_PATTERN = /\{\{run\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}\}/g;
const RUN_REFERENCE_START = '{{run.';

/**
 * Smallest resolved secret length that is safe to treat as a substring
 * indicator.
 *
 * Short values still require exact-field protection, but common prose and
 * URLs naturally contain very short sequences. Keeping substring detection
 * above that collision-prone range rejects a materialized credential without
 * turning ordinary provider diagnostics into integrity failures.
 */
const MIN_SECRET_MATCH_LENGTH = 3;

/**
 * Defines the confirmation-only response accepted from AI-assisted element
 * re-resolution.
 *
 * The run pipeline derives the fingerprint from unredacted local snapshot
 * evidence before an AI call, so the provider has no authority to supply a
 * value that later becomes grounding. A strict binary judgment retains the
 * provider's semantic role while allowing an explicit denial and rejecting
 * invented response fields.
 */
const CONFIRMATION_RESPONSE = z.strictObject({ confirmed: z.boolean() });

/**
 * Couples the confirmation response's runtime validation to the structured AI
 * request without exposing a second, hand-maintained wire schema.
 */
const CONFIRMATION_RESPONSE_SCHEMA = typedJsonSchema(CONFIRMATION_RESPONSE);

/**
 * Invokes one AI request under this dispatch context's deadline policy.
 *
 * A confirmed local expiry becomes an `AiExecutorUnavailableError` with the
 * configured-timeout message. Every other provider failure retains its
 * original error for the caller's existing handling path.
 */
async function callAiExecutor<T>(
  context: DispatchContext,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = composeAiDeadline(context.signal, context.aiTimeoutMs);
  try {
    return await invoke(deadline.signal);
  } catch (error) {
    if (isAiDeadlineTimeout(deadline, error)) {
      throw new AiExecutorUnavailableError(
        'The AI provider did not respond within the configured timeout.',
        undefined,
        { cause: error },
      );
    }

    throw error;
  }
}

/**
 * Marks an abort that has no reportable error kind while retaining a useful
 * case-level explanation.
 */
class CaseAbort extends Error {}
class AgenticCoverageAbort extends CaseAbort {}
class TraceProviderExposureIntegrityError extends IntegrityViolationError {}

function fsIoError(message: string, cause: unknown): FsIoError {
  return new FsIoError(message, undefined, { cause });
}

function emptyGrounding(plan: PlanDocumentType): GroundingDocumentType {
  return { schemaVersion: GROUNDING_SCHEMA_VERSION, planDigest: computePlanDigest(plan), entries: {} };
}

/** Trusted Plan-v2 data and locally re-extracted criterion projections. */
export interface TrustedInstructionCoveredPlan {
  /** Strict canonical Plan-v2 document whose committed spans are valid. */
  readonly plan: InstructionCoveredPlanDocument;

  /** Trusted criteria keyed by schema-validated Plan step IDs. */
  readonly instructionCoverageByStepId: ReadonlyMap<
    StepId,
    readonly TrustedInstructionCriterion[]
  >;
}

/**
 * Loads a Plan-v2 artifact through every execution trust boundary.
 *
 * @param storage - Read capability for the committed Plan artifact.
 * @param planPath - Exact companion path selected for this prompt.
 * @param inputsDigest - Expected digest for Plan version, prompt, and target.
 * @param normalizedTestMd - Canonical prompt used to re-extract every span.
 * @returns The trusted Plan plus step-keyed local criterion projections.
 * @remarks
 * Strict schema, canonical bytes, digest equality, and committed instruction
 * coverage all complete before grounding inspection, browser launch, or AI
 * resolution. Invalid source coordinates or whitespace-only re-extraction are
 * integrity failures rather than authority-bearing metadata.
 */
export async function readTrustedInstructionCoveredPlan(
  storage: StorageAdapter,
  planPath: string,
  inputsDigest: string,
  normalizedTestMd: NormalizedTestMd,
): Promise<TrustedInstructionCoveredPlan> {
  const plan = await readTrustedPlan(storage, planPath, inputsDigest);
  const instructionCoverageByStepId = new Map<StepId, readonly TrustedInstructionCriterion[]>();
  for (const step of plan.steps) {
    if (step.kind !== 'ai') continue;
    const result = validateCommittedInstructionCoverage(step.instructionCoverage, normalizedTestMd);
    if (!result.success) {
      throw new IntegrityViolationError('The generated plan contains invalid instruction coverage or source spans.', {
        planPath,
        issues: result.issues,
      });
    }
    instructionCoverageByStepId.set(step.id, result.data);
  }
  return { plan, instructionCoverageByStepId };
}

/**
 * Loads the only Plan version that may reach execution trust boundaries.
 *
 * @remarks
 * The instruction-coverage implementation makes strict Plan-v2 parsing,
 * canonical bytes, input digest, and committed prompt-span re-extraction one
 * ordered gate before browser launch or AI resolution. Plan v1 fails schema or
 * freshness and is never migrated during run. Grounding remains version 1 and
 * is classified independently because its nested trace extension is additive.
 */
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

/**
 * Result of inspecting raw grounding before any trace becomes recoverable.
 *
 * @remarks
 * A miss covers absent files, invalid JSON, stale provenance, and unrelated
 * coverage-absent schema failure. A current-provenance document with an own
 * `entries[rawKey].trace.verificationCoverage` path is a hard claim,
 * independently of whether that entry's `kind` is valid. Raw entry keys are
 * not filtered through the StepId grammar before claim recognition;
 * `coverageClaimStepIds` contains StepId values only after the entire document
 * passes strict validation. Structural or canonical claim failure becomes an
 * integrity failure rather than a cache miss. Successful branches expose only
 * a strict parsed document, never a trace recovered from a shallow or raw
 * object.
 */
export type GroundingCoverageSourceInspection =
  | { readonly kind: 'cache-miss' }
  | {
    readonly kind: 'strict-grounding';
    readonly document: GroundingDocumentWithCoverageStorage;
    readonly coverageClaimStepIds: readonly StepId[];
  }
  | {
    readonly kind: 'integrity-failure';
    readonly reason: 'coverage-structure-invalid' | 'coverage-canonical-invalid';
  };

type RawJsonNode =
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, RawJsonNode])[] }
  | { readonly kind: 'array'; readonly items: readonly RawJsonNode[] }
  | { readonly kind: 'scalar' };

/**
 * Parses JSON without collapsing repeated object members.
 *
 * JSON.parse remains the runtime schema input, while this narrow reader keeps
 * every raw member occurrence long enough to recognize an exact-path coverage
 * claim that a later duplicate key could otherwise hide. It assigns no trust
 * to values and exposes only object structure needed by the staged loader.
 */
class DuplicatePreservingJsonReader {
  #offset = 0;

  constructor(private readonly source: string) {}

  parse(): RawJsonNode {
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#offset !== this.source.length) throw new SyntaxError('Unexpected trailing JSON data.');
    return value;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.source[this.#offset] ?? '')) this.#offset += 1;
  }

  #parseValue(): RawJsonNode {
    this.#skipWhitespace();
    switch (this.source[this.#offset]) {
      case '{':
        return this.#parseObject();
      case '[':
        return this.#parseArray();
      case '"':
        this.#parseString();
        return { kind: 'scalar' };
      default:
        this.#parseScalar();
        return { kind: 'scalar' };
    }
  }

  #parseObject(): RawJsonNode {
    this.#offset += 1;
    const entries: Array<readonly [string, RawJsonNode]> = [];
    this.#skipWhitespace();
    if (this.source[this.#offset] === '}') {
      this.#offset += 1;
      return { kind: 'object', entries };
    }
    while (true) {
      this.#skipWhitespace();
      const key = this.#parseString();
      this.#skipWhitespace();
      if (this.source[this.#offset] !== ':') throw new SyntaxError('Expected a JSON member separator.');
      this.#offset += 1;
      entries.push([key, this.#parseValue()]);
      this.#skipWhitespace();
      const delimiter = this.source[this.#offset];
      if (delimiter === '}') {
        this.#offset += 1;
        return { kind: 'object', entries };
      }
      if (delimiter !== ',') throw new SyntaxError('Expected another JSON object member.');
      this.#offset += 1;
    }
  }

  #parseArray(): RawJsonNode {
    this.#offset += 1;
    const items: RawJsonNode[] = [];
    this.#skipWhitespace();
    if (this.source[this.#offset] === ']') {
      this.#offset += 1;
      return { kind: 'array', items };
    }
    while (true) {
      items.push(this.#parseValue());
      this.#skipWhitespace();
      const delimiter = this.source[this.#offset];
      if (delimiter === ']') {
        this.#offset += 1;
        return { kind: 'array', items };
      }
      if (delimiter !== ',') throw new SyntaxError('Expected another JSON array item.');
      this.#offset += 1;
    }
  }

  #parseString(): string {
    const start = this.#offset;
    if (this.source[this.#offset] !== '"') throw new SyntaxError('Expected a JSON string.');
    this.#offset += 1;
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset];
      if (character === '\\') {
        this.#offset += 2;
        continue;
      }
      this.#offset += 1;
      if (character === '"') {
        return JSON.parse(this.source.slice(start, this.#offset)) as string;
      }
    }
    throw new SyntaxError('Unterminated JSON string.');
  }

  #parseScalar(): void {
    const start = this.#offset;
    while (this.#offset < this.source.length && !/[\s,\]}]/u.test(this.source[this.#offset]!)) {
      this.#offset += 1;
    }
    if (start === this.#offset) throw new SyntaxError('Expected a JSON value.');
    JSON.parse(this.source.slice(start, this.#offset));
  }
}

function rawGroundingHasCoverageClaim(sourceText: string): boolean {
  const root = new DuplicatePreservingJsonReader(sourceText).parse();
  if (root.kind !== 'object') return false;
  for (const [rootKey, entries] of root.entries) {
    if (rootKey !== 'entries' || entries.kind !== 'object') continue;
    for (const [, entry] of entries.entries) {
      if (entry.kind !== 'object') continue;
      for (const [entryKey, trace] of entry.entries) {
        if (entryKey !== 'trace' || trace.kind !== 'object') continue;
        if (trace.entries.some(([traceKey]) => traceKey === 'verificationCoverage')) return true;
      }
    }
  }
  return false;
}

/**
 * Classifies raw grounding using staged provenance and coverage checks.
 *
 * @param sourceText - Exact artifact bytes read from storage.
 * @param expectedPlanDigest - Digest of the already trusted current plan.
 * @returns A miss, strict document class, or fail-closed coverage claim.
 * @remarks
 * The staged loader parses JSON and shallow-checks Grounding version 1 plus the
 * expected plan digest. Before strict parsing, a duplicate-preserving reader
 * enumerates every raw member occurrence under `entries` without StepId
 * grammar filtering. For each entry object, it follows only an own `trace`
 * object occurrence and then its own `verificationCoverage` property at
 * `entries[rawKey].trace.verificationCoverage`. A claim exists even when
 * `kind` is missing, non-string, or wrong; strict parsing owns both kind and
 * key validation. The traversal never recursively scans arbitrary values, so
 * an unrelated nested property cannot manufacture a claim. In a mixed
 * document, any exact-path claim makes subsequent strict or canonical failure
 * an integrity error even when other entries are legacy or valid.
 *
 * Strict success returns a Grounding-v1 coverage-aware projection and the
 * validated step IDs whose traces own coverage. An empty ID list represents a
 * strict legacy document; a non-empty list may coexist with legacy entries and
 * each trace is classified independently after pre-scan. Present coverage also
 * requires exact canonical bytes. Prototype inheritance never establishes
 * presence, duplicate raw keys cannot survive canonical equality, and no
 * branch returns an unvalidated raw trace. Once current provenance is
 * established, a duplicate-preserving reader failure is itself an integrity
 * failure because the loader can no longer prove that a hidden exact-path
 * coverage claim is absent.
 */
export function inspectGroundingCoverageSource(
  sourceText: string,
  expectedPlanDigest: string,
): GroundingCoverageSourceInspection {
  let raw: unknown;
  try {
    raw = JSON.parse(sourceText);
  } catch {
    return { kind: 'cache-miss' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'cache-miss' };
  const root = raw as Record<string, unknown>;
  if (root.schemaVersion !== GROUNDING_SCHEMA_VERSION || root.planDigest !== expectedPlanDigest) {
    return { kind: 'cache-miss' };
  }
  let hasClaim: boolean;
  try {
    hasClaim = rawGroundingHasCoverageClaim(sourceText);
  } catch {
    return { kind: 'integrity-failure', reason: 'coverage-structure-invalid' };
  }
  const parsed = GroundingDocument.safeParse(raw);
  if (!parsed.success) {
    return hasClaim
      ? { kind: 'integrity-failure', reason: 'coverage-structure-invalid' }
      : { kind: 'cache-miss' };
  }
  if (hasClaim && toCanonicalArtifactText(parsed.data as unknown as JsonValueT) !== sourceText) {
    return { kind: 'integrity-failure', reason: 'coverage-canonical-invalid' };
  }
  const coverageClaimStepIds = Object.entries(parsed.data.entries)
    .filter(([, entry]) => entry.kind === 'ai' && Object.hasOwn(entry.trace, 'verificationCoverage'))
    .map(([stepId]) => stepId);
  return { kind: 'strict-grounding', document: parsed.data, coverageClaimStepIds };
}

/**
 * Applies the general recoverable-cache rule for grounding without a trusted
 * current-provenance coverage claim.
 *
 * @remarks
 * The instruction-coverage loader supersedes this unconditional fallback for
 * current-provenance exact-path claims by routing them through
 * {@link inspectGroundingCoverageSource}. Malformed or noncanonical claimed
 * coverage therefore fails integrity instead of entering this function's
 * empty-grounding recovery path.
 */
async function readUsableGrounding(
  storage: StorageAdapter,
  groundingPath: string,
  plan: PlanDocumentType,
): Promise<GroundingDocumentType> {
  const empty = emptyGrounding(plan);

  try {
    if (!(await storage.exists(groundingPath))) return empty;
    const inspection = inspectGroundingCoverageSource(
      await storage.readText(groundingPath),
      empty.planDigest,
    );
    if (inspection.kind === 'integrity-failure') {
      throw new IntegrityViolationError('The grounding cache contains invalid or noncanonical instruction coverage.', {
        reason: inspection.reason,
      });
    }
    return inspection.kind === 'strict-grounding' ? inspection.document : empty;
  } catch (error) {
    if (error instanceof IntegrityViolationError) throw error;
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

function materializeStep(
  step: Step,
  runState: ReadonlyMap<RunVariableName, string>,
  baseUrl: string,
): Step {
  switch (step.kind) {
    case 'action':
      switch (step.action) {
        case 'navigate': {
          const url = materializeText(step.url, runState);
          assertSameOriginNavigation(url, baseUrl);
          return { ...step, url };
        }
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
      // Agentic instructions retain unresolved run references as trusted plan
      // metadata; the controller alone materializes provider-directed actions.
      return step;
    case 'capture':
      return step;
  }
}

/**
 * Verifies provider-controlled run references against the current case before
 * any browser operation can receive their materialized values.
 *
 * The persisted trace schema deliberately permits generic interpolatable
 * text, because a trace's authority depends on the current case rather than
 * on its static JSON shape. This guard therefore treats malformed, ungranted,
 * or unavailable references as integrity violations instead of allowing a
 * provider or stale trace to select an arbitrary browser value.
 */
function assertTrustedRunReferences(value: string, context: TraceTrustContext): void {
  let cursor = 0;

  while (true) {
    const start = value.indexOf(RUN_REFERENCE_START, cursor);
    if (start < 0) {
      return;
    }

    const end = value.indexOf('}}', start + RUN_REFERENCE_START.length);
    if (end < 0) {
      throw new IntegrityViolationError('An AI trace contains a malformed run reference.');
    }

    const reference = value.slice(start, end + 2);
    if (!RunRef.safeParse(reference).success) {
      throw new IntegrityViolationError('An AI trace contains a malformed run reference.');
    }

    const name = reference.slice(RUN_REFERENCE_START.length, -2) as RunVariableName;
    if (!context.allowedRunRefs.has(name)) {
      throw new IntegrityViolationError('An AI trace references a run value that this step is not allowed to use.', {
        runRef: name,
      });
    }

    if (!context.runState.has(name)) {
      throw new IntegrityViolationError('An AI trace references a run value that is unavailable in this case.', {
        runRef: name,
      });
    }

    cursor = end + 2;
  }
}

/**
 * Resolves trusted run templates only at the browser-call boundary.
 *
 * The prior validation makes a missing map value unreachable in ordinary
 * execution, but the second check keeps this trust boundary fail-closed if
 * case state changes between validation and replacement.
 */
function materializeTrustedRunText(value: string, context: TraceTrustContext): string {
  assertTrustedRunReferences(value, context);

  return value.replace(RUN_REFERENCE_PATTERN, (_reference, path: string) => {
    const name = path as RunVariableName;
    const captured = context.runState.get(name);
    if (captured === undefined) {
      throw new IntegrityViolationError('An AI trace references a run value that is unavailable in this case.', {
        runRef: name,
      });
    }

    return captured;
  });
}

/**
 * Establishes the HTTP(S)-scheme and same-origin boundary for every
 * navigation that can reach the browser port.
 *
 * Navigate URLs remain interpolatable rather than receiving an HTTP-only
 * schema constraint because the browser must still resolve valid relative
 * paths, fragments, and other target-relative forms. The resolved destination
 * must use HTTP(S) before origin equality is compared. That order is
 * essential: a `blob:` URL inherits its creating context's HTTP(S) origin and
 * could otherwise appear same-origin even though its scheme is outside this
 * browser boundary's trust. It rejects a destination that cannot be resolved,
 * uses a non-HTTP(S) scheme, or resolves to a different origin as an
 * `IntegrityViolationError`.
 * Resolving against `baseUrl` is sound because `ChromiumBrowserDriver.launch()`
 * configures its Playwright context with the identical `target.baseUrl` via
 * `browser.newContext({ baseURL: target.baseUrl })`, so this guard and
 * `page.goto()` resolve the same relative string against the same fixed base.
 *
 * Its error contract remains fully static: destination-derived text might
 * be a captured or secret value transformed by URL normalization, so
 * value-based redaction cannot safely justify returning it in an error. The
 * check appears in deterministic grounding, at the trace-action browser
 * boundary shared by trace replay and fresh agentic execution, and in the
 * latter's whole-trace pre-scan before any action runs. Together those
 * checkpoints preserve the invariant that every navigation URL reaching the
 * browser port passes through this guard.
 *
 * @param url - The navigation destination after any permitted interpolation.
 * @param baseUrl - The configured base URL of the resolved replay target.
 * @throws {IntegrityViolationError} When the destination cannot be resolved,
 *   uses a non-HTTP(S) scheme, or does not remain on the replay target's
 *   origin.
 */
function assertSameOriginNavigation(url: string, baseUrl: string): void {
  let baseOrigin: string;
  let destination: URL;

  try {
    baseOrigin = new URL(baseUrl).origin;
    destination = new URL(url, baseUrl);
  } catch {
    throw new IntegrityViolationError('A navigation URL cannot be resolved against the replay target.');
  }

  if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
    throw new IntegrityViolationError('A navigation URL must use the replay target\'s HTTP(S) scheme.');
  }

  if (destination.origin !== baseOrigin) {
    throw new IntegrityViolationError('A navigation URL must remain on the replay target origin.');
  }
}

/**
 * Resolves and checks the live target's secret-sink policy before lookup.
 *
 * This is the sink-side counterpart to, not a replacement for,
 * {@link assertSameOriginNavigation}. It resolves a policy from
 * `context.target`, which is always the live-config-resolved target rather
 * than a target copied from a parsed plan, then reads
 * `context.session.currentUrl()`. A disallowed origin throws
 * {@link IntegrityViolationError} with the secret reference, allowed origins,
 * and policy source, never a resolved value, before deterministic or fresh
 * agentic dispatch resolves the value for that fill. Replay entry
 * materialization likewise applies this gate before resolving its fill value.
 * Trace pre-scan has the narrower, documented role of priming granted
 * references for whole-trace taint checks; it performs no browser action. This
 * per-entry gate still rejects before replay can dispatch the fill, and its
 * integrity failure suppresses agentic fallback.
 *
 * @param context - The live dispatch context that owns configuration and session state.
 * @param secretRef - The secret whose fill destination requires authorization.
 * @returns The policy to carry unchanged to the operation-immediate browser check.
 * @throws {IntegrityViolationError} When the current origin is not allowed.
 */
async function assertAllowedSecretSinkOrigin(
  context: TraceReplayMaterializationContext,
  secretRef: string,
): Promise<SecretSinkPolicy> {
  const policy = resolveSecretSinkPolicy(context.target, secretRef);
  const currentUrl = await context.session.currentUrl();
  if (!isAllowedSecretSinkOrigin(policy, currentUrl)) {
    throw new IntegrityViolationError('The current page origin is not allowed to receive this secret.', {
      secretRef: policy.secretRef,
      allowedOrigins: policy.allowedOrigins,
      source: policy.source,
    });
  }

  return policy;
}

/**
 * Retains every non-empty resolved secret value for every later redaction
 * boundary in this case.
 *
 * A set prevents a rotation-aware or retrying provider from overwriting an
 * earlier value that may still be present in browser diagnostics. The registry
 * remains keyed by the stable reference so replacement can restore that
 * reference without persisting the materialized value itself. An empty input
 * is a no-op because it cannot safely form a redaction candidate.
 */
function recordResolvedSecret(registry: Map<string, Set<string>>, ref: string, value: string): void {
  if (value === '') {
    return;
  }

  const values = registry.get(ref) ?? new Set<string>();
  values.add(value);
  registry.set(ref, values);
}

/**
 * Routes one already-materialized action to the browser operation that owns it.
 *
 * This is the only intended location in `src/**` for a direct
 * `session.fillSecret(...)` call. `test/architecture.test.ts` and the
 * fill-secret call-site scanner provide a declaration-aware direct-call check,
 * not a complete data-flow proof: an aliased indirection or a call through a
 * differently typed value could evade it. Taking only the session-shaped
 * dependency keeps the dispatcher independent of the broader dispatch
 * context, whose remaining state it never needs. The dispatcher deliberately
 * leaves browser rejections unchanged: stored-trace replay applies its
 * secret-specific fail-closed rule only to rejection of the materialized
 * `fill-secret` operation being invoked, while fresh agentic execution retains
 * its existing controller semantics.
 *
 * @param materialized - An ordinary action or the private secret-fill action.
 * @param session - The browser session that owns the corresponding port methods.
 * @returns Resolves after the selected browser operation completes.
 */
async function performMaterializedAction(
  materialized: MaterializedAction,
  session: BrowserSession,
): Promise<void> {
  if (materialized.type === 'fill-secret') {
    await session.fillSecret(materialized.target, materialized.value, materialized.policy);
    return;
  }

  await session.perform(materialized);
}

/**
 * Converts a trusted unresolved trace action into the browser port's
 * materialized action shape immediately before execution.
 *
 * Trace actions retain their authored locator in durable trace data, but every
 * element-targeted branch obtains a session-local `BoundElement` through the
 * compute-mode grounding query at the browser boundary. A trace has no saved
 * fingerprint to verify, so compute mode is the only safe way to derive one
 * from the page observation used to bind its unique candidate.
 *
 * `fill-secret` first applies its per-entry sink-origin gate before resolving
 * and recording its own value, then requests the compute-mode bind. Both later
 * operations use `context.resolvedSecrets`, so that registry remains the
 * bind's taint gate. The pre-scan priming pass is intentionally distinct: it
 * resolves all trace secrets before per-entry checks so a pre-navigation
 * origin cannot incorrectly reject a legitimate later cross-origin redirect.
 */
async function materializeTraceAction(
  action: TraceAction,
  context: TraceReplayMaterializationContext,
  secretRefs: ReadonlySet<string>,
): Promise<MaterializedAction> {
  switch (action.type) {
    case 'click':
      return { type: 'click', target: await bindTraceTarget(action.target, context) };
    case 'navigate': {
      const url = materializeTrustedRunText(action.url, context);
      assertSameOriginNavigation(url, context.target.baseUrl);
      return { type: 'navigate', url };
    }
    case 'press':
      return {
        type: 'press',
        target: await bindTraceTarget(action.target, context),
        key: action.key,
      };
    case 'fill':
      return {
        type: 'fill',
        target: await bindTraceTarget(action.target, context),
        value: materializeTrustedRunText(action.value, context),
      };
    case 'fill-secret': {
      if (!secretRefs.has(action.secretRef)) {
        throw new IntegrityViolationError('An AI trace references a secret that this step is not allowed to use.', {
          secretRef: action.secretRef,
        });
      }

      const policy = await assertAllowedSecretSinkOrigin(context, action.secretRef);

      const value = context.secrets.resolve(action.secretRef);
      if (value === undefined) {
        throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: action.secretRef });
      }

      recordResolvedSecret(context.resolvedSecrets, action.secretRef, value);
      return {
        type: 'fill-secret',
        target: await bindTraceTarget(action.target, context),
        value,
        policy,
      };
    }
  }
}

/**
 * Converts a trusted unresolved trace assertion to the browser's materialized
 * check shape immediately before evaluation.
 *
 * Assertions never resolve secrets, but their text and URL expectations may
 * reference a captured case value and must therefore use the same grant and
 * availability checks as trace actions. `element-visible` and `text-equals`
 * bind their trace locator in compute mode immediately before evaluation;
 * `element-count` remains page-scoped and retains its bare `ElementRef` so it
 * can measure absent or duplicate matches without requiring false singularity.
 */
async function materializeTraceAssert(
  check: TraceAssert,
  context: TraceReplayMaterializationContext,
): Promise<AssertCheck> {
  switch (check.check) {
    case 'text-visible':
      return { check: 'text-visible', text: materializeTrustedRunText(check.text, context) };
    case 'element-visible':
      return { check: 'element-visible', target: await bindTraceTarget(check.target, context) };
    case 'text-equals':
      return {
        check: 'text-equals',
        target: await bindTraceTarget(check.target, context),
        text: materializeTrustedRunText(check.text, context),
      };
    case 'url-matches':
      return { check: 'url-matches', pattern: materializeTrustedRunText(check.pattern, context) };
    case 'element-count':
      return { check: 'element-count', target: check.target, count: check.count };
  }
}

async function bindTraceTarget(
  target: ElementRef,
  context: TraceReplayMaterializationContext,
): Promise<BoundElement> {
  const resolved = await context.session.resolveGrounded(target, {
    mode: 'compute',
    resolvedSecrets: [...context.resolvedSecrets.values()],
  });
  if (resolved.kind === 'miss') {
    throw new Error(`The trace target could not be bound: ${resolved.reason}.`);
  }

  return resolved.element;
}

/**
 * Checks the dynamic authority requirements of one already-parsed trace item.
 *
 * `readUsableGrounding` has already validated the complete document shape and
 * `preScanTrace` has validated and resolved every trace secret. This checks
 * the remaining runtime facts: current-case run grants and materialized values
 * in fields that can cross the replay boundary. A `fill` value receives its
 * credential-shaped-literal check only after run-reference validation so an
 * invalid reference retains diagnostic precedence.
 *
 * The resolved-secret scan remains separate from the narrow `fill` heuristic:
 * the former protects every provider- or case-derived trace field, while the
 * latter avoids extending credential classification to URLs, assertions, and
 * locator names where high-entropy text can be legitimate.
 */
function preScanTraceEntry(
  entry: TraceAction | TraceAssert,
  context: TraceTrustContext,
): void {
  const rejectSecretReference = (value: unknown, key?: string): void => {
    if (key === 'secretRef') return;
    if (typeof value === 'string') {
      if (value.includes('{{secrets.')) {
        throw new IntegrityViolationError('An AI trace contains a secret reference outside an authorized secret field.');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) rejectSecretReference(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) rejectSecretReference(child, childKey);
    }
  };
  rejectSecretReference(entry);
  /*
   * `preScanTrace` primes the resolved-secret registry from the complete trace
   * before this validation pass, making each inspection independent of journal
   * order. Rejecting a materialized secret before replay prevents a contaminated
   * historical trace from reaching either browser execution or an AI adapter as
   * `priorTrace`.
   */
  if (traceEntryContainsResolvedSecret(entry, context.resolvedSecrets)) {
    throw new IntegrityViolationError('An AI trace contains a materialized secret value.');
  }
  const containsCapturedRunValue = context.rejectCapturedRunLiterals
    && traceEntryContainsCapturedRunValue(entry, context.runState);
  const rejectCapturedRunValue = (): void => {
    if (containsCapturedRunValue) {
      throw new TraceProviderExposureIntegrityError('An AI trace contains a materialized captured run value.');
    }
  };

  switch (entry.type === 'assert' ? entry.check : entry.type) {
    case 'navigate': {
      const url = (entry as Extract<TraceAction, { type: 'navigate' }>).url;
      assertTrustedRunReferences(url, context);
      /*
       * Pre-scanning the whole trace preserves replay atomicity: a later
       * unsafe navigation cannot let an earlier valid action execute.
       */
      assertSameOriginNavigation(materializeTrustedRunText(url, context), context.target.baseUrl);
      rejectCapturedRunValue();
      return;
    }
    case 'fill': {
      const value = (entry as Extract<TraceAction, { type: 'fill' }>).value;
      assertTrustedRunReferences(value, context);
      if (!(context.deferHighEntropyFillCheck && detectSecretLiteral(value) === 'high-entropy-token')) {
        assertNoCredentialShapedFillValue(value, context.runState);
      }
      rejectCapturedRunValue();
      return;
    }
    case 'text-visible': {
      const text = (entry as Extract<TraceAssert, { check: 'text-visible' }>).text;
      assertTrustedRunReferences(text, context);
      rejectCapturedRunValue();
      return;
    }
    case 'text-equals': {
      const text = (entry as Extract<TraceAssert, { check: 'text-equals' }>).text;
      assertTrustedRunReferences(text, context);
      rejectCapturedRunValue();
      return;
    }
    case 'url-matches': {
      const pattern = (entry as Extract<TraceAssert, { check: 'url-matches' }>).pattern;
      assertTrustedRunReferences(pattern, context);
      rejectCapturedRunValue();
      return;
    }
    default:
      rejectCapturedRunValue();
      return;
  }
}

/**
 * Performs a stored AI trace's complete dynamic-trust pass before trace
 * replay touches the browser.
 *
 * Events precede verification in both storage and execution. Walking both
 * lists here keeps a later bad reference from allowing an earlier action to
 * run, while intentionally avoiding redundant zod validation of entries that
 * cannot survive `readUsableGrounding` with an invalid static shape.
 */
function preScanTrace(trace: z.infer<typeof TraceRecord>, context: TraceTrustContext, secretRefs: ReadonlySet<string>): void {
  /*
   * The first pass resolves every granted `fill-secret` reference in both trace
   * lists and retains its value in `context.resolvedSecrets`. Priming the full
   * registry makes subsequent field checks independent of journal order: a
   * literal that precedes its trace's fill-secret action is still rejected
   * before replay. Missing values and ungranted references retain their
   * classified failure behavior rather than becoming a permissive cache miss.
   * This priming deliberately happens before any per-entry origin check: the
   * page's pre-navigation origin cannot decide whether a later cross-origin
   * redirect is an allowed sink. `materializeTraceAction` performs the
   * per-entry check at actual replay time, immediately before that entry can
   * reach `fillSecret`.
   */
  const primeResolvedSecret = (entry: TraceAction | TraceAssert): void => {
    if (entry.type !== 'fill-secret') {
      return;
    }

    if (!secretRefs.has(entry.secretRef)) {
      throw new IntegrityViolationError('An AI trace references a secret that this step is not allowed to use.', {
        secretRef: entry.secretRef,
      });
    }

    if (context.skipSecretPriming) {
      return;
    }

    if (context.resolvedSecrets.has(entry.secretRef)) {
      return;
    }

    const value = context.secrets.resolve(entry.secretRef);
    if (value === undefined) {
      throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: entry.secretRef });
    }

    recordResolvedSecret(context.resolvedSecrets, entry.secretRef, value);
  };

  for (const entry of trace.events) {
    primeResolvedSecret(entry);
  }

  for (const assertion of trace.verification) {
    primeResolvedSecret(assertion);
  }

  for (const entry of trace.events) {
    preScanTraceEntry(entry, context);
  }

  for (const assertion of trace.verification) {
    preScanTraceEntry(assertion, context);
  }
}

/**
 * Completes the full safety scan and records only that trust transition.
 *
 * @param trace - Strict storage trace whose coverage presence is not yet trusted.
 * @param context - Current case authority used by the complete trace scan.
 * @param secretRefs - Secret references granted by the containing AI step.
 * @returns The same trace branded as fully pre-scanned, without changing its
 * coverage classification.
 * @remarks
 * Pre-scan validates static entries, secret grants, run references, navigation,
 * and materialized-secret exclusion. It cannot prove whether optional coverage
 * is absent or semantically valid. The instruction-coverage policy consumes
 * this branded value in a separate second stage and alone narrows it to
 * `SafeLegacyTraceRecord` or `CoveredTraceRecord`. No pre-scan caller may cast
 * a present-coverage trace to legacy evidence or expose it as provider
 * `priorTrace` before that classification.
 */
export function preScanTraceForInstructionCoverage(
  trace: TraceRecordWithCoverageStorage,
  context: TraceTrustContext,
  secretRefs: ReadonlySet<string>,
): PreScannedTraceRecord<TraceRecordWithCoverageStorage> {
  preScanTrace(trace, context, secretRefs);
  return trace as PreScannedTraceRecord<TraceRecordWithCoverageStorage>;
}

/**
 * Replays a trusted trace in journal order and returns whether the browser
 * confirmed every recorded observation.
 *
 * A false assertion is an expected behavioral miss. Ordinary browser
 * rejections, including compute-mode bind misses from trace materialization,
 * propagate so the caller can continue to the existing agentic fallback.
 * An unclassified rejection from invoking the current materialized
 * `fill-secret` operation, however, becomes a static `CaseAbort` at this
 * replay boundary. Invocation is the no-retry boundary because the browser
 * write may already have happened; AI re-drive could issue a second write
 * against a different target or origin. If that same invocation instead
 * throws a classified `IntegrityViolationError` or `SecretUnresolvedError`,
 * the classification takes precedence and its exact type propagates unchanged.
 * The rule is scoped to that operation: a successful secret fill does not
 * change how a later ordinary action rejection is handled. The abort neither
 * examines the browser's message nor retains the materialized value, and
 * placing this rule here leaves fresh agentic dispatch unchanged.
 * Cancellation is observed before every event and terminal verification, so
 * an abort raised by one browser operation prevents the next journal entry
 * from reaching materialization or the browser.
 */
export async function replayCoveredTraceWithoutAi(
  trace: CoveredTraceRecord,
  context: CoveredTraceReplayContext,
  secretRefs: ReadonlySet<string>,
): Promise<boolean> {
  for (const entry of trace.events) {
    context.signal?.throwIfAborted();
    if (entry.type === 'assert') {
      const outcome = await context.session.evaluateAssert(await materializeTraceAssert(entry, context));
      if (!outcome.passed) {
        return false;
      }
      continue;
    }

    const materialized = await materializeTraceAction(entry, context, secretRefs);
    if (materialized.type !== 'fill-secret') {
      await performMaterializedAction(materialized, context.session);
      continue;
    }

    try {
      await performMaterializedAction(materialized, context.session);
    } catch (error) {
      if (
        error instanceof IntegrityViolationError
        || error instanceof SecretUnresolvedError
        || error instanceof CaseAbort
      ) {
        throw error;
      }

      throw new CaseAbort('The replayed secret fill did not complete.');
    }
  }

  for (const assertion of trace.verification) {
    context.signal?.throwIfAborted();
    const outcome = await context.session.evaluateAssert(await materializeTraceAssert(assertion, context));
    if (!outcome.passed) {
      return false;
    }
  }

  return true;
}

type MaterializedValueCandidate = {
  readonly source: 'secret' | 'run';
  readonly value: string;
  readonly replacement: string;
};

/**
 * Determines whether a provider-controlled candidate retains a resolved
 * secret literal.
 *
 * A non-empty secret at or above the minimum safe length is forbidden
 * anywhere in the candidate. Non-empty shorter secrets remain protected
 * only when they comprise the entire candidate, avoiding broad false
 * positives from incidental short text. Empty values are excluded from both
 * modes because every string contains the empty string and it is not a
 * meaningful materialized credential.
 *
 * @param candidate - Provider-controlled text to examine before it can cross
 * a persistence or browser boundary.
 * @param resolvedSecrets - All non-empty values resolved so far, grouped by
 * their stable secret references.
 * @returns `true` when the candidate contains a long-enough resolved secret
 * or exactly equals any non-empty resolved secret.
 */
function containsResolvedSecret(
  candidate: string,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const values of resolvedSecrets.values()) {
    for (const value of values) {
      if (value === '') {
        continue;
      }

      if (candidate === value || (value.length >= MIN_SECRET_MATCH_LENGTH && candidate.includes(value))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Names trace-entry value paths whose fixed vocabulary is not case data.
 *
 * Every trace field is scanned unless it belongs to this closed
 * classification vocabulary. `target.role` is deliberately scanned because
 * it is a free-form ARIA role string that can contain a hand-edited secret.
 * `target.strategy`, `type`, `check`, and `key` are excluded as fixed
 * classification vocabulary, while `secretRef` is excluded as an authorized
 * reference identifier rather than a resolved value.
 *
 * Closed-vocabulary exclusion does not provide a compile-time exhaustiveness
 * tripwire for new trace fields. That trade is acceptable because an
 * unclassified field defaults to scanned, creating a false-positive risk
 * instead of silently leaking a secret.
 */
const TRACE_ENTRY_CLOSED_VOCABULARY_PATHS: ReadonlySet<string> = new Set([
  'type',
  'check',
  'target.strategy',
  'key',
  'secretRef',
]);

/**
 * Reports whether a validated trace entry contains a materialized resolved
 * secret.
 *
 * The JSON scan applies the closed-vocabulary exclusions and inspects values
 * only, so every non-excluded entry field is checked without treating field
 * names as case data.
 *
 * @param entry - Parsed trace action or assertion to inspect.
 * @param resolvedSecrets - Every secret value observed during the case.
 * @returns `true` when a scanned entry value contains a resolved secret.
 */
function traceEntryContainsResolvedSecret(
  entry: TraceAction | TraceAssert,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return jsonContainsResolvedSecret(entry, resolvedSecrets, {
    scanObjectKeys: false,
    excludePaths: TRACE_ENTRY_CLOSED_VOCABULARY_PATHS,
  });
}

/**
 * Reports whether a provider-visible trace field contains a current captured
 * value instead of its stable run reference.
 *
 * The scan uses the same closed-vocabulary exclusions as secret taint checks,
 * so locators and all other free-form strings remain protected while fixed
 * discriminants do not become false matches. Preflight placeholder values are
 * excluded because they are the required unresolved representation, not
 * captured application data.
 */
function traceEntryContainsCapturedRunValue(
  entry: TraceAction | TraceAssert,
  runState: ReadonlyMap<RunVariableName, string>,
): boolean {
  const capturedValues: string[] = [];
  for (const [name, value] of runState) {
    if (value !== '' && value !== `{{run.${name}}}`) capturedValues.push(value);
  }
  const visited = new WeakSet<object>();
  const inspect = (value: unknown, path: string): boolean => {
    if (typeof value === 'string') return capturedValues.some((captured) => value.includes(captured));
    if (value === null || typeof value !== 'object' || visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) {
      return value.some((item, index) => inspect(item, path === '' ? String(index) : `${path}.${index}`));
    }
    return Object.entries(value).some(([key, item]) => {
      const childPath = path === '' ? key : `${path}.${key}`;
      return !TRACE_ENTRY_CLOSED_VOCABULARY_PATHS.has(childPath) && inspect(item, childPath);
    });
  };
  return inspect(entry, '');
}

/**
 * Removes current captured values before reclassifying high-entropy fill text.
 *
 * Captured application data such as session tokens and generated identifiers
 * can legitimately satisfy the entropy heuristic when embedded in ordinary
 * case text. Removing only that known data lets the heuristic still reject
 * unrelated high-entropy residue without broadening the exemption to prefix
 * detectors. Values are removed longest-first so a shorter captured prefix
 * cannot fragment an overlapping longer value before it is matched.
 */
function stripCapturedRunValues(value: string, runState: ReadonlyMap<RunVariableName, string>): string {
  let residue = value;

  const capturedValues = [...runState.values()]
    .filter((captured) => captured !== '')
    .sort((left, right) => right.length - left.length);
  for (const captured of capturedValues) {
    residue = residue.split(captured).join('');
  }

  return residue;
}

/**
 * Rejects one credential-shaped literal supplied as a fill value.
 *
 * Prefix-shaped credentials remain unconditional because captured application
 * data cannot justify a credential prefix. A high-entropy value may instead be
 * wholly explained by captured case data, so only its remaining residue is
 * reclassified. Its diagnostic identifies the matching detector, never the
 * literal. Fill values need no secret-reference exemption because their schema
 * rejects every `{{secrets.` substring before either runtime boundary reaches
 * this guard.
 *
 * @param value - The single parsed fill value to classify.
 * @param runState - Values captured from the current case.
 * @throws {@link IntegrityViolationError} when a prefix detector matches or
 * high-entropy-token residue remains classified after captured values are removed.
 */
function assertNoCredentialShapedFillValue(value: string, runState: ReadonlyMap<RunVariableName, string>): void {
  const detector: SecretDetector | undefined = detectSecretLiteral(value);
  if (detector === undefined) {
    return;
  }

  if (detector !== 'high-entropy-token') {
    throw new IntegrityViolationError('An AI-supplied fill value resembles a credential literal.', { detector });
  }

  const residueDetector = detectSecretLiteral(stripCapturedRunValues(value, runState));
  if (residueDetector !== undefined) {
    throw new IntegrityViolationError('An AI-supplied fill value resembles a credential literal.', {
      detector: residueDetector,
    });
  }
}

/**
 * Rejects a provider literal that crosses back over the materialization
 * boundary instead of using its unresolved reference.
 *
 * Resolved secrets are more sensitive than captured run values because a
 * sufficiently long secret substring cannot remain in provider data without
 * risking irreversible persistence, while ordinary provider prose may
 * legitimately contain a captured value as a substring. The separate
 * fill-only credential heuristic avoids extending that classification to URLs,
 * assertions, and locator names. Resolved-secret rejection takes precedence
 * when one fill value violates both policies, preserving the more specific
 * materialization diagnosis.
 */
function assertNoMaterializedLiteral(
  entry: TraceAction | TraceAssert,
  context: DispatchContext,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  if (traceEntryContainsResolvedSecret(entry, resolvedSecrets)) {
    throw new IntegrityViolationError('The AI adapter supplied a materialized value instead of an unresolved reference.');
  }

  let runStateCandidate: string | undefined;

  switch (entry.type) {
    case 'navigate':
      runStateCandidate = entry.url;
      break;
    case 'fill':
      runStateCandidate = entry.value;
      assertNoCredentialShapedFillValue(entry.value, context.runState);
      break;
    case 'assert':
      switch (entry.check) {
        case 'text-visible':
        case 'text-equals':
          runStateCandidate = entry.text;
          break;
        case 'url-matches':
          runStateCandidate = entry.pattern;
          break;
        default:
          return;
      }
      break;
    default:
      return;
  }

  if ([...context.runState.values()].some((candidate) => candidate === runStateCandidate)) {
    throw new IntegrityViolationError('The AI adapter supplied a materialized value instead of an unresolved reference.');
  }
}

/**
 * Replaces materialized diagnostics with their stable references in one pass.
 *
 * The candidate set joins secrets and captures before scanning, rather than
 * applying separate redaction passes that could split an overlapping secret
 * into fragments. Every non-empty value observed for a secret reference
 * participates, so diagnostics remain safe if a provider rotates or
 * re-resolves a secret during one case. Longest-first selection preserves the
 * most specific value at each position; source and lexical tie-breaks make
 * diagnostics stable without ever rescanning replacement text.
 */
function templateMaterializedValues(
  message: string,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): string {
  const candidates: MaterializedValueCandidate[] = [];

  for (const [secretRef, values] of resolvedSecrets) {
    for (const value of values) {
      if (value !== '') {
        candidates.push({ source: 'secret', value, replacement: secretRef });
      }
    }
  }

  for (const [name, value] of runState) {
    if (value !== '') {
      candidates.push({ source: 'run', value, replacement: `{{run.${name}}}` });
    }
  }

  candidates.sort((left, right) => (
    right.value.length - left.value.length
    || (left.source === right.source ? 0 : left.source === 'secret' ? -1 : 1)
    || (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)
    || (left.replacement < right.replacement ? -1 : left.replacement > right.replacement ? 1 : 0)
  ));

  let rendered = '';
  let cursor = 0;
  while (cursor < message.length) {
    const candidate = candidates.find(({ value }) => message.startsWith(value, cursor));
    if (candidate === undefined) {
      rendered += message[cursor];
      cursor += 1;
      continue;
    }

    rendered += candidate.replacement;
    cursor += candidate.value.length;
  }

  return rendered;
}

const UNSUPPORTED_JSON_VALUE_PLACEHOLDER = '[unsupported-value-omitted]';
/*
 * A defensive backstop against accidental deep nesting, not a claim about a
 * specific adversarial threat.
 *
 * Redaction uses this depth ceiling because it replaces a subtree beyond
 * the limit with a placeholder, so no secret can leak through that subtree.
 * `jsonContainsResolvedSecret` deliberately does not share the ceiling: a
 * detector cannot leave any depth-bounded blind spot when its purpose is to
 * refuse persistence of a secret.
 */
const MAX_REDACTION_DEPTH = 20;

/**
 * Bounds total container visits while inspecting JSON-shaped input for
 * resolved secrets.
 *
 * This is a traversal budget rather than a depth ceiling, so it bounds
 * pathological wide shapes as well as deep ones without constraining ordinary
 * trees. Exceeding it fails closed because an incomplete detector result
 * cannot safely permit persistence.
 */
const MAX_JSON_SCAN_CONTAINERS = 1_000_000;

/**
 * Recursively redacts every string in a JSON-shaped value, including object
 * keys.
 *
 * Rebuilding only arrays and plain records keeps diagnostics structurally safe
 * without retaining a mutable reference to the input. Functions and objects
 * with a non-plain prototype can execute custom serialization or expose
 * implementation-specific state, so they are replaced instead of being
 * decomposed. A shared visited set makes a repeated object or array safe to
 * omit rather than following a cycle while case-error handling is already in
 * progress. A depth limit also omits accidentally deep diagnostics before
 * error handling can exhaust the stack.
 */
function redactJsonStrings(
  value: unknown,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
  visited: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return UNSUPPORTED_JSON_VALUE_PLACEHOLDER;
  }

  if (typeof value === 'string') {
    return templateMaterializedValues(value, resolvedSecrets, runState);
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return UNSUPPORTED_JSON_VALUE_PLACEHOLDER;
    }

    visited.add(value);
    return value.map((item) => redactJsonStrings(item, resolvedSecrets, runState, visited, depth + 1));
  }

  if (
    value !== null
    && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    if (visited.has(value)) {
      return UNSUPPORTED_JSON_VALUE_PLACEHOLDER;
    }

    visited.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        templateMaterializedValues(key, resolvedSecrets, runState),
        redactJsonStrings(item, resolvedSecrets, runState, visited, depth + 1),
      ]),
    );
  }

  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return UNSUPPORTED_JSON_VALUE_PLACEHOLDER;
}

/**
 * Reports whether a JSON-shaped value retains a resolved secret in a string
 * leaf and, by default, a plain-object key.
 *
 * This mirrors the redaction traversal instead of serializing and searching
 * text, because JSON escaping can conceal a raw literal from a serialized
 * scan. The detector uses an iterative explicit-stack walk, so valid nesting
 * depth does not create a blind spot. Its total container-visit budget bounds
 * both wide and deep pathological input: every array or plain record actually
 * entered increments the counter exactly once after deduplication, while an
 * already-visited alias or ancestor cycle is not entered and does not count.
 * An array or plain-record root is the first container visit. The scan returns
 * `true` when the count is strictly greater than
 * `MAX_JSON_SCAN_CONTAINERS`, because an incomplete detector result cannot
 * safely permit persistence. Arrays and plain records are traversed while
 * non-plain objects are structurally excluded, and the first secret match
 * ends the walk.
 *
 * A child whose entry-root-relative dotted path matches `excludePaths` is
 * never pushed onto the traversal stack, so its value and entire subtree are
 * pruned. Exclusion is independent of `scanObjectKeys`, which still controls
 * scanning the key that produced an excluded value. For callers that supply
 * `excludePaths`, a key containing a literal `.` is ambiguous with a nested
 * path; none of those callers can expose such a key.
 *
 * With `excludePaths`, cycle tracking is ancestor-scoped so an alias reached
 * through an excluded path cannot suppress a later unexcluded path. Without
 * it, whole-walk `WeakSet` deduplication avoids revisiting shared structures,
 * and the walk does not construct or compare path strings.
 *
 * @param value - Parsed JSON-shaped input inspected at a secret-safety
 * boundary, including persistence and trace-entry boundaries.
 * @param resolvedSecrets - Every secret value observed during the case.
 * @param options - Controls plain-object-key scanning and value-only path
 * exclusions. Key scanning defaults on for diagnostic and accessibility trees
 * because their keys cannot be assumed independent of provider-controlled
 * values. The grounding-persistence boundary disables it because
 * `GroundingDocument` entry keys are authored plan step identifiers, not
 * resolved runtime data. Trace-entry inspection also disables it because
 * trace field names are schema vocabulary, not case data.
 * @returns `true` when a supported string value or, unless disabled, object
 * key contains a resolved secret or the scan budget is exceeded.
 */
function jsonContainsResolvedSecret(
  value: unknown,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  options: { readonly scanObjectKeys?: boolean; readonly excludePaths?: ReadonlySet<string> } = {},
): boolean {
  const excludePaths = options.excludePaths;
  const scanObjectKeys = options.scanObjectKeys ?? true;
  let containerVisits = 0;

  if (excludePaths === undefined) {
    const visited = new WeakSet<object>();
    const stack: { readonly node: unknown }[] = [{ node: value }];

    while (stack.length > 0) {
      const { node } = stack.pop()!;
      if (typeof node === 'string') {
        if (containsResolvedSecret(node, resolvedSecrets)) {
          return true;
        }
        continue;
      }

      if (Array.isArray(node)) {
        if (visited.has(node)) {
          continue;
        }

        visited.add(node);
        containerVisits += 1;
        if (containerVisits > MAX_JSON_SCAN_CONTAINERS) {
          return true;
        }

        for (let index = node.length - 1; index >= 0; index -= 1) {
          if (index in node) {
            stack.push({ node: node[index] });
          }
        }
        continue;
      }

      if (
        node !== null
        && typeof node === 'object'
        && (Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null)
      ) {
        if (visited.has(node)) {
          continue;
        }

        visited.add(node);
        containerVisits += 1;
        if (containerVisits > MAX_JSON_SCAN_CONTAINERS) {
          return true;
        }

        const entries = Object.entries(node);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, item] = entries[index]!;
          if (scanObjectKeys && containsResolvedSecret(key, resolvedSecrets)) {
            return true;
          }
          stack.push({ node: item });
        }
      }
    }

    return false;
  }

  const ancestors = new WeakSet<object>();
  const stack: ({ readonly node: unknown; readonly path: string } | { readonly leave: object })[] = [
    { node: value, path: '' },
  ];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ('leave' in frame) {
      ancestors.delete(frame.leave);
      continue;
    }

    const { node, path } = frame;
    if (typeof node === 'string') {
      if (containsResolvedSecret(node, resolvedSecrets)) {
        return true;
      }
      continue;
    }

    if (Array.isArray(node)) {
      if (ancestors.has(node)) {
        continue;
      }

      ancestors.add(node);
      containerVisits += 1;
      if (containerVisits > MAX_JSON_SCAN_CONTAINERS) {
        return true;
      }

      stack.push({ leave: node });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        if (index in node) {
          const childPath = path === '' ? String(index) : `${path}.${index}`;
          if (!excludePaths.has(childPath)) {
            stack.push({ node: node[index], path: childPath });
          }
        }
      }
      continue;
    }

    if (
      node !== null
      && typeof node === 'object'
      && (Object.getPrototypeOf(node) === Object.prototype || Object.getPrototypeOf(node) === null)
    ) {
      if (ancestors.has(node)) {
        continue;
      }

      ancestors.add(node);
      containerVisits += 1;
      if (containerVisits > MAX_JSON_SCAN_CONTAINERS) {
        return true;
      }

      stack.push({ leave: node });
      const entries = Object.entries(node);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, item] = entries[index]!;
        if (scanObjectKeys && containsResolvedSecret(key, resolvedSecrets)) {
          return true;
        }

        const childPath = path === '' ? key : `${path}.${key}`;
        if (!excludePaths.has(childPath)) {
          stack.push({ node: item, path: childPath });
        }
      }
    }
  }

  return false;
}

/**
 * Rebuilds an error without retaining a materialized diagnostic.
 *
 * Classified errors retain their constructor so report policy continues to
 * recognize them. Their details are rebuilt with every string leaf and own
 * enumerable object key redacted at any nesting depth, so structured
 * diagnostics cannot retain a materialized value below their top level.
 *
 * A causal error is always omitted: it may be an arbitrary underlying error
 * object that cannot safely rely on structured redaction. This
 * shared reconstruction keeps browser-controller and case-report error
 * boundaries on the same redaction contract.
 */
function redactedError(
  error: unknown,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): Error {
  const message = templateMaterializedValues(
    error instanceof Error ? error.message : String(error),
    resolvedSecrets,
    runState,
  );

  if (error instanceof AmbercastError) {
    const ErrorConstructor = error.constructor as new (
      message: string,
      details?: Record<string, unknown>,
    ) => AmbercastError;
    if (error.details === undefined) {
      return new ErrorConstructor(message);
    }

    const details = redactJsonStrings(error.details, resolvedSecrets, runState) as Record<string, unknown>;
    return new ErrorConstructor(message, details);
  }

  return new Error(message);
}

/**
 * Applies the shared error-redaction contract at the browser-controller
 * boundary.
 *
 * Keeping this thin wrapper preserves the pipeline's boundary-specific name
 * while ensuring case-level reporting reuses exactly the same constructor-
 * preserving reconstruction and omission of the potentially unsafe causal
 * error chain.
 */
function scrubBrowserRejection(
  error: unknown,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): Error {
  return redactedError(error, resolvedSecrets, runState);
}

/**
 * Produces an assertion outcome safe to return to an AI adapter.
 *
 * Only browser diagnostics cross back to the adapter, so this is the sole
 * place reverse substitution is allowed. The unresolved journal remains
 * untouched, preserving the stronger rule that resolved values never enter
 * grounding or other replay artifacts. The registry includes every observed
 * non-empty value for each reference so a later provider interaction cannot
 * surface an earlier resolution.
 */
function templateAssertOutcome(
  outcome: AssertOutcome,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): AssertOutcome {
  if (outcome.message === undefined) {
    return outcome;
  }

  const message = templateMaterializedValues(outcome.message, resolvedSecrets, runState);
  return outcome.passed ? { passed: true, message } : { passed: false, message };
}

type LastAgenticObservation = 'none' | 'perform' | 'snapshot' | 'failed-assert' | 'passed-assert';

/**
 * Nonserializable journal metadata for one evaluated assertion.
 *
 * @remarks
 * The optional criterion tag accompanies the observation in memory and never
 * becomes part of {@link TraceAssert}. Passing assertions extend the trailing
 * terminal run with their tags; an action, snapshot, or failed assertion
 * resets that run. Finalization accepts new grounding only when every trailing
 * assertion has exactly one success ID and the resulting map is an exact
 * step-local bijection. It constructs events, verification, and coverage as
 * one candidate and performs no write if any part is invalid.
 */
export interface AgenticJournalAssertionObservation {
  /** Unresolved assertion that remains safe to serialize after validation. */
  readonly assertion: TraceAssert;

  /** Step-local success criterion supplied separately by the controller call. */
  readonly criterionId?: import('#core/ir/schema.js').InstructionCriterionId;
}

/**
 * Observable finalization decisions before any grounding mutation occurs.
 *
 * @remarks
 * A covered candidate is built and validated atomically from the journal's
 * events, trailing assertions, and criterion tags; any mismatch yields abort
 * without a write. A nominal success whose last observation is a snapshot or
 * failed assertion passes without new grounding. A cold pass performs no
 * write. A fallback pass deletes only the stale entry that led to fallback
 * before returning passed. Abort and rejection preserve any existing entry.
 * Keeping these outcomes separate prevents coverage enforcement from turning
 * negative terminal sensing into a failed case or replayable evidence.
 */
export type AgenticInstructionCoverageFinalization =
  | { readonly kind: 'covered-trace-candidate' }
  | { readonly kind: 'pass-without-grounding-cold-no-write' }
  | { readonly kind: 'pass-without-grounding-fallback-delete-stale-entry' }
  | { readonly kind: 'abort-preserve-existing-entry' };

/**
 * Wraps one live browser session for exactly one agentic execution.
 *
 * The wrapper is the authority that both materializes provider instructions
 * and decides whether a nominal agentic success has sufficient terminal
 * evidence to become replayable grounding. It records only successful actions
 * and passing assertions in unresolved form, while a separate raw-observation
 * counter prevents unjournaled sensing from being mistaken for adjacent final
 * verification.
 */
class AgenticRunPipeline implements InstructionCoverageAiActionController {
  readonly #journal: Array<TraceAction | TraceAssert> = [];
  readonly #passedAssertionTags: Array<import('#core/ir/schema.js').InstructionCriterionId | undefined> = [];
  readonly #secretRefs: ReadonlySet<string>;
  #trailingPassedAssertRun = 0;
  #lastObservation: LastAgenticObservation = 'none';

  constructor(
    private readonly context: DispatchContext,
    secretRefs: readonly string[],
    private readonly step: Extract<Step, { kind: 'ai' }>,
    private readonly fallbackFromReplay: boolean,
  ) {
    this.#secretRefs = new Set(secretRefs);
  }

  /**
   * Materializes and performs one provider-supplied action before recording it.
   *
   * External adapters can bypass TypeScript types, so zod validation happens
   * before materialization and a successful browser call is the only event
   * that enters the journal. A perform always breaks terminal verification,
   * even when the call later rejects and aborts the entire agentic execution.
   *
   * Its compute-mode bind is deliberately awaited inside the same rejection
   * boundary as the browser call. Unlike trace replay, fresh agentic control
   * has no fallback below this method: a bind miss is redacted and returned to
   * the AI executor as an ordinary browser rejection rather than being
   * reinterpreted as a reason to start another control path.
   */
  async perform(action: TraceAction): Promise<void> {
    const parsed = TraceAction.safeParse(action);
    if (!parsed.success) {
      throw new IntegrityViolationError('The AI adapter supplied an invalid browser action.', {
        issues: parsed.error.issues,
      });
    }

    this.#trailingPassedAssertRun = 0;
    this.#lastObservation = 'perform';
    assertNoMaterializedLiteral(parsed.data, this.context, this.context.resolvedSecrets);
    try {
      const materialized = await materializeTraceAction(
        parsed.data,
        this.context,
        this.#secretRefs,
      );
      await performMaterializedAction(materialized, this.context.session);
    } catch (error) {
      throw scrubBrowserRejection(error, this.context.resolvedSecrets, this.context.runState);
    }
    this.#journal.push(parsed.data);
  }

  /**
   * Materializes and evaluates one provider-supplied assertion observation.
   *
   * A passing observation is journaled and extends the final verification run;
   * every other assertion outcome breaks it. Its diagnostic is redacted only
   * in the value returned to the adapter, never in the unresolved record.
   *
   * A target-scoped compute-mode bind shares the evaluation's rejection
   * boundary. Therefore a bind miss receives the same redaction and terminal
   * agentic-failure treatment as an assertion browser rejection; it does not
   * trigger the trace-replay fallback, which applies only before live agentic
   * execution begins.
   */
  async evaluateAssert(
    check: TraceAssert,
    criterionId?: import('#core/ir/schema.js').InstructionCriterionId,
  ): Promise<AssertOutcome> {
    const parsed = TraceAssert.safeParse(check);
    if (!parsed.success) {
      throw new IntegrityViolationError('The AI adapter supplied an invalid assertion observation.', {
        issues: parsed.error.issues,
      });
    }

    assertNoMaterializedLiteral(parsed.data, this.context, this.context.resolvedSecrets);
    let outcome: AssertOutcome;
    try {
      const materialized = await materializeTraceAssert(parsed.data, this.context);
      outcome = await this.context.session.evaluateAssert(materialized);
    } catch (error) {
      throw scrubBrowserRejection(error, this.context.resolvedSecrets, this.context.runState);
    }
    if (outcome.passed) {
      this.#trailingPassedAssertRun += 1;
      this.#lastObservation = 'passed-assert';
      this.#journal.push(parsed.data);
      this.#passedAssertionTags.push(criterionId);
    } else {
      this.#trailingPassedAssertRun = 0;
      this.#lastObservation = 'failed-assert';
    }

    return templateAssertOutcome(outcome, this.context.resolvedSecrets, this.context.runState);
  }

  /**
   * Captures current browser evidence without making it replayable history.
   *
   * Snapshotting is still an observation for terminal-verification purposes:
   * an agent cannot inspect new page evidence after a passing assertion and
   * then claim that the earlier assertion was its final proof of success.
   *
   * AI-bound snapshots never carry screenshot bytes because pixel content
   * cannot be reliably masked by substring matching; this policy governs
   * `InstructionCoverageAiActionController`-facing snapshot construction only.
   * The accessibility
   * tree preserves the parser-produced JSON structure while redacting resolved
   * values from its string values and object keys before they cross into the
   * AI adapter.
   */
  async snapshotForResolution() {
    this.#trailingPassedAssertRun = 0;
    this.#lastObservation = 'snapshot';
    const raw = await this.context.session.snapshotForResolution();
    return {
      accessibilityTree: redactJsonStrings(
        raw.accessibilityTree,
        this.context.resolvedSecrets,
        this.context.runState,
      ) as JsonValueT,
    };
  }

  /**
   * Classifies a resolved agentic result and applies its complete grounding
   * mutation, if any.
   *
   * A failure outcome discards the journal through the unified case-abort
   * result, while a rejected execution never reaches this method. A successful
   * result persists a trace only with terminal passing assertions; a snapshot
   * or failed assertion completes terminal negative sensing without a record.
   * A bare action or no observation produces the unified case-abort result.
   */
  finalize(outcome: 'success' | 'failure'): DispatchOutcome {
    if (outcome === 'failure') {
      throw new CaseAbort('The AI-directed interaction did not complete successfully.');
    }

    if (this.#trailingPassedAssertRun >= 1) {
      const splitAt = this.#journal.length - this.#trailingPassedAssertRun;
      const events = this.#journal.slice(0, splitAt);
      const verification = this.#journal.slice(splitAt).map((entry) => {
        if (entry.type !== 'assert') {
          throw new IntegrityViolationError('The AI verification journal is internally inconsistent.');
        }
        return entry;
      });
      const criteria = this.context.instructionCoverageByStepId.get(this.step.id) ?? [];
      const successIds = new Set(criteria.filter(({ kind }) => kind === 'success').map(({ id }) => id));
      const terminalTags = this.#passedAssertionTags.slice(-this.#trailingPassedAssertRun);
      const verificationCoverage = Object.create(null) as Record<string, number>;
      let validTags = terminalTags.length === verification.length;
      for (const [index, criterionId] of terminalTags.entries()) {
        if (criterionId === undefined || !successIds.has(criterionId)
          || Object.hasOwn(verificationCoverage, criterionId)) {
          validTags = false;
          continue;
        }
        verificationCoverage[criterionId] = index;
      }
      if (!validTags || Object.keys(verificationCoverage).length !== successIds.size) {
        throw new AgenticCoverageAbort('The AI-directed interaction did not provide exact terminal criterion coverage.');
      }
      const parsed = TraceRecord.safeParse({ events, verification, verificationCoverage });
      if (!parsed.success) {
        throw new IntegrityViolationError('The AI verification journal is internally inconsistent.', {
          issues: parsed.error.issues,
        });
      }

      const preScanned = preScanTraceForInstructionCoverage(
        parsed.data,
        {
          ...this.context,
          resolvedSecrets: new Map(),
          skipSecretPriming: true,
        },
        this.#secretRefs,
      );
      const classified = classifyPreScannedTraceCoverage({
        trace: preScanned,
        criteria,
        runValues: { values: this.context.runState },
      });
      if (!classified.success || classified.data.kind !== 'covered') {
        throw new AgenticCoverageAbort('The AI-directed interaction produced invalid terminal verification proof.');
      }
      this.context.updateGroundingEntry(this.step.id, { kind: 'ai', trace: classified.data.trace });
      return { kind: 'passed', via: 'ai-resolve' };
    }

    if (this.#lastObservation === 'snapshot' || this.#lastObservation === 'failed-assert') {
      if (this.fallbackFromReplay) {
        this.context.deleteGroundingEntry(this.step.id);
      }
      return { kind: 'passed', via: 'ai-resolve' };
    }

    throw new CaseAbort('The AI-directed interaction completed without terminal verification evidence.');
  }
}

/**
 * Performs one lazy agentic fallback and lets its fresh wrapper classify the
 * resulting journal.
 *
 * A case resolves its executor only when this function is entered, preserving
 * pure cache-hit replay on machines without an installed provider. Each call
 * gets an independent controller and journal so a rejected interaction cannot
 * leak partial observations into a later retry or another plan step.
 */
async function executeAgentic(
  step: Extract<Step, { kind: 'ai' }>,
  context: DispatchContext,
  priorTrace: import('#ports/ai.js').SafeLegacyTraceRecord | undefined,
  fallbackFromReplay: boolean,
): Promise<DispatchOutcome> {
  const secretRefs = step.secrets?.map((grant) => grant.ref) ?? [];
  const executor = await context.resolveAiExecutor();
  const pipeline = new AgenticRunPipeline(context, secretRefs, step, fallbackFromReplay);
  context.events.emit({ type: 'ai-call', stepId: step.id });
  const result = await callAiExecutor(context, (signal) => executor.executeAgentic({
    instructionPrompt: step.instruction,
    allowedSecretRefs: secretRefs,
    allowedRunRefs: [...context.allowedRunRefs],
    trustedInstructionCoverage: context.instructionCoverageByStepId.get(step.id) ?? [],
    controller: pipeline,
    ...(priorTrace === undefined ? {} : { priorTrace }),
    signal,
  }));

  return pipeline.finalize(result.outcome);
}

/**
 * Executes an AI step through a pre-scan-first coverage trust boundary.
 *
 * The pre-scan is an integrity gate rather than a hint: an entry whose grants
 * no longer fit this case is never partially replayed and never handed back to
 * an AI provider. Completing that scan produces only a branded pre-scanned
 * trace. A separate policy stage proves coverage absence before narrowing safe
 * legacy provider context, or proves present coverage before narrowing a local
 * replay candidate. Present-invalid coverage fails before browser, AI, or
 * cache-only classification. A covered-valid trace replays without resolving
 * an AI executor. `cacheOnly` suppresses both cold-start and recoverable miss
 * calls but cannot downgrade integrity failure into an ordinary miss.
 */
async function executeAiStep(
  step: Extract<Step, { kind: 'ai' }>,
  context: DispatchContext,
  cacheOnly: boolean,
): Promise<DispatchOutcome> {
  const entry = context.grounding.entries[step.id];
  const secretRefs = new Set(step.secrets?.map((grant) => grant.ref) ?? []);
  if (entry?.kind !== 'ai') {
    if (cacheOnly) {
      throw new CaseAbort('AI-directed replay has no usable trace while cache-only mode is enabled.');
    }

    return executeAgentic(step, context, undefined, false);
  }

  const preScanned = preScanTraceForInstructionCoverage(
    entry.trace,
    { ...context, rejectCapturedRunLiterals: !Object.hasOwn(entry.trace, 'verificationCoverage') },
    secretRefs,
  );
  const classified = classifyPreScannedTraceCoverage({
    trace: preScanned,
    criteria: context.instructionCoverageByStepId.get(step.id) ?? [],
    runValues: { values: context.runState },
  });
  if (!classified.success) {
    throw new IntegrityViolationError('The grounding trace contains invalid instruction coverage or verification proof.', {
      issues: classified.issues,
    });
  }
  if (classified.data.kind === 'legacy-cache-miss') {
    if (cacheOnly) {
      throw new CaseAbort('AI-directed replay has no covered trace while cache-only mode is enabled.');
    }
    return executeAgentic(step, context, classified.data.priorTrace, true);
  }
  try {
    const replayContext: CoveredTraceReplayContext = {
      session: context.session,
      target: context.target,
      runState: context.runState,
      secrets: context.secrets,
      resolvedSecrets: context.resolvedSecrets,
      allowedRunRefs: context.allowedRunRefs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    if (await replayCoveredTraceWithoutAi(classified.data.trace, replayContext, secretRefs)) {
      return { kind: 'passed', via: 'trace-replay' };
    }
  } catch (error) {
    if (error instanceof IntegrityViolationError || error instanceof SecretUnresolvedError || error instanceof CaseAbort) {
      throw error;
    }
  }

  context.signal?.throwIfAborted();

  if (cacheOnly) {
    throw new CaseAbort('AI trace replay missed while cache-only mode is enabled.');
  }

  return executeAgentic(step, context, undefined, true);
}

/**
 * Re-resolves an element grounding miss through a structured AI confirmation
 * request when the caller has allowed fallback.
 *
 * Local classification before an AI call fails fast when the page offers no
 * safe candidate and supplies evidence for a focused confirmation request.
 * The AI sees only redacted evidence, so its confirmation cannot expose a
 * resolved secret.
 *
 * A post-confirmation bind uses verify mode, not compute mode, to retain
 * continuity with the AI-confirmed candidate. A compute bind could accept a
 * different unique element that appeared during the AI round trip; verify
 * mode detects that change against a fresh observation before producing the
 * operation-ready handle.
 *
 * Grounding changes only after a successful binding. Any miss, denial, or
 * unavailable candidate leaves the existing grounding untouched, preventing
 * failed recovery from replacing known evidence with unconfirmed data.
 */
async function groundedTarget(
  context: DispatchContext,
  step: ActionStep | AssertStep | CaptureStep,
  target: ElementRef,
): Promise<BoundElement> {
  const entry = context.grounding.entries[step.id];
  if (entry?.kind === 'element') {
    const resolved = await context.session.resolveGrounded(target, {
      mode: 'verify',
      fingerprint: entry.fingerprint,
    });
    if (resolved.kind === 'hit') {
      return resolved.element;
    }
  }

  if (context.cacheOnly) {
    throw new CaseAbort('Element grounding is unavailable while cache-only mode is enabled.');
  }

  const snapshot = await context.session.snapshotForResolution();
  const classification = computeAccessibilityFingerprint(
    snapshot.accessibilityTree,
    target,
    context.resolvedSecrets.values(),
  );
  switch (classification.kind) {
    case 'no-match':
      throw groundingAbort('element-not-found');
    case 'ambiguous-match':
      throw groundingAbort('ambiguous-match');
    case 'snapshot-invalid':
      throw groundingAbort('snapshot-invalid');
    case 'secret-contaminated':
      throw groundingAbort('secret-contaminated');
    case 'ok':
      break;
  }

  const executor = await context.resolveAiExecutor();
  context.events.emit({ type: 'ai-call', stepId: step.id });
  const response = await callAiExecutor(context, (signal) => executor.execute({
    prompt: 'Confirm whether the supplied locator still identifies the intended element.',
    responseSchema: CONFIRMATION_RESPONSE_SCHEMA,
    context: {
      target,
      snapshot: {
        accessibilityTree: redactJsonStrings(
          snapshot.accessibilityTree,
          context.resolvedSecrets,
          context.runState,
        ) as JsonValueT,
      },
    },
    signal,
  }));
  if (!response.data.confirmed) {
    throw new CaseAbort('The AI could not confirm that the supplied locator identifies the intended element.');
  }

  const resolved = await context.session.resolveGrounded(target, {
    mode: 'verify',
    fingerprint: classification.fingerprint,
  });
  if (resolved.kind === 'miss') {
    throw groundingAbort(resolved.reason);
  }

  context.updateGroundingEntry(step.id, { kind: 'element', fingerprint: resolved.element.fingerprint });
  context.resolvedVias.set(step.id, 'ai-resolve');
  return resolved.element;
}

function groundingAbort(reason: GroundingMissReason): CaseAbort {
  switch (reason) {
    case 'fingerprint-mismatch':
      return new CaseAbort('The supplied locator changed shape after AI confirmation and cannot be safely bound.');
    case 'element-not-found':
      return new CaseAbort('The supplied locator has no matching element in the current accessibility evidence.');
    case 'ambiguous-match':
      return new CaseAbort(
        'The supplied locator matches more than one element in the current accessibility evidence. Add a distinguishing aria-label (or other accessible-name difference) to one of the matching elements so the locator can identify a single element.',
      );
    case 'snapshot-invalid':
      return new CaseAbort(
        'The current accessibility evidence could not be parsed and cannot be trusted for this locator. Retry the run; if this persists, the page structure may use a form this parser does not recognize.',
      );
    case 'secret-contaminated':
      return new CaseAbort(
        'The supplied locator\'s accessibility evidence contains a resolved secret value and cannot be fingerprinted or cached. Add an aria-label that does not echo the secret value to the affected element.',
      );
  }
}

/**
 * Materializes and performs one deterministic action through the live session.
 *
 * Element actions resolve trusted grounding immediately before browser use.
 * A `fill-secret` applies its sink-origin gate before resolving its value,
 * then retains that value for later diagnostic redaction before grounding can
 * reject a descriptor contaminated by the secret. This keeps plans and
 * grounding reference-only while preserving the values required to sanitize a
 * subsequent failure.
 */
async function executeAction(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'action') {
    throw new Error('The action dispatcher received a non-action step.');
  }

  let action: MaterializedAction;
  switch (step.action) {
    case 'click':
      action = { type: 'click', target: await groundedTarget(context, step, step.target) };
      break;
    case 'navigate':
      action = { type: 'navigate', url: step.url };
      break;
    case 'press':
      action = {
        type: 'press',
        target: await groundedTarget(context, step, step.target),
        key: step.key,
      };
      break;
    case 'fill':
      action = {
        type: 'fill',
        target: await groundedTarget(context, step, step.target),
        value: step.value,
      };
      break;
    case 'fill-secret': {
      const policy = await assertAllowedSecretSinkOrigin(context, step.secretRef);
      const value = context.secrets.resolve(step.secretRef);
      if (value === undefined) {
        throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: step.secretRef });
      }

      recordResolvedSecret(context.resolvedSecrets, step.secretRef, value);
      const target = await groundedTarget(context, step, step.target);
      action = { type: 'fill-secret', target, value, policy };
      break;
    }
  }

  await performMaterializedAction(action, context.session);
  return { kind: 'passed' };
}

/**
 * Executes one deterministic assertion and preserves its materialized
 * expectation when the browser reports a mismatch.
 *
 * The expected description is created from the browser-facing check rather
 * than the authored plan step, so a failure explains the value the browser
 * actually evaluated after run-value materialization.
 */
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
        target: await groundedTarget(context, step, step.target),
      };
      break;
    case 'text-equals':
      check = {
        check: 'text-equals',
        target: await groundedTarget(context, step, step.target),
        text: step.text,
      };
      break;
    case 'url-matches':
      check = { check: 'url-matches', pattern: step.pattern };
      break;
    case 'element-count':
      check = {
        check: 'element-count',
        target: step.target,
        count: step.count,
      };
      break;
  }

  const outcome = await context.session.evaluateAssert(check);
  return outcome.passed
    ? { kind: 'passed' }
    : { kind: 'assertion-failed', expected: expectedForAssert(check), actual: outcome.message };
}

/**
 * Describes the browser check that a failed assertion expected to hold.
 *
 * Each assertion variant has a deliberately fixed English sentence so report
 * consumers receive stable, actionable evidence without reconstructing a
 * check from its internal discriminant and locator structure.
 */
function expectedForAssert(check: AssertCheck): string {
  switch (check.check) {
    case 'text-visible':
      return `Text "${check.text}" is visible.`;
    case 'element-visible':
      return `Element ${check.target.ref.role} "${check.target.ref.name}" is visible.`;
    case 'text-equals':
      return `Element ${check.target.ref.role} "${check.target.ref.name}" has text "${check.text}".`;
    case 'url-matches':
      return `URL matches "${check.pattern}".`;
    case 'element-count':
      return `Element ${check.target.role} "${check.target.name}" has count ${check.count}.`;
  }
}

/**
 * Captures an allowed run value for later materialization in the same case.
 *
 * Captures use the text mode deliberately: this state becomes both a trusted
 * input to later plan steps and a redaction candidate for diagnostics, so it
 * is recorded only after grounding identifies the intended live element.
 */
async function executeCapture(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'capture') {
    throw new Error('The capture dispatcher received a non-capture step.');
  }

  const target = await groundedTarget(context, step, step.target);
  const value = await context.session.captureValue(target, 'text');
  context.runState.set(step.variable, value);
  return { kind: 'passed' };
}

/**
 * Captures and persists a screenshot for a failed live browser step.
 *
 * This helper runs only after the failure coordinator has established that
 * the step's raw text evidence contains no resolved secret. Keeping the
 * screenshot decision there makes the security guard auditable in one place,
 * while this helper owns the independent best-effort browser and storage
 * boundary. Evidence failures must never replace the failure being diagnosed,
 * and layout has already established the destination's containment.
 */
async function captureScreenshotEvidence(
  session: BrowserSession,
  storage: StorageAdapter,
  evidenceDir: string,
  stepId: Step['id'],
): Promise<Pick<FailureDetail, 'screenshot'>> {
  try {
    const path = joinPath(evidenceDir, `${stepId}.png`);
    await storage.writeBinary(path, await session.screenshot());
    return { screenshot: path };
  } catch {
    return {};
  }
}

/**
 * Captures redacted accessibility evidence for a failed live browser step.
 *
 * Accessibility capture supports separate detection and persistence decisions.
 * `accessibilityCaptureContainsResolvedSecret` uses all three capture channels
 * to decide whether a screenshot is unsafe to retain, while `Observed` keeps
 * only the redacted parsed tree. Redaction must precede serialization because
 * JSON escaping can hide a raw value from string-based replacement. Snapshot
 * acquisition must fail closed after any case secret resolves: an
 * uninspectable page can still display a value filled by an earlier step. Once
 * a capture exists, detector failure is likewise unsafe and returns a true
 * signal: a throwing getter or other malformed evidence must not turn
 * uncertain secret presence into permission to capture a screenshot.
 * Rendering is separately best-effort and retains the already-established
 * signal.
 */
async function captureObservedEvidence(
  session: BrowserSession,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): Promise<{ readonly observed?: Observed; readonly captureContainsResolvedSecret: boolean }> {
  let capture: AccessibilityCapture;
  try {
    capture = await session.accessibilitySnapshot();
  } catch {
    // An uninspectable page cannot authorize a screenshot once this case knows a secret exists.
    return { captureContainsResolvedSecret: resolvedSecrets.size > 0 };
  }

  let captureContainsResolvedSecret: boolean;
  try {
    captureContainsResolvedSecret = accessibilityCaptureContainsResolvedSecret(capture, resolvedSecrets);
  } catch {
    return { captureContainsResolvedSecret: true };
  }

  try {
    return {
      captureContainsResolvedSecret,
      observed: {
        note: OBSERVED_NOTE,
        accessibilitySnapshot: JSON.stringify(redactJsonStrings(capture.tree, resolvedSecrets, runState)),
      },
    };
  } catch {
    return { captureContainsResolvedSecret };
  }
}

/**
 * Decides whether one accessibility capture contains a resolved secret before
 * a screenshot may be retained.
 *
 * @remarks
 * The detector combines raw renderer output, the identity-bearing tree, and
 * decoded discarded scalars. It reuses the established string and JSON
 * traversal rules instead of an exact-only tree comparator. Those rules
 * protect longer substrings and short exact values. An invalid
 * tree with a resolved secret is unsafe independently of the other channels:
 * failed identity parsing cannot establish that the page is safe to capture.
 *
 * Canvas/image/CSS-rendered pixel content and the scan-vs-screenshot timing
 * gap remain undetectable.
 */
function accessibilityCaptureContainsResolvedSecret(
  capture: AccessibilityCapture,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (isSnapshotInvalid(capture.tree) && resolvedSecrets.size > 0) {
    return true;
  }

  return containsResolvedSecret(capture.rawYaml, resolvedSecrets)
    || jsonContainsResolvedSecret(capture.tree, resolvedSecrets)
    || capture.scalarValues.some((value) => containsResolvedSecret(value, resolvedSecrets));
}

/**
 * Coordinates failure evidence while keeping screenshot capture from writing
 * a known secret disclosure to disk.
 *
 * Accessibility capture precedes the screenshot decision so known secrets
 * gate pixel persistence before it can occur. Persisted observed evidence is
 * the redacted parsed tree, while detection-only capture channels never cross
 * that boundary. Diagnostic failures remain independent, so losing one form
 * of evidence does not discard other available failure detail or invent
 * assertion-specific fields.
 */
async function captureFailureEvidence(
  session: BrowserSession,
  storage: StorageAdapter,
  evidenceDir: string,
  stepId: Step['id'],
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
  rawAssertionText: readonly string[] = [],
): Promise<FailureDetail> {
  const { observed, captureContainsResolvedSecret } = await captureObservedEvidence(session, resolvedSecrets, runState);
  if (captureContainsResolvedSecret || rawAssertionText.some((text) => containsResolvedSecret(text, resolvedSecrets))) {
    return { ...(observed === undefined ? {} : { observed }), screenshotOmitted: 'secret-detected' };
  }

  return {
    ...(observed === undefined ? {} : { observed }),
    ...await captureScreenshotEvidence(session, storage, evidenceDir, stepId),
  };
}

const DISPATCH_TABLE = {
  action: executeAction,
  assert: executeAssert,
  capture: executeCapture,
} satisfies Record<Exclude<Step['kind'], 'ai'>, StepExecutor>;

/**
 * Creates the report representation of one executed or skipped plan step.
 *
 * Failure evidence is an object rather than additional positional arguments
 * so the assertion-specific and environment-specific paths can share one
 * stable constructor while omitting diagnostics unavailable to either path.
 * It is copied only to the currently failing step; skipped and pre-launch
 * steps never acquire diagnostic fields they did not produce.
 */
function stepResult(
  step: Step,
  status: StepResult['status'],
  kind?: StepResult['kind'],
  detail?: FailureDetail,
): StepResult {
  const presentDetail = Object.fromEntries(
    Object.entries(detail ?? {}).filter(([, value]) => value !== undefined),
  ) as FailureDetail;
  return {
    id: step.id,
    type: step.kind,
    status,
    ...(kind === undefined ? {} : { kind }),
    ...presentDetail,
  };
}

function skippedSteps(steps: readonly Step[], after: number): StepResult[] {
  return steps.slice(after + 1).map((step) => stepResult(step, 'skipped'));
}

/**
 * Builds the stable partial result for an error that interrupts case dispatch.
 *
 * The current step receives environment evidence only when it exists, while
 * a pre-launch failure retains no synthetic step. This preserves the report's
 * distinction between a live-session dispatch failure and work that never
 * reached the browser. Its identity is deliberately restricted to
 * {@link ExecutedRunResult}, because only an interrupted replay can produce
 * the partial step evidence this helper assembles.
 */
function resultForAbort(
  identity: Pick<ExecutedRunResult, 'id' | 'file' | 'planFile'>,
  steps: readonly Step[],
  completed: readonly StepResult[],
  currentStep: Step | undefined,
  explanation: string,
  detail?: FailureDetail,
): ResultWithoutDuration {
  const currentIndex = currentStep === undefined ? -1 : steps.indexOf(currentStep);
  return {
    ...identity,
    status: 'error',
    steps: currentStep === undefined
      ? [...completed]
      : [...completed, stepResult(currentStep, 'error', 'environment', detail), ...skippedSteps(steps, currentIndex)],
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
 * Declares replay selection, reporting, and AI-fallback policy for one run batch.
 *
 * @remarks
 * A caller may give literal prompt paths or let the use case ask the injected
 * discovery seam for them. The shared core target policy is batch-wide because
 * its one selected definition participates in the plan's input digest and is
 * the only definition allowed to choose browser behavior. Selecting a
 * different configured target must fail as stale rather than replaying a plan
 * against a silently different browser target. Empty-selection acceptance
 * remains report policy, while list mode is the sole selection policy that
 * prevents case execution.
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

  /** Optional explicit target name; an invalid name never falls back. */
  readonly target?: string;

  /** Whether grounding misses and trace misses must fail without an AI fallback. */
  readonly cacheOnly: boolean;

  /**
   * Lets reporting accept an empty resolved selection without changing replay.
   *
   * The use case carries this command policy unchanged so the report boundary
   * can choose exit status; only discovery and list selection belong here.
   */
  readonly allowEmpty: boolean;

  /**
   * Reports the resolved file selection without starting any case execution.
   *
   * The short-circuit runs after grep filtering and first-seen deduplication,
   * preserving the exact selection a normal replay would schedule while
   * avoiding browser, artifact, event, and AI-fallback work.
   */
  readonly list: boolean;

  /** Parsed stale-artifact policy; regeneration is rejected before replay begins. */
  readonly stale: 'fail' | 'regenerate';
}

/**
 * Lazy resolver contract for criterion-aware live AI fallback.
 *
 * @remarks
 * The criterion-aware run contract uses this resolver in place of the base
 * `RunDeps.resolveAiExecutor` shape at the same lazy boundary. Covered replay
 * therefore never probes a provider. Request construction and journal tag
 * storage remain separate pipeline contracts and are not performed by the
 * resolver.
 */
export type InstructionCoveredAiExecutorResolver = (
  signal?: AbortSignal,
) => Promise<InstructionCoveredAiExecutor>;

/**
 * Dependencies at the deterministic replay boundary.
 *
 * @remarks
 * A fully grounded replay must run on a machine without an AI provider, so
 * AI resolution remains lazy and is reached only by an allowed grounding or
 * trace fallback. Storage, target configuration, and browser launch are kept
 * separate so plan trust can be established before a browser process exists.
 */
export interface RunDeps {
  /** Reads the source prompt and generated plan/grounding artifacts. */
  readonly storage: StorageAdapter;

  /** Derives committed companions and invocation-scoped evidence paths. */
  readonly layout: LayoutResolver;

  /** Monotonic time source used to measure each case's duration. */
  readonly clock: Clock;

  /**
   * Collision-resistant identity assigned to this command invocation.
   *
   * It belongs with cancellation and events as invocation-scoped context,
   * rather than with reusable services or batch replay policy, because every
   * case uses it unchanged to place evidence beneath the same report
   * directory. Runtime supplies a timestamp-plus-UUID value that satisfies
   * the layout resolver's single-segment grammar; this use case neither
   * creates nor rewrites that identity.
   */
  readonly runId: string;

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
   * Lazily resolves the executor used only by an allowed per-case fallback.
   *
   * `runCase` memoizes this resolver after the first actual fallback, so AI
   * re-resolution and fresh agentic execution in the same case share one
   * executor without probing a provider for cache-only or complete-cache
   * replay. The instruction-coverage boundary narrows this field to
   * {@link InstructionCoveredAiExecutorResolver} without changing that lazy
   * transition point.
   */
  readonly resolveAiExecutor: InstructionCoveredAiExecutorResolver;

  /**
   * Receives successful step and real AI-call lifecycle events without affecting replay.
   *
   * Result events identify deterministic grounding, AI element resolution, or
   * successful trace replay. Each actual executor invocation emits one
   * `ai-call` event, while cache hits and cache-only aborts emit none.
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

  /** The configuration subset used for discovery, target/digest resolution, and per-call AI timeout policy. */
  readonly config: Pick<
    ResolvedConfig,
    'testDir' | 'testMatch' | 'testIgnore' | 'targets' | 'defaultTarget' | 'ai'
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
  /**
   * The complete execution evidence and status for this replayed case.
   *
   * Keeping this execution-only ensures downstream code can safely consume
   * duration and steps without first narrowing a discovery-only result.
   */
  readonly result: ExecutedRunResult;

  /** The first classified failure that aborted this case, when one exists. */
  readonly error?: AmbercastError;
}

/**
 * Ordered replay outcomes, discovery-only listed files, and the structural
 * zero-match fact.
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

  /**
   * Files selected for discovery-only reporting.
   *
   * This field is always present and is empty outside list mode. It remains
   * separate from {@link results} because each case outcome promises executed
   * duration and step evidence, while a listed file has intentionally not
   * entered replay.
   */
  readonly listed: readonly RunListedFile[];
}

/**
 * A prompt file selected by `run --list`.
 *
 * The report boundary derives the public result identity from this path so the
 * use case does not duplicate report-only identifiers alongside selection.
 */
export type RunListedFile = { readonly file: string };

/**
 * Replays canonical, fresh plan artifacts against their configured browser targets.
 *
 * @param deps - Replay I/O, target, clock, browser, secret, event, discovery,
 * and cancellation dependencies.
 * @param options - Batch selection and replay policy.
 * @returns Completed per-case outcomes, discovery-only listed files, and the
 * zero-match fact needed by the command report.
 * @remarks
 * Literal files retain caller order and discovered files retain the injected
 * discovery order after duplicate literal paths are collapsed in first-seen
 * order. Cases run sequentially. A caller `AbortSignal` stops the scheduler
 * before another case starts, but returns the outcomes already completed; it
 * does not discard them.
 *
 * List mode stops after the same discovery, grep, and deduplication phase.
 * Its separate listed-file collection guarantees that this inspection path
 * cannot be treated as execution evidence by callers that consume case
 * outcomes.
 *
 * Each result uses a monotonic per-case duration so elapsed time remains
 * meaningful when wall-clock time changes. Replay validates the plan before
 * browser startup because only a canonical artifact with current inputs may
 * direct browser work. Absent grounding, stale provenance, invalid JSON, and
 * unrelated coverage-absent malformed grounding are recoverable cache misses.
 * Current-provenance coverage present at the exact own
 * `entries[rawKey].trace.verificationCoverage` path fails integrity before
 * browser or provider dispatch when its document is malformed or
 * noncanonical.
 *
 * The shared core resolver applies the same explicit, validated-default, and
 * sole-own-target policy as generation and freshness inspection. Its
 * one-entry result limits both digest input and browser authority to the same
 * target. A classified selection failure stops the current case before digest
 * computation, plan inspection, provider resolution, or browser launch, then
 * remains captured by that case so later cases keep run's existing per-file
 * isolation.
 *
 * Deterministic steps materialize run and secret values only immediately
 * before browser operations. Agentic instructions, provider-visible context,
 * and committed traces retain unresolved references; trusted trace replay
 * precedes a lazy agentic fallback when `cacheOnly` permits it. These
 * boundaries prevent materialized secrets and run values from crossing back
 * into provider-visible or persisted data.
 *
 * A failed assertion is a failed result rather than a reportable error.
 * Dispatch-time failures with a live browser preserve best-effort screenshot
 * and redacted accessibility evidence before the session closes, while
 * pre-launch and post-close failures correctly have none. Each case isolates
 * its own failure so later cases may continue, closes its browser session, and
 * flushes accumulated grounding atomically; a flush error changes only an
 * otherwise successful case. The unified case-abort result covers suppressed
 * fallback and unavailable capture or verification evidence without inventing
 * an error kind that misrepresents those conditions.
 */
export async function run(deps: RunDeps, options: RunOptions): Promise<RunOutcome> {
  const discovered = options.files.length === 0
    ? (await deps.discoverTestFiles({
      testDir: deps.config.testDir,
      testMatch: deps.config.testMatch,
      testIgnore: deps.config.testIgnore,
    })).map((path) => joinPath(deps.config.testDir, path))
    : [...options.files];
  const filteredFiles = options.grep === undefined
    ? discovered
    : discovered.filter((path) => grepMatches(options.grep!, path, deps.config.testDir));
  const files = [...new Set(filteredFiles)];

  if (files.length === 0) { return { results: [], noTestsFound: true, listed: [] }; }
  if (options.list) { return { results: [], noTestsFound: false, listed: files.map((file) => ({ file })) }; }

  const results: RunCaseOutcome[] = [];
  for (const file of files) {
    if (deps.signal?.aborted) {
      break;
    }

    results.push(await runCase(deps, options, file));
  }

  return { results, noTestsFound: false, listed: [] };
}

/**
 * Replays one prompt while its browser session is still available for failure
 * diagnostics.
 *
 * Evidence is attached at the assertion and caught-dispatch boundaries rather
 * than during teardown: both locations retain the original failure context,
 * while post-close grounding persistence cannot safely ask the released
 * browser for a screenshot or accessibility tree.
 */
async function runCase(deps: RunDeps, options: RunOptions, file: string): Promise<RunCaseOutcome> {
  const startedAt = deps.clock.monotonicMs();
  const planPath = deps.layout.planPathFor(file);
  const identity = { id: file, file, planFile: planPath };
  const completed: StepResult[] = [];
  let planSteps: readonly Step[] = [];
  let currentStep: Step | undefined;
  let session: BrowserSession | undefined;
  let groundingPath: string | undefined;
  let grounding: GroundingDocumentType | undefined;
  let groundingDirty = false;
  let aiExecutorPromise: Promise<InstructionCoveredAiExecutor> | undefined;
  let classifiedError: AmbercastErrorType | undefined;
  let result: ResultWithoutDuration | undefined;
  let resolvedSecrets: Map<string, Set<string>> | undefined;
  let runState: Map<RunVariableName, string> | undefined;

  try {
    let testMd: string;
    try {
      testMd = await deps.storage.readText(file);
    } catch (error) {
      throw fsIoError('The test prompt could not be read.', error);
    }

    const targetSelection = resolveTarget({
      targets: deps.config.targets,
      defaultTarget: deps.config.defaultTarget,
      explicitTarget: options.target,
    });
    if (targetSelection instanceof TargetUnresolvedError) {
      throw targetSelection;
    }
    const resolvedTargets = targetSelection.definitions;

    const normalizedTestMd = normalizeTestMd(testMd);
    const inputsDigest = computeInputsDigest({
      normalizedTestMd,
      schemaVersion: PLAN_SCHEMA_VERSION,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      targetDefinitions: resolvedTargets,
    });
    const trustedPlan = await readTrustedInstructionCoveredPlan(
      deps.storage,
      planPath,
      inputsDigest,
      normalizedTestMd,
    );
    const plan = trustedPlan.plan;
    /*
     * Re-attributing persisted grant spans before opening a browser ensures
     * every declared grant is consumed exactly once, rejecting hand-edited
     * plans that redirect a secret use or leave a grant uncovered.
     */
    assertCommittedSecretAttributionSound(plan, normalizedTestMd);
    planSteps = plan.steps;
    groundingPath = deps.layout.groundingPathFor(file);
    const loadedGrounding = await readUsableGrounding(deps.storage, groundingPath, plan);
    grounding = loadedGrounding;
    const target = targetSelection.definition;

    resolvedSecrets = new Map<string, Set<string>>();
    const preflightAllowedRunRefs = new Set<RunVariableName>();
    const preflightRunState = new Map<RunVariableName, string>();
    let cacheOnlyAiMissBeforeExecutableStep = false;
    let hasPriorExecutableStep = false;
    for (const step of plan.steps) {
      if (step.kind === 'capture') {
        preflightAllowedRunRefs.add(step.variable);
        preflightRunState.set(step.variable, `{{run.${step.variable}}}`);
        hasPriorExecutableStep = true;
        continue;
      }
      if (step.kind !== 'ai') {
        hasPriorExecutableStep = true;
        continue;
      }
      currentStep = step;
      const entry = loadedGrounding.entries[step.id];
      if (entry?.kind !== 'ai') {
        if (options.cacheOnly && !hasPriorExecutableStep) cacheOnlyAiMissBeforeExecutableStep = true;
        continue;
      }
      const secretRefs = new Set(step.secrets?.map((grant) => grant.ref) ?? []);
      const trustContext: TraceTrustContext = {
        target,
        runState: preflightRunState,
        secrets: deps.secrets,
        resolvedSecrets,
        allowedRunRefs: preflightAllowedRunRefs,
        deferHighEntropyFillCheck: preflightAllowedRunRefs.size > 0,
        rejectCapturedRunLiterals: !Object.hasOwn(entry.trace, 'verificationCoverage'),
      };
      const preScanned = preScanTraceForInstructionCoverage(entry.trace, trustContext, secretRefs);
      const classified = classifyPreScannedTraceCoverage({
        trace: preScanned,
        criteria: trustedPlan.instructionCoverageByStepId.get(step.id) ?? [],
        runValues: { values: preflightRunState },
      });
      if (!classified.success) {
        throw new IntegrityViolationError('The grounding trace contains invalid instruction coverage or verification proof.', {
          issues: classified.issues,
        });
      }
      if (classified.data.kind === 'legacy-cache-miss' && options.cacheOnly && !hasPriorExecutableStep) {
        cacheOnlyAiMissBeforeExecutableStep = true;
      }
      hasPriorExecutableStep = true;
    }
    if (cacheOnlyAiMissBeforeExecutableStep) {
      throw new CaseAbort('AI-directed replay has no covered trace while cache-only mode is enabled.');
    }
    currentStep = undefined;

    try {
      session = await deps.browserDriver(target.browser).launch(target);
    } catch (error) {
      if (error instanceof BrowserLaunchFailedError) {
        throw error;
      }

      throw new BrowserLaunchFailedError('The browser session could not be launched.', undefined, { cause: error });
    }

    const allowedRunRefs = new Set<RunVariableName>();
    const resolvedVias = new Map<Step['id'], ResolutionVia>();
    resolvedSecrets ??= new Map<string, Set<string>>();
    runState = new Map<RunVariableName, string>();
    const context: DispatchContext = {
      session,
      target,
      grounding: loadedGrounding,
      runState,
      secrets: deps.secrets,
      resolvedSecrets,
      allowedRunRefs,
      instructionCoverageByStepId: trustedPlan.instructionCoverageByStepId,
      resolveAiExecutor: () => {
        aiExecutorPromise ??= deps.resolveAiExecutor(deps.signal);
        return aiExecutorPromise;
      },
      cacheOnly: options.cacheOnly,
      events: deps.events,
      updateGroundingEntry: (stepId, entry) => {
        loadedGrounding.entries[stepId] = entry;
        groundingDirty = true;
      },
      deleteGroundingEntry: (stepId) => {
        if (Object.hasOwn(loadedGrounding.entries, stepId)) {
          delete loadedGrounding.entries[stepId];
          groundingDirty = true;
        }
      },
      resolvedVias,
      aiTimeoutMs: deps.config.ai.timeoutMs,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    };

    for (const [index, originalStep] of planSteps.entries()) {
      currentStep = originalStep;
      /*
       * `step-start` emits here, unconditionally, because it records each step
       * attempt rather than completion, including when its assertion fails or
       * its dispatch throws, while `step-result` stays gated on a completed
       * resolution path because it reports the step's `via` field.
       */
      deps.events.emit({ type: 'step-start', stepId: originalStep.id });
      const step = originalStep.kind === 'ai'
        ? originalStep
        : materializeStep(originalStep, context.runState, context.target.baseUrl);
      const outcome = step.kind === 'ai'
        ? await executeAiStep(step, context, options.cacheOnly)
        : await DISPATCH_TABLE[step.kind](step, context);
      if (outcome.kind === 'assertion-failed') {
        /*
         * Assertion diagnostics cross the case-report boundary only after
         * materialized values are restored to their stable references. This
         * keeps deterministic assertions on the same reference-only contract
         * as agentic diagnostics without giving browser adapters secret or
         * case-state access.
         */
        const evidence = await captureFailureEvidence(
          context.session,
          deps.storage,
          deps.layout.runsDirFor(file, deps.runId),
          originalStep.id,
          resolvedSecrets,
          runState,
          [outcome.expected, outcome.actual],
        );
        const expected = templateMaterializedValues(outcome.expected, resolvedSecrets, runState);
        const actual = templateMaterializedValues(outcome.actual, resolvedSecrets, runState);
        result = {
          ...identity,
          status: 'failed',
          steps: [
            ...completed,
            stepResult(originalStep, 'failed', 'assertion', { ...evidence, expected, actual }),
            ...skippedSteps(planSteps, index),
          ],
          explanation: actual,
        };
        break;
      }

      completed.push(stepResult(originalStep, 'passed'));
      if (originalStep.kind === 'capture') {
        allowedRunRefs.add(originalStep.variable);
      }
      deps.events.emit({
        type: 'step-result',
        stepId: originalStep.id,
        via: outcome.via ?? resolvedVias.get(originalStep.id) ?? 'grounding',
      });
    }

    result ??= {
      ...identity,
      status: 'passed',
      steps: completed,
      explanation: 'Replay completed successfully.',
    };
  } catch (error) {
    /*
     * Classified errors cross both case explanation and report-error
     * boundaries, so they are reconstructed with materialized values restored
     * to stable references before either surface retains them. Hoisted maps
     * make this safe for failures before context construction, where redaction
     * correctly becomes a no-op.
     *
     * CaseAbort throw sites construct static explanations. Plain generic
     * errors retain the fixed fallback explanation without examining their
     * message, so neither branch carries materialized case data.
     */
    const evidence = error instanceof AgenticCoverageAbort
      || error instanceof TraceProviderExposureIntegrityError
      || session === undefined
      || currentStep === undefined
      ? undefined
      : await captureFailureEvidence(
        session,
        deps.storage,
        deps.layout.runsDirFor(file, deps.runId),
        currentStep.id,
        resolvedSecrets ?? new Map(),
        runState ?? new Map(),
      );
    if (error instanceof AmbercastError) {
      classifiedError = redactedError(
        error,
        resolvedSecrets ?? new Map(),
        runState ?? new Map(),
      ) as AmbercastErrorType;
      result = resultForAbort(identity, planSteps, completed, currentStep, classifiedError.message, evidence);
    } else {
      const explanation = error instanceof CaseAbort
        ? error.message
        : 'The browser session could not complete this case and no deterministic fallback is available.';
      result = resultForAbort(identity, planSteps, completed, currentStep, explanation, evidence);
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

    if (groundingDirty && groundingPath !== undefined && grounding !== undefined) {
      try {
        /*
         * Immediately before serialization, this persistence boundary inspects
         * the parsed grounding tree with `jsonContainsResolvedSecret`. A match
         * refuses `writeText` and unconditionally reclassifies the case with
         * an IntegrityViolationError, so every blocked persistence attempt
         * follows the classified-error/status transition. The scan inspects
         * the object tree's string values without relying on JSON's escaped
         * text representation. Its entry keys are authored plan step
         * identifiers, structurally independent of resolved values, so
         * scanning them would create false positives from incidental
         * identifier overlap.
         */
        if (jsonContainsResolvedSecret(grounding, resolvedSecrets ?? new Map(), { scanObjectKeys: false })) {
          throw new IntegrityViolationError('The grounding cache contains a materialized secret value.');
        }

        await deps.storage.writeText(
          groundingPath,
          toCanonicalArtifactText(grounding as unknown as JsonValueT),
        );
      } catch (error) {
        if (error instanceof IntegrityViolationError) {
          const integrityError = redactedError(
            error,
            resolvedSecrets ?? new Map(),
            runState ?? new Map(),
          ) as IntegrityViolationError;
          classifiedError = integrityError;
          result = { ...result!, status: 'error', explanation: integrityError.message };
        } else if (result?.status === 'passed') {
          const flushError = redactedError(
            fsIoError('The grounding cache could not be written.', error),
            resolvedSecrets ?? new Map(),
            runState ?? new Map(),
          ) as FsIoError;
          classifiedError = flushError;
          result = { ...result, status: 'error', explanation: flushError.message };
        }
      }
    }
  }

  const durationMs = deps.clock.monotonicMs() - startedAt;
  return {
    result: { ...result!, durationMs },
    ...(classifiedError === undefined ? {} : { error: classifiedError }),
  };
}
