/*
 * Provides the classified failure raised when a generated artifact uses a
 * secret reference that the test prompt does not declare.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a generated plan that uses an undeclared secret reference.
 *
 * @remarks
 * Keeping this classification separate from secret lookup failure preserves
 * the distinction between rejecting unauthorized plan usage and resolving a
 * declared reference at an execution boundary.
 *
 * Its structured details object has exactly two keys: `secretRef`, the
 * ungrounded reference string, and `stepId`, the `id` field of the plan step
 * where that reference was found.
 */
export class SecretRefUndeclaredError extends AmbercastError {
  readonly kind = 'secret-ref-undeclared' as const;
}
