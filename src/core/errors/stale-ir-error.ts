/*
 * Provides the classified trust failure for generated artifacts whose
 * provenance no longer represents the test inputs selected for replay.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a valid plan whose provenance no longer matches its current test inputs.
 *
 * @remarks
 * This error applies when a plan or grounding artifact exists and parses, but
 * its `inputsDigest` no longer matches the current test Markdown, schema, or
 * generator fingerprint. It is valid-shaped but out of date, so replay fails
 * closed rather than silently trusting assertions the source prompt no longer
 * describes and producing a wrong pass. That provenance failure is distinct
 * from an integrity violation, where malformed content or references cannot
 * be trusted as authored in the first place.
 */
export class StaleIrError extends AmbercastError {
  readonly kind = 'stale-ir' as const;
}
