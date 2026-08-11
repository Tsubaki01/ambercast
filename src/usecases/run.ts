import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
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
import { computeAccessibilityFingerprint, countAccessibilityMatches } from '#core/ir/fingerprint.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  GroundingDocument,
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
  type JsonValueT,
  type PlanDocument as PlanDocumentType,
  type RunVariableName,
  type Step,
  type TargetDefinition,
} from '#core/ir/schema.js';
import type { LayoutResolver } from '#core/layout/resolve.js';
import { joinPath, relativeWithin } from '#core/paths.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { AiActionController, AiExecutor } from '#ports/ai.js';
import type { AssertCheck, AssertOutcome, BrowserSession, PerformableAction } from '#ports/browser.js';
import type { BrowserDriverResolver } from '#ports/index.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock, EventSink, SecretsProvider } from '#ports/system.js';
import { OBSERVED_NOTE, type Observed, type RunResult, type StepResult } from '#report/schema.js';
import { z } from 'zod';
import { assertSecretRefsGrounded, extractDeclaredSecretRefs } from './generator-secret-policy.js';

type ResultWithoutDuration = Omit<RunResult, 'durationMs'>;

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
  readonly resolveAiExecutor: () => Promise<AiExecutor>;
  readonly cacheOnly: boolean;
  readonly events: EventSink;
  readonly updateGroundingEntry: (stepId: Step['id'], entry: GroundingEntry) => void;
  readonly deleteGroundingEntry: (stepId: Step['id']) => void;
  readonly resolvedVias: Map<Step['id'], ResolutionVia>;
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
 * Marks an abort that has no reportable error kind while retaining a useful
 * case-level explanation.
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
function assertTrustedRunReferences(value: string, context: DispatchContext): void {
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
 * case state changes between validation and replacement in a future async
 * integration.
 */
function materializeTrustedRunText(value: string, context: DispatchContext): string {
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
 * check appears in deterministic-step materialization for path A, at the
 * trace-action browser boundary shared by paths B and C, and in path C's
 * whole-trace pre-scan before any action runs. Together those checkpoints
 * preserve the invariant that every navigation URL reaching the browser port
 * passes through this guard.
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
 * Converts a trusted unresolved trace action into the browser port's
 * materialized action shape immediately before execution.
 *
 * Trace actions intentionally carry the authored element locator unchanged.
 * The wrapper does not attempt a second grounding lookup because a recorded
 * trace is itself the replay recipe; only run interpolation and secret lookup
 * are runtime-bound fields. Every non-empty resolved secret is retained in
 * the case-wide registry before browser work so later diagnostics can redact
 * both replayed and freshly resolved values.
 */
function materializeTraceAction(
  action: TraceAction,
  context: DispatchContext,
  secretRefs: ReadonlySet<string>,
  resolvedSecrets: Map<string, Set<string>>,
): PerformableAction {
  switch (action.type) {
    case 'click':
      return { type: 'click', target: action.target };
    case 'navigate': {
      const url = materializeTrustedRunText(action.url, context);
      /*
       * Fresh agentic control (path B) and trace replay (path C) share this
       * browser-boundary checkpoint.
       */
      assertSameOriginNavigation(url, context.target.baseUrl);
      return { type: 'navigate', url };
    }
    case 'press':
      return { type: 'press', target: action.target, key: action.key };
    case 'fill':
      return { type: 'fill', target: action.target, value: materializeTrustedRunText(action.value, context) };
    case 'fill-secret': {
      if (!secretRefs.has(action.secretRef)) {
        throw new IntegrityViolationError('An AI action references a secret that this step is not allowed to use.', {
          secretRef: action.secretRef,
        });
      }

      const value = context.secrets.resolve(action.secretRef);
      if (value === undefined) {
        throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: action.secretRef });
      }

      recordResolvedSecret(resolvedSecrets, action.secretRef, value);
      return { type: 'fill-secret', target: action.target, value };
    }
  }
}

/**
 * Converts a trusted unresolved trace assertion to the browser's materialized
 * check shape immediately before evaluation.
 *
 * Assertions never resolve secrets, but their text and URL expectations may
 * reference a captured case value and must therefore use the same grant and
 * availability checks as trace actions.
 */
