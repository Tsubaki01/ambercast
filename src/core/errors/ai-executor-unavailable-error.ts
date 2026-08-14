/*
 * Provides the classified failure for an AI executor that cannot serve a
 * request, regardless of whether the binary is unreachable or unsupported.
 */

import { AmbercastError } from './types.js';

/**
 * Explains why an automatic provider-availability probe did not select a
 * provider.
 *
 * `not-found` means the probe's own deadline did not expire before
 * `isAvailable` resolved `false`; it does not verify that an executable is
 * missing. Providers also use that result for other unavailable conditions,
 * such as a non-zero version command or a spawn failure.
 */
export type AiProviderAvailabilityFailureReason = 'timeout' | 'not-found';

/**
 * Records one provider considered while resolving the automatic policy.
 *
 * The readonly shape gives resolver callers a stable diagnostic vocabulary
 * without narrowing the general-purpose details contract shared by all
 * Ambercast errors.
 */
export interface AiProviderAvailabilityAttempt {
  /** Provider whose availability probe completed without selecting it. */
  readonly provider: 'claude' | 'codex';

  /** Classification derived from that probe's individual deadline. */
  readonly reason: AiProviderAvailabilityFailureReason;
}

/**
 * Reports an AI executor that is unavailable for the requested operation.
 *
 * @remarks
 * Provider reachability and unavailable agentic capability share this kind so
 * command policy can distinguish an execution-environment failure from an
 * invalid provider response without depending on provider-specific messages.
 */
export class AiExecutorUnavailableError extends AmbercastError {
  readonly kind = 'ai-executor-unavailable' as const;
}
