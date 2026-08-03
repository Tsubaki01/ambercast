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
import { Buffer } from 'node:buffer';
import type { JsonValueT } from './schema.js';

type CanonicalForm = 'artifact' | 'digest';

const UNPAIRED_SURROGATE_ERROR = 'Cannot canonicalize a string with an unpaired surrogate.';

function escapeJsonString(value: string): string {
  let escaped = '"';

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const followingCodeUnit = value.charCodeAt(index + 1);

      if (!(followingCodeUnit >= 0xDC00 && followingCodeUnit <= 0xDFFF)) {
        throw new RangeError(UNPAIRED_SURROGATE_ERROR);
      }

      escaped += value.charAt(index) + value.charAt(index + 1);
      index += 1;
      continue;
    }

    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      throw new RangeError(UNPAIRED_SURROGATE_ERROR);
    }

    switch (codeUnit) {
      case 0x08:
        escaped += '\\b';
        break;
      case 0x09:
        escaped += '\\t';
        break;
      case 0x0A:
        escaped += '\\n';
        break;
      case 0x0C:
        escaped += '\\f';
        break;
      case 0x0D:
        escaped += '\\r';
        break;
      case 0x22:
        escaped += '\\"';
        break;
      case 0x5C:
        escaped += '\\\\';
        break;
      default:
        escaped += codeUnit <= 0x1F
          ? `\\u00${codeUnit.toString(16).padStart(2, '0')}`
          : value.charAt(index);
    }
  }

  return `${escaped}"`;
}

function renderCanonicalValue(value: unknown, form: CanonicalForm, depth = 0): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
      return escapeJsonString(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new RangeError('Cannot canonicalize a non-finite number.');
      }

      return value.toString();
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Cannot canonicalize a ${typeof value} value.`);
    case 'object':
      return Array.isArray(value)
        ? renderCanonicalArray(value, form, depth)
        : renderCanonicalObject(value, form, depth);
    default:
      throw new TypeError('Cannot canonicalize an unsupported value.');
  }
}

function renderCanonicalArray(value: readonly unknown[], form: CanonicalForm, depth: number): string {
  if (value.length === 0) {
    return '[]';
  }

  if (form === 'digest') {
    return `[${Array.from(value, (item) => renderCanonicalValue(item, form)).join(',')}]`;
  }

  const memberIndent = '  '.repeat(depth + 1);
  const closingIndent = '  '.repeat(depth);
  const members = Array.from(value, (item) => `${memberIndent}${renderCanonicalValue(item, form, depth + 1)}`)
    .join(',\n');

  return `[\n${members}\n${closingIndent}]`;
}

function renderCanonicalObject(
  value: object,
  form: CanonicalForm,
  depth: number,
): string {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  if (keys.length === 0) {
    return '{}';
  }

  if (form === 'digest') {
    return `{${keys.map((key) => `${escapeJsonString(key)}:${renderCanonicalValue(record[key], form)}`).join(',')}}`;
  }

  const memberIndent = '  '.repeat(depth + 1);
  const closingIndent = '  '.repeat(depth);
  const members = keys
    .map((key) => `${memberIndent}${escapeJsonString(key)}: ${renderCanonicalValue(record[key], form, depth + 1)}`)
    .join(',\n');

  return `{\n${members}\n${closingIndent}}`;
}

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
  return Buffer.from(renderCanonicalValue(value, 'digest'), 'utf8');
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
  return `${renderCanonicalValue(value, 'artifact')}\n`;
}
