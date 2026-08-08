/*
 * Provides the classified failure for an AI executor that cannot serve a
 * request, regardless of whether the binary is unreachable or unsupported.
 */

import { AmbercastError } from './types.js';

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
