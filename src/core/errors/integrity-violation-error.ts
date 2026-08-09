import { AmbercastError } from './types.js';

/** Reports a plan artifact that is invalid or non-canonical and cannot be trusted. */
export class IntegrityViolationError extends AmbercastError {
  readonly kind = 'integrity-violation' as const;
}
