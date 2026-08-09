import { AmbercastError } from './types.js';

/** Reports a valid plan whose provenance no longer matches its current test inputs. */
export class StaleIrError extends AmbercastError {
  readonly kind = 'stale-ir' as const;
}
