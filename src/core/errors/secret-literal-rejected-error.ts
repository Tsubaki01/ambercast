/*
 * Provides the classified failure raised when a generated artifact carries a
 * literal secret instead of a permitted secret reference.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a generated plan that violates the literal-secret safety policy.
 *
 * @remarks
 * Keeping this classification separate from secret lookup failure preserves
 * the distinction between rejecting unsafe committed data and resolving a
 * valid reference at an execution boundary.
 */
export class SecretLiteralRejectedError extends AmbercastError {
  readonly kind = 'secret-literal-rejected' as const;
}
