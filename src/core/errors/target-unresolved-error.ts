/*
 * Provides the classified failure shared by commands when target policy
 * cannot select from the resolved configuration.
 */

import { AmbercastError } from './types.js';

/**
 * Reports an explicit target that is not configured or an implicit selection
 * that is not unambiguous.
 *
 * @remarks
 * A fixed kind lets generate, run, and check apply their established error
 * transport while treating target selection as caller-correctable input rather
 * than as an AI, browser, or filesystem execution failure. The common report
 * mapping exposes this kind as `TARGET_UNRESOLVED` with process exit 2.
 */
export class TargetUnresolvedError extends AmbercastError {
  readonly kind = 'target-unresolved' as const;
}
