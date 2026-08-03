/**
 * Declares ambient-runtime dependencies that application logic receives
 * explicitly. Isolating these effects keeps deterministic IR work free of
 * direct process, clock, and entropy access.
 */
import type { StepId } from '#core/ir/schema.js';

/**
 * Supplies wall-clock and monotonic time without coupling callers to a host
 * clock.
 *
 * Time is a port because deterministic IR digest work must not call a clock
 * directly; the application can instead select a real or fixed source at its
 * composition boundary.
 */
export interface Clock {
  /**
   * Gets the current wall-clock instant.
   *
   * @returns A date representing the supplied current instant.
   */
  now(): Date;

  /**
   * Gets an elapsed-time reading suitable for duration comparisons.
   *
   * @returns A non-negative monotonically advancing millisecond value.
   */
  monotonicMs(): number;
}

/**
 * Supplies entropy without coupling callers to a process-global generator.
 *
 * Randomness is a port for the same reason as time: core IR digest logic must
 * remain deterministic and never obtain random values directly.
 */
export interface RandomSource {
  /**
   * Generates an RFC 4122-compatible unique identifier.
   *
   * @returns A newly supplied UUID string.
   */
  uuid(): string;

  /**
   * Generates a fractional value in the unit interval.
   *
   * @returns A value greater than or equal to zero and less than one.
   */
  float(): number;
}

/**
 * Resolves a named secret only at the boundary that needs its value.
 *
 * Keeping a missing secret distinct from an empty string lets callers decide
 * whether absence is an error without revealing a value in an IR artifact.
 */
export interface SecretsProvider {
  /**
   * Looks up a secret reference.
   *
   * @param ref - The name or reference understood by this provider.
   * @returns The secret value, or `undefined` when it is unavailable.
   */
  resolve(ref: string): string | undefined;
}

/**
 * Provides stable facts about the current execution environment.
 */
export interface EnvironmentInfo {
  /**
   * Reports whether the current execution runs under continuous integration.
   *
   * @returns `true` when CI-specific policy should apply.
   */
  isCI(): boolean;
}

/**
 * A minimal lifecycle event emitted while executing a run.
 *
 * The variants carry only the step identity and, for results, the resolution
 * path. This keeps the event boundary useful before consumers need richer
 * payloads while preserving additive evolution through a discriminator.
 */
export type RunEvent =
  | { readonly type: 'step-start'; readonly stepId: StepId }
  | {
      readonly type: 'step-result';
      readonly stepId: StepId;
      readonly via: 'grounding' | 'ai-resolve' | 'trace-replay';
    }
  | { readonly type: 'ai-call'; readonly stepId: StepId };

/**
 * Receives run lifecycle events without coupling execution to a reporting
 * transport such as a terminal or notification channel.
 */
export interface EventSink {
  /**
   * Publishes one well-formed run event.
   *
   * @param event - The lifecycle event to report.
   */
  emit(event: RunEvent): void;
}
