/**
 * Declares the AI boundary for structured compilation calls and browser-led
 * agentic work. The two interaction modes have deliberately different
 * contracts so adapters cannot blur a deterministic response request with
 * iterative browser control.
 */
import type { JsonValueT } from '#core/ir/schema.js';

import type { BrowserSession, PerformableAction } from './browser.js';

/**
 * An opaque response schema supplied to an AI adapter.
 *
 * The port transports this data but does not interpret JSON Schema itself, so
 * a small record is sufficient and avoids coupling the port to zod's schema
 * implementation types.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Token use reported by an AI provider when available.
 */
export interface AiUsage {
  /**
   * Tokens accepted as input by the provider.
   */
  readonly inputTokens?: number;

  /**
   * Tokens emitted as output by the provider.
   */
  readonly outputTokens?: number;
}

/**
 * The input to one schema-constrained AI response request.
 */
export interface AiExecuteRequest {
  /**
   * The complete instruction sent to the provider.
   */
  readonly prompt: string;

  /**
   * The schema the adapter uses to validate the response.
   */
  readonly responseSchema: JsonSchema;

  /**
   * Optional serializable context retained with the request.
   */
  readonly context?: JsonValueT;

  /**
   * Cancellation signal forwarded to the provider when it supports one.
   */
  readonly signal?: AbortSignal;
}

/**
 * A validated result from one schema-constrained AI response request.
 *
 * @typeParam T - The validated response value.
 */
export interface AiExecuteResult<T> {
  /**
   * The response after adapter validation.
   */
  readonly data: T;

  /**
   * The unparsed provider response retained for diagnostics.
   */
  readonly raw: string;

  /**
   * Provider-reported token use, when the provider supplies it.
   */
  readonly usage?: AiUsage;
}

/**
 * The browser operations an agentic AI call may direct.
 *
 * This compile-time projection excludes the rest of `BrowserSession`, keeping
 * an AI adapter from depending on another port's raw object or unrelated
 * lifecycle and capture capabilities.
 */
export type AiActionController = Pick<
  BrowserSession,
  'perform' | 'evaluateAssert' | 'snapshotForResolution'
>;

/**
 * The input to an AI-directed browser interaction.
 */
export interface AiAgenticRequest {
  /**
   * The instruction that guides the browser-directed interaction.
   */
  readonly instructionPrompt: string;

  /**
   * The narrowly scoped browser control surface available to the AI adapter.
   */
  readonly controller: AiActionController;

  /**
   * Prior materialized actions that provide optional interaction context.
   */
  readonly priorTrace?: readonly PerformableAction[];

  /**
   * Cancellation signal forwarded to the provider when it supports one.
   */
  readonly signal?: AbortSignal;
}

/**
 * The outcome and trace produced by an AI-directed browser interaction.
 */
export interface AiAgenticResult {
  /**
   * The materialized actions performed or proposed during the interaction.
   */
  readonly trace: readonly PerformableAction[];

  /**
   * Whether the agentic interaction reached its requested outcome.
   */
  readonly outcome: 'success' | 'failure';

  /**
   * Provider-reported token use, when the provider supplies it.
   */
  readonly usage?: AiUsage;
}

/**
 * An AI implementation capable of structured and browser-directed work.
 *
 * `execute` and `executeAgentic` stay separate because their control models
 * differ fundamentally: one returns a schema-validated response, while the
 * other receives a browser controller and produces an interaction trace. A
 * single generic method would hide that boundary and make incompatible call
 * contracts easier to conflate.
 */
export interface AiExecutor {
  /**
   * The supported command-line provider implementation.
   */
  readonly name: 'claude-code-cli' | 'codex-cli';

  /**
   * Obtains and validates one structured response.
   *
   * @typeParam T - The caller-asserted expected response type.
   * @param request - The prompt, response schema, and optional context.
   * @returns The validated result and optional provider usage.
   */
  execute<T>(request: AiExecuteRequest): Promise<AiExecuteResult<T>>;

  /**
   * Performs an AI-directed interaction through the supplied controller.
   *
   * @param request - The instruction, controller, and optional prior trace.
   * @returns The resulting action trace and success state.
   */
  executeAgentic(request: AiAgenticRequest): Promise<AiAgenticResult>;

  /**
   * Reports whether this implementation can currently accept requests.
   *
   * @returns `true` when the executor is available for use.
   */
  isAvailable(): Promise<boolean>;
}