function materializeTraceAssert(check: TraceAssert, context: DispatchContext): AssertCheck {
  switch (check.check) {
    case 'text-visible':
      return { check: 'text-visible', text: materializeTrustedRunText(check.text, context) };
    case 'element-visible':
      return { check: 'element-visible', target: check.target };
    case 'text-equals':
      return {
        check: 'text-equals',
        target: check.target,
        text: materializeTrustedRunText(check.text, context),
      };
    case 'url-matches':
      return { check: 'url-matches', pattern: materializeTrustedRunText(check.pattern, context) };
    case 'element-count':
      return { check: 'element-count', target: check.target, count: check.count };
  }
}

/**
 * Checks the dynamic authority requirements of one already-parsed trace item.
 *
 * `readUsableGrounding` has already validated the complete document shape and
 * `preScanTrace` has validated and resolved every trace secret. This checks
 * the remaining runtime facts: current-case run grants, captured values, and
 * materialized values in fields that can cross the replay boundary.
 */
function preScanTraceEntry(
  entry: TraceAction | TraceAssert,
  context: DispatchContext,
): void {
  /*
   * `preScanTrace` primes the resolved-secret registry from the complete trace
   * before this validation pass, making each inspection independent of journal
   * order. The four fields mirror the live provider guard: navigate URLs, fill
   * values, assertion text, and URL-match patterns. Rejecting them before replay
   * prevents a contaminated historical trace from reaching either browser
   * execution or an AI adapter as `priorTrace`.
   */
  const assertSafeTraceField = (value: string): void => {
    assertTrustedRunReferences(value, context);
    if (containsResolvedSecret(value, context.resolvedSecrets)) {
      throw new IntegrityViolationError('An AI trace contains a materialized secret value.');
    }
  };

  switch (entry.type === 'assert' ? entry.check : entry.type) {
    case 'navigate': {
      const url = (entry as Extract<TraceAction, { type: 'navigate' }>).url;
      assertSafeTraceField(url);
      /*
       * Pre-scanning the whole trace preserves replay atomicity: a later
       * unsafe navigation cannot let an earlier valid action execute.
       */
      assertSameOriginNavigation(materializeTrustedRunText(url, context), context.target.baseUrl);
      return;
    }
    case 'fill':
      assertSafeTraceField((entry as Extract<TraceAction, { type: 'fill' }>).value);
      return;
    case 'text-visible':
      assertSafeTraceField((entry as Extract<TraceAssert, { check: 'text-visible' }>).text);
      return;
    case 'text-equals':
      assertSafeTraceField((entry as Extract<TraceAssert, { check: 'text-equals' }>).text);
      return;
    case 'url-matches':
      assertSafeTraceField((entry as Extract<TraceAssert, { check: 'url-matches' }>).pattern);
      return;
    default:
      return;
  }
}

/**
 * Performs path C's complete dynamic-trust pass before replay touches the
 * browser.
 *
 * Events precede verification in both storage and execution. Walking both
 * lists here keeps a later bad reference from allowing an earlier action to
 * run, while intentionally avoiding redundant zod validation of entries that
 * cannot survive `readUsableGrounding` with an invalid static shape.
 */
