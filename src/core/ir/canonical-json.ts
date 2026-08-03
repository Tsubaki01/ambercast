/**
 * Produces the two deterministic JSON representations used by IR artifacts
 * and their digests.
 *
 * Both representations share one value-walking core so recursive UTF-16
 * member ordering and scalar formatting cannot drift between reviewable
 * artifacts and their hash preimages. The eventual implementation guarantees
 * that numbers with magnitude at least 1e21, or with nonzero magnitude less
 * than 1e-6, use exponential form; every other finite number uses fixed
 * decimal form, matching native `Number.prototype.toString()` exactly.
 * Negative zero serializes as `"0"`, while `NaN`, positive infinity, and
 * negative infinity are rejected rather than silently serialized.
 *
 * Strings use the exact JCS escaping rules in both values and object member
 * names: backspace (`\b`), tab (`\t`), newline (`\n`), form feed (`\f`), and
 * carriage return (`\r`) use their short escapes; every other control
 * character in U+0000–U+001F uses a lowercase `\u00XX` escape; backslash and
 * quote are escaped; and every other character, including forward slash,
 * U+2028, and U+2029, is emitted raw and unescaped.
 * An unpaired UTF-16 surrogate anywhere in a string or object key is rejected
 * instead of being passed through.
 *
 * `toCanonicalDigestBytes` produces a compact form with zero inter-token
 * whitespace. `toCanonicalArtifactText` produces a distinct, deliberately
 * separate form with two-space pretty-printing; it retains identical key
 * ordering and scalar formatting so only presentation differs for readable
 * diffs.
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
