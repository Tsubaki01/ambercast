/**
 * Normalizes Markdown source at the boundary before it contributes to plan
 * provenance.
 *
 * A prompt remains the source of truth, so normalization accepts only
 * representation differences introduced by text editors and checkouts. It
 * removes exactly one leading U+FEFF byte-order mark when present; it neither
 * removes a U+FEFF elsewhere nor removes a second leading U+FEFF. It converts
 * every CRLF sequence and every lone CR to one LF. Apart from that one
 * possible removal and those newline conversions, it preserves the input
 * byte-for-byte: no trimming, whitespace collapsing, or other transformation
 * of any kind occurs. Under-normalization makes a plan safely appear stale,
 * whereas broader cleanup could silently conceal a meaningful prompt change.
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
 * @returns The source after removing at most one leading U+FEFF and converting
 * CRLF and lone CR line endings to LF, with every other byte preserved.
 */
export function normalizeTestMd(raw: string): NormalizedTestMd {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n') as NormalizedTestMd;
}
