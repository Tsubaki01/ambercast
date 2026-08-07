/**
 * Declares the AI boundary for structured generation calls and browser-led
 * agentic work.
 */
import type { JsonValueT, TraceAction } from '#core/ir/schema.js';

import type { AssertCheck, AssertOutcome, PageSnapshot } from './browser.js';

/**
 * An object-form response schema passed to an AI adapter for validation.
 *
 * @remarks
 * The port transports a schema but never interprets it. A small local record
 * therefore avoids coupling port consumers to a particular validation
 * library's implementation types.
 */
export type JsonSchema = Record<string, unknown>;

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
 * Inputs for one structured AI response request.
 */
export interface AiExecuteRequest {
  /** Complete instructions sent to the provider. */
  readonly prompt: string;

  /** Response shape that the adapter validates before returning data. */
  readonly responseSchema: JsonSchema;

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
 * The wrapper is the sole recorder of performed actions; adapters do not
 * report a second trace. A TypeScript type alone does not validate an action
 * received from an external provider process, so an executor that constructs
 * actions from that output validates them against the exported
 * {@link TraceAction} zod schema before calling {@link perform}. This port
 * contains no runtime logic that can provide that validation itself.
 */
export interface AiActionController {
  /**
   * Materializes and executes one recorded action.
   *
   * @param action - An unresolved action that remains safe to record.
   * @returns Resolves after the action completes.
   * @throws If the action cannot be materialized or the browser cannot execute
   * it, including when its secret reference cannot be resolved.
   */
  perform(action: TraceAction): Promise<void>;

  /**
   * Evaluates an assertion with values materialized for the current run.
   *
   * @param check - The assertion to evaluate.
   * @returns A passing or diagnosable failing outcome.
   * @throws If the assertion cannot be evaluated.
   */
  evaluateAssert(check: AssertCheck): Promise<AssertOutcome>;

  /**
   * Captures the page evidence available for action resolution.
   *
   * @returns The current accessibility tree and screenshot.
   * @throws If either representation cannot be captured.
   */
  snapshotForResolution(): Promise<PageSnapshot>;
}

/**
 * Inputs for an AI-directed browser interaction.
 */
export interface AiAgenticRequest {
  /** Instructions that guide the browser-directed interaction. */
  readonly instructionPrompt: string;

  /** Browser operations the adapter may direct while handling this request. */
  readonly controller: AiActionController;

  /**
   * Recorded actions from an earlier successful interaction, when they aid
   * context.
   *
   * For a `fill-secret` action, its `secretRef` remains an unresolved reference
   * when carried in the trace. `readonly` protects the array reference
   * rather than its nested fields; that shallow guarantee matches
   * {@link TraceAction} and its grounding-storage and replay consumers, so
   * callers do not mutate supplied or received action elements.
   */
  readonly priorTrace?: readonly TraceAction[];

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
 */
export interface AiAgenticResult {
  /** Whether the interaction completed its requested outcome. */
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
  execute<T>(request: AiExecuteRequest): Promise<AiExecuteResult<T>>;

  /**
   * Performs an AI-directed interaction through the supplied controller.
   *
   * A completed call may return `outcome: 'failure'` after partially
   * performing actions; the controller retains that record. Cancellation,
   * including an aborted signal, always rejects rather than returning an
   * outcome. Transport and execution errors also reject.
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
   * @returns `true` when callers may issue requests and `false` when it is
   * unavailable.
   * @throws If availability cannot be determined.
   */
  isAvailable(): Promise<boolean>;
}
