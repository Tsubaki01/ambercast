/*
 * Provides the classified failure for a replay action whose secret reference
 * cannot be materialized at the execution boundary.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a replay action whose referenced secret cannot be resolved.
 *
 * @remarks
 * Only a secret reference, never its resolved value, reaches this boundary.
 * This error therefore reports that the referenced value is unavailable, such
 * as when its environment variable is missing. Failing closed instead of
 * substituting an empty string or skipping the step prevents a test from
 * silently running with the wrong credential and producing a misleading pass
 * or failure.
 */
export class SecretUnresolvedError extends AmbercastError {
  readonly kind = 'secret-unresolved' as const;
}
