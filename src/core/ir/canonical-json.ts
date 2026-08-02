/**
 * Produces the two deterministic JSON representations used by IR artifacts
 * and their digests.
 *
 * Both representations share one value-walking core so recursive UTF-16
 * member ordering, ECMAScript number rendering, and RFC 8785 string escaping
 * cannot drift between reviewable artifacts and their hash preimages. They
 * remain separate outputs because JCS requires compact JSON with no
 * inter-token whitespace, while committed artifacts need stable indentation
 * and line breaks for readable diffs.
 */
import type { JsonValueT } from './schema.js';

/**
 * Encodes a JSON value as compact RFC 8785 canonical JSON bytes for hashing.
 *
 * @param value - A serializable value whose complete contents participate in
 * the digest preimage.
 * @returns UTF-8 bytes with JCS-compatible canonical formatting.
 * @throws {RangeError} If a number or UTF-16 string cannot represent an
 * unambiguous canonical JSON value.
 */
export function toCanonicalDigestBytes(value: JsonValueT): Uint8Array {
  throw new Error('not implemented');
}

/**
 * Renders a JSON value in the canonical text form committed as an IR artifact.
 *
 * @param value - A serializable value whose order and scalar formatting must
 * match its digest representation.
 * @returns A two-space-indented, newline-terminated JSON document that keeps
 * semantically identical artifacts byte-stable and reviewable.
 * @throws {RangeError} If a number or UTF-16 string cannot represent an
 * unambiguous canonical JSON value.
 */
export function toCanonicalArtifactText(value: JsonValueT): string {
  throw new Error('not implemented');
}