function preScanTrace(trace: z.infer<typeof TraceRecord>, context: DispatchContext, secretRefs: ReadonlySet<string>): void {
  /*
   * The first pass resolves every granted `fill-secret` reference in both trace
   * lists and retains its value in `context.resolvedSecrets`. Priming the full
   * registry makes subsequent field checks independent of journal order: a
   * literal that precedes its trace's fill-secret action is still rejected
   * before replay. Missing values and ungranted references retain their
   * classified failure behavior rather than becoming a permissive cache miss.
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
 * Replays a trusted trace in journal order and returns whether the browser
 * confirmed every recorded observation.
 *
 * A false assertion is an expected behavioral miss. Browser rejections are
 * left to the caller so it can distinguish ordinary behavioral failure from
 * the classified integrity and resolution failures emitted by materialization.
 */
async function replayTrace(
  trace: z.infer<typeof TraceRecord>,
  context: DispatchContext,
  secretRefs: ReadonlySet<string>,
): Promise<boolean> {
  for (const entry of trace.events) {
    if (entry.type === 'assert') {
      const outcome = await context.session.evaluateAssert(materializeTraceAssert(entry, context));
      if (!outcome.passed) {
        return false;
      }
      continue;
    }

    await context.session.perform(materializeTraceAction(entry, context, secretRefs, context.resolvedSecrets));
  }

  for (const assertion of trace.verification) {
    const outcome = await context.session.evaluateAssert(materializeTraceAssert(assertion, context));
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
 * Rejects a provider literal that crosses back over the materialization
 * boundary instead of using its unresolved reference.
 *
 * Resolved secrets are more sensitive than captured run values: a sufficiently
 * long secret substring cannot remain in a provider field because later
 * persistence could retain it irreversibly. Captured values keep exact-field
 * matching because ordinary provider prose may legitimately contain them as
 * a substring; widening that existing run-state rule would reject valid work.
 */
function assertNoMaterializedLiteral(
  entry: TraceAction | TraceAssert,
  context: DispatchContext,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  let value: string | undefined;

  switch (entry.type) {
    case 'navigate':
      value = entry.url;
      break;
    case 'fill':
      value = entry.value;
      break;
    case 'assert':
      switch (entry.check) {
        case 'text-visible':
        case 'text-equals':
          value = entry.text;
          break;
        case 'url-matches':
          value = entry.pattern;
          break;
        default:
          return;
      }
      break;
    default:
      return;
  }

  if (
    (value !== undefined && containsResolvedSecret(value, resolvedSecrets))
    || [...context.runState.values()].some((candidate) => candidate === value)
  ) {
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
// A defensive backstop against accidental deep nesting, not a claim about a specific adversarial threat.
const MAX_REDACTION_DEPTH = 20;

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
 * This mirrors the redaction traversal rather than serializing and searching
 * text: JSON escaping can conceal a raw literal from a serialized scan. Only
 * arrays and plain records are traversed; the plain-object-prototype check
 * structurally excludes non-plain objects from traversal at this persistence
 * boundary. A shared cycle guard and the existing depth ceiling make malformed diagnostic
 * trees safe to inspect, while returning on the first hit avoids examining
 * more of a value that is already unsafe to persist.
 *
 * @param value - Parsed JSON-shaped tree considered for persistence.
 * @param resolvedSecrets - Every secret value observed during the case.
 * @param options - Controls whether plain-object keys are scanned. Key
 * scanning remains the default for diagnostic and accessibility trees, whose
 * keys cannot be assumed independent of provider-controlled values. The
 * grounding-persistence boundary disables it because `GroundingDocument`
 * entry keys are authored plan step identifiers, not resolved runtime data.
 * @returns `true` when a supported string value or, unless disabled, object
 * key contains a resolved secret according to `containsResolvedSecret`.
 */
function jsonContainsResolvedSecret(
  value: unknown,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  options: { readonly scanObjectKeys?: boolean } = {},
): boolean {
  const visited = new WeakSet<object>();
  const scanObjectKeys = options.scanObjectKeys ?? true;

  const scan = (current: unknown, depth: number): boolean => {
    if (depth > MAX_REDACTION_DEPTH) {
      return false;
    }

    if (typeof current === 'string') {
      return containsResolvedSecret(current, resolvedSecrets);
    }

    if (Array.isArray(current)) {
      if (visited.has(current)) {
        return false;
      }

      visited.add(current);
      return current.some((item) => scan(item, depth + 1));
    }

    if (
      current !== null
      && typeof current === 'object'
      && (Object.getPrototypeOf(current) === Object.prototype || Object.getPrototypeOf(current) === null)
    ) {
      if (visited.has(current)) {
        return false;
      }

      visited.add(current);
      for (const [key, item] of Object.entries(current)) {
        if ((scanObjectKeys && containsResolvedSecret(key, resolvedSecrets)) || scan(item, depth + 1)) {
          return true;
        }
      }
    }

    return false;
  };

  return scan(value, 0);
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
 * Wraps one live browser session for exactly one agentic execution.
 *
 * The wrapper is the authority that both materializes provider instructions
 * and decides whether a nominal agentic success has sufficient terminal
 * evidence to become replayable grounding. It records only successful actions
 * and passing assertions in unresolved form, while a separate raw-observation
 * counter prevents unjournaled sensing from being mistaken for adjacent final
 * verification.
 */
class AgenticRunPipeline implements AiActionController {
  readonly #journal: Array<TraceAction | TraceAssert> = [];
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
    const materialized = materializeTraceAction(parsed.data, this.context, this.#secretRefs, this.context.resolvedSecrets);
    try {
      await this.context.session.perform(materialized);
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
   */
  async evaluateAssert(check: TraceAssert): Promise<AssertOutcome> {
    const parsed = TraceAssert.safeParse(check);
    if (!parsed.success) {
      throw new IntegrityViolationError('The AI adapter supplied an invalid assertion observation.', {
        issues: parsed.error.issues,
      });
    }

    assertNoMaterializedLiteral(parsed.data, this.context, this.context.resolvedSecrets);
    const materialized = materializeTraceAssert(parsed.data, this.context);
    let outcome: AssertOutcome;
    try {
      outcome = await this.context.session.evaluateAssert(materialized);
    } catch (error) {
      throw scrubBrowserRejection(error, this.context.resolvedSecrets, this.context.runState);
    }
    if (outcome.passed) {
      this.#trailingPassedAssertRun += 1;
      this.#lastObservation = 'passed-assert';
      this.#journal.push(parsed.data);
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
   * `AiActionController`-facing snapshot construction only. The accessibility
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
      const parsed = TraceRecord.safeParse({ events, verification });
      if (!parsed.success) {
        throw new IntegrityViolationError('The AI verification journal is internally inconsistent.', {
          issues: parsed.error.issues,
        });
      }

      this.context.updateGroundingEntry(this.step.id, { kind: 'ai', trace: parsed.data });
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
  priorTrace: z.infer<typeof TraceRecord> | undefined,
  fallbackFromReplay: boolean,
): Promise<DispatchOutcome> {
  const secretRefs = step.secrets ?? [];
  if (priorTrace !== undefined) {
    preScanTrace(priorTrace, context, new Set(secretRefs));
  }

  const executor = await context.resolveAiExecutor();
  const pipeline = new AgenticRunPipeline(context, secretRefs, step, fallbackFromReplay);
  context.events.emit({ type: 'ai-call', stepId: step.id });
  const result = await executor.executeAgentic({
    instructionPrompt: step.instruction,
    allowedSecretRefs: secretRefs,
    allowedRunRefs: [...context.allowedRunRefs],
    controller: pipeline,
    ...(priorTrace === undefined ? {} : { priorTrace }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  return pipeline.finalize(result.outcome);
}

/**
 * Executes an AI step by replaying trusted grounding first, then falling back
 * to one fresh agentic interaction only for a behavioral trace miss.
 *
 * The pre-scan is an integrity gate rather than a hint: an entry whose grants
 * no longer fit this case is never partially replayed and never handed back to
 * an AI provider. `cacheOnly` suppresses both cold-start and behavioral-miss
 * calls, producing the same case-abort outcome as replay that permits no AI
 * fallback.
 */
async function executeAiStep(
  step: Extract<Step, { kind: 'ai' }>,
  context: DispatchContext,
  cacheOnly: boolean,
): Promise<DispatchOutcome> {
  const entry = context.grounding.entries[step.id];
  const secretRefs = new Set(step.secrets ?? []);
  if (entry?.kind !== 'ai') {
    if (cacheOnly) {
      throw new CaseAbort('AI-directed replay has no usable trace while cache-only mode is enabled.');
    }

    return executeAgentic(step, context, undefined, false);
  }

  preScanTrace(entry.trace, context, secretRefs);
  try {
    if (await replayTrace(entry.trace, context, secretRefs)) {
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

  return executeAgentic(step, context, entry.trace, true);
}

/**
 * Re-resolves an element grounding miss through a structured AI confirmation
 * request when the caller has allowed fallback.
 *
 * The authored `ElementRef` remains immutable because grounding stores no
 * alternate locator. After capturing resolution evidence, this path derives
 * the fingerprint from the unredacted accessibility tree before it resolves
 * an AI executor or emits an `ai-call` event. An absent or ambiguous local
 * match has no safe target for confirmation, so it raises `CaseAbort` without
 * provider work or a grounding write.
 *
 * The AI receives a redacted copy of the evidence and answers only whether
 * the existing locator identifies the intended element. A denial raises
 * `CaseAbort`; confirmation persists only the already-derived local
 * fingerprint before subsequent browser work. Persisting that page fact
 * before the action remains intentional: it survives a later action failure
 * and joins the case's single final atomic grounding flush.
 */
async function groundedTarget(
  context: DispatchContext,
  step: ActionStep | AssertStep | CaptureStep,
  target: ElementRef,
): Promise<ElementRef> {
  const entry = context.grounding.entries[step.id];
  if (entry?.kind === 'element') {
    const resolved = await context.session.resolveGrounded(target, entry.fingerprint);
    if (resolved.kind === 'hit') {
      return resolved.ref;
    }
  }

  if (context.cacheOnly) {
    throw new CaseAbort('Element grounding is unavailable while cache-only mode is enabled.');
  }

  const snapshot = await context.session.snapshotForResolution();
  const fingerprint = computeAccessibilityFingerprint(snapshot.accessibilityTree, target);
  if (fingerprint === undefined) {
    const matchCount = countAccessibilityMatches(snapshot.accessibilityTree, target);
    if (matchCount === 0) {
      throw new CaseAbort('The supplied locator has no matching element in the current accessibility evidence.');
    }

    if (matchCount !== undefined && matchCount > 1) {
      throw new CaseAbort('The supplied locator matches more than one element in the current accessibility evidence and cannot be trusted.');
    }

    throw new CaseAbort('The supplied locator cannot be unambiguously identified from current accessibility evidence.');
  }

  const executor = await context.resolveAiExecutor();
  context.events.emit({ type: 'ai-call', stepId: step.id });
  const response = await executor.execute({
    prompt: 'Confirm whether the supplied locator still identifies the intended element.',
    responseSchema: CONFIRMATION_RESPONSE_SCHEMA,
    /**
     * The redacted accessibility tree lets the provider make its confirm/deny
     * semantic judgment. Screenshot pixels are excluded because string
     * substitution cannot safely redact them; redacting string values and
     * object keys keeps materialized secrets and run values out of provider
     * input without altering the tree's JSON structure.
     */
    context: {
      target: target as unknown as JsonValueT,
      snapshot: {
        accessibilityTree: redactJsonStrings(
          snapshot.accessibilityTree,
          context.resolvedSecrets,
          context.runState,
        ) as JsonValueT,
      },
    },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  if (response.data.confirmed === false) {
    throw new CaseAbort('The AI could not confirm that the supplied locator identifies the intended element.');
  }

  context.updateGroundingEntry(step.id, { kind: 'element', fingerprint });
  context.resolvedVias.set(step.id, 'ai-resolve');
  return target;
}

/**
 * Materializes and performs one deterministic action through the live session.
 *
 * Element actions resolve trusted grounding immediately before browser use,
 * and secret values are resolved only at that boundary then retained for
 * later diagnostic redaction. This keeps plans and grounding reference-only
 * while preserving the values required to sanitize a subsequent failure.
 */
async function executeAction(step: Step, context: DispatchContext): Promise<DispatchOutcome> {
  if (step.kind !== 'action') {
    throw new Error('The action dispatcher received a non-action step.');
  }

  let action: PerformableAction;
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
      const target = await groundedTarget(context, step, step.target);
      const value = context.secrets.resolve(step.secretRef);
      if (value === undefined) {
        throw new SecretUnresolvedError('The referenced secret is unavailable.', { secretRef: step.secretRef });
      }

      recordResolvedSecret(context.resolvedSecrets, step.secretRef, value);
      action = { type: 'fill-secret', target, value };
      break;
    }
  }

  await context.session.perform(action);
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
        target: await groundedTarget(context, step, step.target),
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
      return `Element ${check.target.role} "${check.target.name}" is visible.`;
    case 'text-equals':
      return `Element ${check.target.role} "${check.target.name}" has text "${check.text}".`;
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
 * One raw tree serves both the omission signal and persisted observed
 * evidence: the helper checks the original tree for a
 * resolved-secret hit, then redacts that same tree before compact
 * serialization. Redaction must precede serialization because JSON escaping
 * can hide a raw value from string-based replacement. Snapshot acquisition
 * can return a false signal because no tree exists to inspect. Once a tree
 * exists, however, detector failure is unsafe and returns a true signal: a
 * throwing getter or other malformed evidence must not turn uncertain secret
 * presence into permission to capture a screenshot. Rendering is separately
 * best-effort and retains the already-established signal.
 */
async function captureObservedEvidence(
  session: BrowserSession,
  resolvedSecrets: ReadonlyMap<string, ReadonlySet<string>>,
  runState: ReadonlyMap<RunVariableName, string>,
): Promise<{ readonly observed?: Observed; readonly rawTreeContainsSecret: boolean }> {
  let rawTree: JsonValueT;
  try {
    rawTree = await session.accessibilitySnapshot();
  } catch {
    return { rawTreeContainsSecret: false };
  }

  let rawTreeContainsSecret: boolean;
  try {
    rawTreeContainsSecret = jsonContainsResolvedSecret(rawTree, resolvedSecrets);
  } catch {
    return { rawTreeContainsSecret: true };
  }

  try {
    return {
      rawTreeContainsSecret,
      observed: {
        note: OBSERVED_NOTE,
        accessibilitySnapshot: JSON.stringify(redactJsonStrings(rawTree, resolvedSecrets, runState)),
      },
    };
  } catch {
    return { rawTreeContainsSecret };
  }
}

/**
 * Coordinates failure evidence while keeping screenshot capture from writing
 * a known secret disclosure to disk.
 *
 * The coordinator awaits accessibility capture first because its
 * raw tree participates in the screenshot-omission decision. It combines
 * that signal with the raw assertion pair when present through the existing
 * `containsResolvedSecret` and `jsonContainsResolvedSecret` boundaries, so
 * evidence capture cannot drift into a second secret detector. Any hit
 * returns the observed detail available so far and `screenshotOmitted`
 * without calling the browser screenshot or storage port. On a miss,
 * screenshot capture has its own caught failure boundary, so an accessibility
 * capture failure still permits it and a screenshot capture/write failure
 * still preserves observed evidence. This deliberate sequencing changes only
 * dependency order, not the independence of diagnostic failures.
 * Assertion-specific fields stay at the caller so an environment error cannot
 * invent them.
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
  const { observed, rawTreeContainsSecret } = await captureObservedEvidence(session, resolvedSecrets, runState);
  if (rawTreeContainsSecret || rawAssertionText.some((text) => containsResolvedSecret(text, resolvedSecrets))) {
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
 * reached the browser.
 */
function resultForAbort(
  identity: Pick<RunResult, 'id' | 'file' | 'planFile'>,
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
 * Declares replay selection and AI-fallback policy for one run batch.
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

  /** Whether grounding misses and trace misses must fail without an AI fallback. */
  readonly cacheOnly: boolean;

  /** Parsed stale-artifact policy; regeneration is rejected before replay begins. */
  readonly stale: 'fail' | 'regenerate';
}

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
   * `runCase` memoizes this resolver after the first actual fallback, so path
   * B and path C calls in the same case share one executor without probing a
   * provider for cache-only or complete-cache replay.
   */
  readonly resolveAiExecutor: (signal?: AbortSignal) => Promise<AiExecutor>;

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
 * discovery order after duplicate literal paths are collapsed in first-seen
 * order. Cases run sequentially. A caller `AbortSignal` stops the scheduler
 * before another case starts, but returns the outcomes already completed; it
 * does not discard them.
 *
 * Each result uses a monotonic per-case duration so elapsed time remains
 * meaningful when wall-clock time changes. Replay validates the plan before
 * browser startup because only a canonical artifact with current inputs may
 * direct browser work. Grounding is a recoverable cache: an absent, malformed,
 * or stale cache falls back to empty grounding rather than invalidating the
 * trusted plan.
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
  let aiExecutorPromise: Promise<AiExecutor> | undefined;
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
    /*
     * Rechecking a trusted plan before replay prepares grounding or launches a
     * browser prevents a pre-existing artifact from bypassing declaration
     * policy that generation-time validation could not have applied
     * retroactively.
     */
    const declaredRefs = extractDeclaredSecretRefs(normalizedTestMd);
    assertSecretRefsGrounded(plan, declaredRefs);
    planSteps = plan.steps;
    groundingPath = deps.layout.groundingPathFor(file);
    const loadedGrounding = await readUsableGrounding(deps.storage, groundingPath, plan);
    grounding = loadedGrounding;
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

    const allowedRunRefs = new Set<RunVariableName>();
    const resolvedVias = new Map<Step['id'], ResolutionVia>();
    resolvedSecrets = new Map<string, Set<string>>();
    runState = new Map<RunVariableName, string>();
    const context: DispatchContext = {
      session,
      target,
      grounding: loadedGrounding,
      runState,
      secrets: deps.secrets,
      resolvedSecrets,
      allowedRunRefs,
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
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    };

    for (const [index, originalStep] of planSteps.entries()) {
      currentStep = originalStep;
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
      deps.events.emit({ type: 'step-start', stepId: originalStep.id });
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
    const evidence = session === undefined || currentStep === undefined
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
