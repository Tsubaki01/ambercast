/**
 * Composes per-request AI deadlines without conflating them with caller
 * cancellation.
 *
 * A timeout signal is freshly created for each provider request because a
 * request must receive its whole caller-supplied budget instead of inheriting
 * elapsed time or abort state from earlier work. This module accepts that
 * budget directly rather than reading application configuration, so use
 * cases and runtime probes can apply their distinct policies through one
 * cancellation contract.
 *
 * `AbortSignal.any()` always wraps the timeout signal, including when there
 * is no caller signal. The resulting provider signal is therefore distinct
 * from both the call's timeout signal and any raw caller signal, while still
 * forwarding the winning source's exact reason. This identity boundary lets
 * callers distinguish a local deadline from a caller-provided error with the
 * same `DOMException` name.
 */
export interface AiDeadline {
  /** Signal supplied to the provider, composed from caller cancellation and this call's deadline. */
  readonly signal: AbortSignal;

  /** Fresh timeout signal retained only for deadline-expiry attribution. */
  readonly timeoutSignal: AbortSignal;
}

/**
 * Creates a new provider signal and retains the fresh timeout that participates
 * in it.
 *
 * @param callerSignal - Optional caller cancellation forwarded to the provider.
 * @param timeoutMs - Budget for this individual provider request.
 * @returns A distinct composite signal and the timeout signal used to create it.
 */
export function composeAiDeadline(callerSignal: AbortSignal | undefined, timeoutMs: number): AiDeadline {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any(callerSignal === undefined ? [timeoutSignal] : [callerSignal, timeoutSignal]),
    timeoutSignal,
  };
}

/**
 * Reports whether this deadline's own timeout elapsed.
 *
 * The availability probe receives only a boolean from `isAvailable`, which
 * deliberately swallows its internal failure and exposes no reason to compare.
 * Keeping expiry available separately lets that probe use the same timeout
 * predicate as identity-aware provider calls without inventing parallel
 * classification rules.
 *
 * @param deadline - Deadline whose local timeout is inspected.
 * @returns Whether the deadline's timeout signal has aborted.
 */
export function hasAiDeadlineExpired(deadline: AiDeadline): boolean {
  return deadline.timeoutSignal.aborted;
}

/**
 * Determines whether an error is this deadline's own timeout failure.
 *
 * Error identity is required because matching a `DOMException` name would
 * misclassify an unrelated upstream or caller error that merely looks like a
 * timeout. A timeout must have expired and supplied its exact reason.
 *
 * @param deadline - Deadline that owns the timeout reason.
 * @param error - Rejection value returned by the provider boundary.
 * @returns Whether the rejection is this deadline's timeout reason.
 */
export function isAiDeadlineTimeout(deadline: AiDeadline, error: unknown): boolean {
  return hasAiDeadlineExpired(deadline) && error === deadline.timeoutSignal.reason;
}
