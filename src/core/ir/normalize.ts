/**
 * Normalizes Markdown source at the boundary before it contributes to plan
 * provenance.
 *
 * A prompt remains the source of truth, so normalization accepts only
 * representation differences introduced by text editors and checkouts. An
 * initial byte-order marker and platform line endings converge to one
 * representation; all Markdown content, including whitespace, remains
 * significant. Under-normalization makes a plan safely appear stale, whereas
 * broader cleanup could silently conceal a meaningful prompt change.
 */

/**
 * Marks Markdown whose representation is safe to use as a digest input.
 *
 * The brand preserves a compile-time boundary between source read from disk
 * and source prepared for provenance, without changing the runtime string.
 */
export type NormalizedTestMd = string & { readonly __brand: 'NormalizedTestMd' };

/**
 * Returns the minimally normalized representation of a test prompt.
 *
 * @param raw - The Markdown source exactly as it was read.
 * @returns The source with only representation-level encoding and newline
 * differences normalized for deterministic digesting.
 */
export function normalizeTestMd(raw: string): NormalizedTestMd {
  throw new Error('not implemented');
}
