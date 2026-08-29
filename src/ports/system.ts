/**
 * Declares ambient-runtime dependencies that application logic receives
 * explicitly.
 */
import type { StepId } from '#core/ir/schema.js';

/**
 * Explains why Stage 2 declined a single-step repair candidate.
 *
 * The closed vocabulary keeps reports and event consumers aligned with the
 * repair boundary. Its evaluation order prioritizes cancellation,
 * then provider failures before local response-shape checks, and proceeds
 * through the remaining validation boundaries to a lack of replay progress.
 * An `AiResponseInvalidError` originates at the executor and is therefore a
 * provider error; `response-shape` is reserved for Stage 2's defensive
 * safe-parse or replacement-count check after the executor returned a value.
 */
export type StageTwoRejectionReason =
  | 'provider-error'
  | 'response-shape'
  | 'id-mismatch'
  | 'secret-attribution'
  | 'coverage-invalid'
  | 'obligation-mismatch'
  | 'literal-secret'
  | 'no-advance';

/**
 * Supplies wall-clock instants and elapsed-time readings.
 *
 * @remarks
 * Receiving time through a port keeps deterministic IR work free of direct
 * host-clock access and lets composition select a real or fixed source.
 */
export interface Clock {
  /**
   * Returns the current wall-clock instant.
   *
   * @returns A `Date` representing the supplied current instant.
   */
  now(): Date;

  /**
   * Returns a non-decreasing millisecond reading for duration comparisons.
   *
   * This value is not a wall-clock timestamp.
   *
   * @returns A monotonic elapsed-time value in milliseconds.
   */
  monotonicMs(): number;
}

/**
 * Supplies UUIDs and fractional random values.
 *
 * @remarks
 * Receiving randomness through a port keeps deterministic IR work free of a
 * process-global generator and lets tests provide fixed values.
 */
export interface RandomSource {
  /**
   * Generates an RFC 4122-compatible UUID.
   *
   * @returns A UUID string for a new caller-owned identifier.
   */
  uuid(): string;

  /**
   * Generates a fractional random value in the unit interval.
   *
   * @returns A value greater than or equal to zero and less than one.
   */
  float(): number;
}

/**
 * Resolves a named secret only at the boundary that needs its value.
 *
 * @remarks
 * Returning absence separately from an empty string lets callers apply their
 * own missing-secret policy without placing a secret value in an IR artifact.
 */
export interface SecretsProvider {
  /**
   * Looks up a secret reference.
   *
   * @param ref - The name or reference understood by this provider.
   * @returns The secret value, or `undefined` when no value is available.
   */
  resolve(ref: string): string | undefined;
}

/**
 * Provides stable facts about the execution environment for policy decisions.
 */
export interface EnvironmentInfo {
  /**
   * Determines whether continuous-integration policy should apply.
   *
   * @returns `true` when the current execution is running in CI.
   */
  isCI(): boolean;
}

/**
 * A lifecycle event emitted while a use case generates or replays a plan.
 *
 * @remarks
 * Replay events always identify the affected step. A generation-wide provider
 * invocation happens before a plan supplies any step identity, so its
 * `ai-call` event may omit `stepId`. The variants intentionally carry only
 * that available identity and, for results, the resolution path, keeping the
 * reporting boundary narrow while allowing richer payloads when needed. A
 * rejected Stage 2 candidate is emitted only after its overlay snapshot is
 * restored, once per normal rejection; interruption is not a rejection event.
 */
export type RunEvent =
  | { readonly type: 'step-start'; readonly stepId: StepId }
  | {
      readonly type: 'step-result';
      readonly stepId: StepId;
      readonly via: 'grounding' | 'ai-resolve' | 'trace-replay';
    }
  | { readonly type: 'ai-call'; readonly stepId?: StepId }
  | {
      readonly type: 'heal-stage2-rejected';
      readonly stepId: StepId;
      readonly reason: StageTwoRejectionReason;
    };

/**
 * Receives use-case lifecycle events without coupling generation or replay to
 * a reporting transport.
 */
export interface EventSink {
  /**
   * Delivers one well-formed use-case lifecycle event to this sink.
   *
   * Events are delivered in emission order. Repeated or identical events are
   * retained as separate deliveries, and this method never throws for a
   * well-formed {@link RunEvent}.
   *
   * @param event - The event to deliver.
   *
   * @remarks
   * A sink that might fail must swallow the failure or queue work internally;
   * reporting must not interrupt the use case that emits these events.
   */
  emit(event: RunEvent): void;
}
