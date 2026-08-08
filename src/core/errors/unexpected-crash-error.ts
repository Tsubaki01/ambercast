/*
 * Provides the classified fallback for failures that escape an expected
 * command boundary without a more specific Ambercast error kind.
 */

import { AmbercastError } from './types.js';

/**
 * Reports an unexpected command-boundary failure.
 *
 * @remarks
 * This fixed kind preserves the documented exit-code contract when an
 * unclassified dependency failure reaches runtime composition.
 */
export class UnexpectedCrashError extends AmbercastError {
  readonly kind = 'unexpected-crash' as const;
}
