/**
 * Declares the AI boundary for structured generation calls and browser-led
 * agentic work.
 */
import type { TypedJsonSchema } from '#core/ai/typed-json-schema.js';
import type {
  JsonValueT,
  RunVariableName,
  SecretRef,
  TraceAction,
  TraceAssert,
  TraceRecord,
} from '#core/ir/schema.js';

import type { AssertOutcome } from './browser.js';

/**
 * Optional provider-reported token accounting for one AI call.
 *
 * Omitted fields mean the provider did not supply that measurement.
 */
export interface AiUsage {
  /** Tokens the provider counted for the submitted prompt and context. */
  readonly inputTokens?: number;

  /** Tokens the provider counted for the generated response. */
  readonly outputTokens?: number;
}

/**
 * Browser evidence that may cross the action-resolution AI boundary.
 *
 * @remarks
 * This deliberately preserves only the accessibility tree. Keeping this
 * contract distinct from raw browser evidence prevents callers from
 * interpreting an omitted image as either an empty capture or a capture
 * failure, while allowing the run pipeline to redact resolved values before
 * the tree reaches an AI provider.
 */
export interface AiResolutionSnapshot {
  /** The accessibility tree after the run pipeline applies its AI-bound redaction policy. */
  readonly accessibilityTree: JsonValueT;
}

/**
 * Inputs for one structured AI response request.
 *
 * @typeParam T - The response shape associated with `responseSchema`.
 */
export interface AiExecuteRequest<T = unknown> {
  /** Complete instructions sent to the provider. */
  readonly prompt: string;

  /** Response shape that the adapter validates before returning data. */
  readonly responseSchema: TypedJsonSchema<T>;

  /** Serializable caller context sent with the request when needed. */
  readonly context?: JsonValueT;

  /** Cancellation signal forwarded to a provider that supports cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * A validated structured AI response with its unparsed provider output.
 *
 * @typeParam T - The expected shape of the validated response data.
 */
export interface AiExecuteResult<T> {
  /** Data after the adapter validates it against the supplied response schema. */
  readonly data: T;

  /** Original provider output retained for diagnostics. */
  readonly raw: string;

  /** Provider accounting, when the provider supplies it. */
  readonly usage?: AiUsage;
}

/**
 * Browser operations available to an agentic AI call.
 *
 * @remarks
 * The run-pipeline wrapper materializes each {@link TraceAction} immediately
 * before passing it to the underlying browser. It resolves `{{run.*}}`
 * interpolation wherever `InterpolatableText` permits it, including
 * navigation URLs and fill values, and resolves a `fill-secret` action's
 * `secretRef` through the secrets port. The browser consequently receives
 * fully materialized fields, while no resolved secret value crosses back over
 * this boundary.
 *
 * An unknown or unresolvable `secretRef` fails closed: {@link perform}
 * rejects, and that rejection propagates through agentic execution's
 * transport/execution-error contract. It is not converted into
 * `outcome: 'failure'`, which describes a completed interaction that did not
 * reach its goal.
 *
 * Both controller methods enforce the current request's trusted secret and
 * run-reference grants before materializing provider-directed data. They
 * reject an integrity violation rather than allowing untrusted provider output
 * to direct the browser; adapters may handle their own transport retries but
 * must not turn that boundary failure into an in-band agentic outcome.
 *
 * The wrapper is the sole recorder of performed actions; adapters do not
 * report a second trace. A TypeScript type alone does not validate an action
 * or assertion received from an external provider process, so the
 * run-pipeline controller validates each against the exported
 * {@link TraceAction} or {@link TraceAssert} zod schema at controller entry.
 * This port contains no runtime logic that can provide that validation itself.
 */
export interface AiActionController {
  /**
   * Materializes and executes one recorded action.
   *
   * @param action - An unresolved action that remains safe to record.
   * @returns Resolves after the action completes.
   * @throws IntegrityViolationError if the action violates trusted plan grants
   * or cannot be safely materialized.
   * @throws SecretUnresolvedError if an allowed secret reference cannot be
   * resolved.
   * @throws If the browser cannot execute the action.
   */
  perform(action: TraceAction): Promise<void>;

  /**
   * Materializes and evaluates one recorded assertion observation.
   *
   * @param check - An unresolved assertion that remains safe to record.
   * @returns A passing or diagnosable failing outcome.
   * @throws IntegrityViolationError if the assertion violates trusted plan
   * grants or cannot be safely materialized.
   * @throws If the browser cannot evaluate the assertion.
   */
  evaluateAssert(check: TraceAssert): Promise<AssertOutcome>;

