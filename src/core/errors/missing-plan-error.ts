import { AmbercastError } from './types.js';

/** Reports a replay attempt whose generated plan artifact is absent. */
export class MissingPlanError extends AmbercastError {
  readonly kind = 'missing-plan' as const;
}
