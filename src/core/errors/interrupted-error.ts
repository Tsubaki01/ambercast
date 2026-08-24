/*
 * Provides the classified run-environment failure for caller cancellation
 * that leaves at least one discovered scheduling unit incomplete.
 */

import { AmbercastError } from './types.js';

/**
 * Classifies caller cancellation that leaves a discovered batch incomplete.
 *
 * @remarks
 * Interruption is an environment-level run condition rather than a case
 * failure: completed case evidence remains authoritative, while the report
 * identifies unprocessed cases with evidence-free skipped rows. The error
 * therefore carries a fixed, path-free message and is serialized only at run
 * scope. Report builders append exactly one such run-scoped error for an
 * interrupted outcome. Its `interrupted` classification resolves to exit 3
 * through the central error-to-exit table, then participates in the shared
 * priority selector instead of replacing a higher-priority failure already
 * present in the batch.
 */
export class InterruptedError extends AmbercastError {
  readonly kind = 'interrupted';

  /** Creates the fixed, caller-independent interruption diagnostic. */
  constructor() {
    super('The command was interrupted before all discovered cases reached a terminal state.');
  }
}
