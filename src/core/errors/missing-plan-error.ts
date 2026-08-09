/*
 * Provides the classified distinction between an absent generated plan and
 * generated artifacts that exist but cannot be trusted for replay.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a replay attempt whose generated plan artifact is absent.
 *
 * @remarks
 * An absent artifact means generation has not run yet, so the caller can
 * direct the author to run generate first. That action differs from an
 * existing artifact that is stale or violates integrity, which needs the
 * caller to refresh or investigate an untrustworthy artifact instead. Keeping
 * this absence separate lets reports offer the actionable recovery without
 * conflating it with other plan-trust failures.
 */
export class MissingPlanError extends AmbercastError {
  readonly kind = 'missing-plan' as const;
}
