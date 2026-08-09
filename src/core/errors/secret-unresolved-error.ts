import { AmbercastError } from './types.js';

/** Reports a replay action whose referenced secret cannot be resolved. */
export class SecretUnresolvedError extends AmbercastError {
  readonly kind = 'secret-unresolved' as const;
}
