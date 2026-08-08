/*
 * Provides the classified failure used when generation cannot select a named
 * target from the resolved configuration.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a requested or implied target that the resolved configuration lacks.
 *
 * @remarks
 * A fixed kind lets command handling treat target selection as caller-
 * correctable input rather than as an AI or filesystem execution failure.
 */
export class TargetUnresolvedError extends AmbercastError {
  readonly kind = 'target-unresolved' as const;
}
