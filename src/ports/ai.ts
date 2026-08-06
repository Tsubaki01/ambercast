/**
 * Declares the AI boundary for structured generation calls and browser-led
 * agentic work.
 */
import type { JsonValueT } from '#core/ir/schema.js';

import type { BrowserSession, PerformableAction } from './browser.js';

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
 * This compile-time projection limits the controller contract to the browser
 * operations agentic execution needs. It does not remove other methods from a
 * runtime object; creating a runtime projection, if required, belongs to the
 * composition layer.
 */
export type AiActionController = Pick<
  BrowserSession,
  'perform' | 'evaluateAssert' | 'snapshotForResolution'
>;

/**
 * Inputs for an AI-directed browser interaction.
 */
export interface AiAgenticRequest {
  /** Instructions that guide the browser-directed interaction. */
  readonly instructionPrompt: string;

  /** Browser operations the adapter may direct while handling this request. */
  readonly controller: AiActionController;

  /** Materialized actions from earlier interaction, when they aid context. */
  readonly priorTrace?: readonly PerformableAction[];

  /** Cancellation signal forwarded to a provider that supports cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * The outcome of an AI-directed browser interaction and its performed trace.
 */
export interface AiAgenticResult {
  /**
   * Actions the controller actually performed during this call, in order.
   *
   * On a `failure` outcome this remains the true partial record through the
   * failure point; it never contains proposed, predicted, or hypothetical
   * completion actions.
   */
  readonly trace: readonly PerformableAction[];

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
 * execution controls a browser and produces a performed trace. Keeping them
 * as separate methods makes their incompatible call contracts explicit.
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
   * A completed call may return `outcome: 'failure'` with its partial,
   * actually performed trace; transport, cancellation, and execution errors
   * reject instead.
   *
   * @param request - Instructions, browser controller, and optional trace.
   * @returns The interaction outcome and actions actually performed.
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