  /**
   * Captures page evidence permitted for action resolution.
   *
   * @returns An AI-safe snapshot containing the redacted accessibility tree.
   * @throws If page evidence cannot be captured.
   * @remarks
   * This intentionally has a narrower contract than raw browser evidence:
   * callers receive no screenshot property and must not infer anything about
   * image capture from its absence.
   */
  snapshotForResolution(): Promise<AiResolutionSnapshot>;
}

/**
 * Inputs for an AI-directed browser interaction and its trusted plan grants.
 *
 * Required allow-lists make omitted consent a compile-time error. They are
 * plan-derived metadata, never instructions inferred from page snapshots or
 * other provider-visible context, so untrusted page content cannot expand an
 * agentic call's authority.
 */
export interface AiAgenticRequest {
  /** Instructions that guide the browser-directed interaction. */
  readonly instructionPrompt: string;

  /** Secret references the controller may resolve for this interaction. */
  readonly allowedSecretRefs: readonly SecretRef[];

  /** Captured run-variable names the controller may interpolate. */
  readonly allowedRunRefs: readonly RunVariableName[];

  /** Browser operations the adapter may direct while handling this request. */
  readonly controller: AiActionController;

  /**
   * Replayable evidence from an earlier successful interaction, when it aids
   * recovery.
   *
   * Its events and verification assertions remain unresolved so neither secret
   * nor run-derived values cross into provider context. Before executing an
   * agentic request, the run pipeline verifies that every trace secret
   * reference is still covered by this request's current secret grants.
   */
  readonly priorTrace?: TraceRecord;

  /** Cancellation signal forwarded to a provider that supports cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * The outcome of a completed AI-directed browser interaction.
 *
 * @remarks
 * The caller supplies the controller and consequently observes every
 * performed action first-hand. An adapter-reported duplicate trace would
 * either be trusted, allowing a fabricated action to poison committed replay
 * data, or be verified against the caller's own record, which adds ceremony
 * without information.
 *
 * `outcome: 'success'` is necessary but not sufficient for a successful run
 * step. The run-pipeline wrapper independently requires terminal verification
 * evidence and may reclassify a nominally successful agentic result as a step
 * failure when that evidence is absent.
 */
export interface AiAgenticResult {
  /** Whether the provider reports that the interaction completed its goal. */
  readonly outcome: 'success' | 'failure';

  /** Provider accounting, when the provider supplies it. */
  readonly usage?: AiUsage;
}

/**
 * An AI implementation for structured responses and browser-directed work.
 *
 * @remarks
 * Structured execution returns a schema-validated value, whereas agentic
 * execution controls a browser through a caller-provided controller. Keeping
 * them as separate methods makes their incompatible call contracts explicit.
 */
export interface AiExecutor {
  /** Identifies the command-line provider integration behind this executor. */
  readonly name: 'claude-code-cli' | 'codex-cli';

  /**
   * Obtains and validates one structured response.
   *
   * @typeParam T - The caller's expected response type.
   * @param request - Instructions, response schema, and optional context.
   * @returns The validated data, raw output, and any provider accounting.
   * @throws If the provider is unavailable, the request is cancelled, or a
   * response cannot be obtained or validated.
   */
  execute<T>(request: AiExecuteRequest<T>): Promise<AiExecuteResult<T>>;

  /**
   * Performs an AI-directed interaction through the supplied controller.
   *
   * The run-pipeline wrapper discards its entire journal after any result
   * other than a fully verified success, including `outcome: 'failure'`,
   * rejection, or cancellation. Cancellation, including an aborted signal,
   * always rejects rather than returning an outcome. Transport and execution
   * errors also reject.
   *
   * @param request - Instructions, browser controller, and optional prior
   * trace.
   * @returns The completed interaction outcome.
   * @throws If the request cannot be performed.
   */
  executeAgentic(request: AiAgenticRequest): Promise<AiAgenticResult>;

  /**
   * Checks whether this executor can currently accept requests.
   *
   * @param signal - Optional cancellation for a potentially slow probe.
   * @returns `true` when callers may issue requests and `false` when it is
   * unavailable.
   * @throws If availability cannot be determined.
   * @remarks
   * The command-line adapters fold every probe failure into `false`. The port
   * retains its general throwing allowance for an implementation that genuinely
   * cannot determine availability.
   */
  isAvailable(signal?: AbortSignal): Promise<boolean>;
}
