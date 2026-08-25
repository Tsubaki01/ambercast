/**
 * Preserves the two raw-artifact facts that both replay and check need to
 * enforce coverage integrity consistently.
 *
 * Replay deliberately collapses unusable grounding without a
 * current-provenance exact-path coverage claim into a recoverable cache miss,
 * while a current-provenance coverage claim with a structural or canonical
 * violation is an integrity failure. Check must still report missing, stale,
 * and invalid artifacts separately, so neither use case can own the shared
 * decision without importing the other's outcome vocabulary. This narrow
 * core/IR primitive instead recognizes the exact raw claim and verifies the
 * parsed document's canonical representation, without acquiring storage, AI,
 * browser, or write-capable dependencies.
 */

import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import type { GroundingDocument as GroundingDocumentType, JsonValueT } from '#core/ir/schema.js';

type RawJsonNode =
  | { readonly kind: 'object'; readonly entries: readonly (readonly [string, RawJsonNode])[] }
  | { readonly kind: 'array'; readonly items: readonly RawJsonNode[] }
  | { readonly kind: 'scalar' };

/**
 * Parses JSON without collapsing repeated object members.
 *
 * JSON.parse remains the runtime schema input, while this narrow reader keeps
 * every raw member occurrence long enough to recognize an exact-path coverage
 * claim that a later duplicate key could otherwise hide. It assigns no trust
 * to values and exposes only object structure needed by the staged loader.
 */
class DuplicatePreservingJsonReader {
  #offset = 0;

  constructor(private readonly source: string) {}

  parse(): RawJsonNode {
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#offset !== this.source.length) throw new SyntaxError('Unexpected trailing JSON data.');
    return value;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.source[this.#offset] ?? '')) this.#offset += 1;
  }

  #parseValue(): RawJsonNode {
    this.#skipWhitespace();
    switch (this.source[this.#offset]) {
      case '{':
        return this.#parseObject();
      case '[':
        return this.#parseArray();
      case '"':
        this.#parseString();
        return { kind: 'scalar' };
      default:
        this.#parseScalar();
        return { kind: 'scalar' };
    }
  }

  #parseObject(): RawJsonNode {
    this.#offset += 1;
    const entries: Array<readonly [string, RawJsonNode]> = [];
    this.#skipWhitespace();
    if (this.source[this.#offset] === '}') {
      this.#offset += 1;
      return { kind: 'object', entries };
    }
    while (true) {
      this.#skipWhitespace();
      const key = this.#parseString();
      this.#skipWhitespace();
      if (this.source[this.#offset] !== ':') throw new SyntaxError('Expected a JSON member separator.');
      this.#offset += 1;
      entries.push([key, this.#parseValue()]);
      this.#skipWhitespace();
      const delimiter = this.source[this.#offset];
      if (delimiter === '}') {
        this.#offset += 1;
        return { kind: 'object', entries };
      }
      if (delimiter !== ',') throw new SyntaxError('Expected another JSON object member.');
      this.#offset += 1;
    }
  }

  #parseArray(): RawJsonNode {
    this.#offset += 1;
    const items: RawJsonNode[] = [];
    this.#skipWhitespace();
    if (this.source[this.#offset] === ']') {
      this.#offset += 1;
      return { kind: 'array', items };
    }
    while (true) {
      items.push(this.#parseValue());
      this.#skipWhitespace();
      const delimiter = this.source[this.#offset];
      if (delimiter === ']') {
        this.#offset += 1;
        return { kind: 'array', items };
      }
      if (delimiter !== ',') throw new SyntaxError('Expected another JSON array item.');
      this.#offset += 1;
    }
  }

  #parseString(): string {
    const start = this.#offset;
    if (this.source[this.#offset] !== '"') throw new SyntaxError('Expected a JSON string.');
    this.#offset += 1;
    while (this.#offset < this.source.length) {
      const character = this.source[this.#offset];
      if (character === '\\') {
        this.#offset += 2;
        continue;
      }
      this.#offset += 1;
      if (character === '"') {
        return JSON.parse(this.source.slice(start, this.#offset)) as string;
      }
    }
    throw new SyntaxError('Unterminated JSON string.');
  }

  #parseScalar(): void {
    const start = this.#offset;
    while (this.#offset < this.source.length && !/[\s,\]}]/u.test(this.source[this.#offset]!)) {
      this.#offset += 1;
    }
    if (start === this.#offset) throw new SyntaxError('Expected a JSON value.');
    JSON.parse(this.source.slice(start, this.#offset));
  }
}

/**
 * Determines whether raw grounding contains an exact-path verification
 * coverage claim.
 *
 * @param sourceText - Exact grounding artifact bytes to inspect.
 * @returns Whether any raw member occurs at
 * `entries.<key>.trace.verificationCoverage`.
 * @throws {SyntaxError} If `sourceText` is not accepted by the
 * duplicate-preserving JSON reader.
 *
 * @remarks
 * JSON.parse remains the schema input, while this scan retains every object
 * member occurrence so a later duplicate cannot hide a claim. It deliberately
 * recognizes only the exact path and assigns no validity or trust to the
 * surrounding values; schema validation remains the caller's separate gate.
 */
export function rawGroundingHasCoverageClaim(sourceText: string): boolean {
  const root = new DuplicatePreservingJsonReader(sourceText).parse();
  if (root.kind !== 'object') return false;
  for (const [rootKey, entries] of root.entries) {
    if (rootKey !== 'entries' || entries.kind !== 'object') continue;
    for (const [, entry] of entries.entries) {
      if (entry.kind !== 'object') continue;
      for (const [entryKey, trace] of entry.entries) {
        if (entryKey !== 'trace' || trace.kind !== 'object') continue;
        if (trace.entries.some(([traceKey]) => traceKey === 'verificationCoverage')) return true;
      }
    }
  }
  return false;
}

/**
 * Determines whether a coverage-claim-bearing grounding artifact has its
 * parsed document's canonical bytes.
 *
 * @param sourceText - Exact grounding artifact bytes to compare.
 * @param parsedDocument - Schema-validated grounding document represented by
 * those bytes.
 * @returns `true` only when canonical serialization equals `sourceText`;
 * returns `false` for a byte mismatch or a canonicalization failure.
 * @throws Never throws. Canonicalization failures are converted to `false`.
 *
 * @remarks
 * A coverage claim needs one unconditionally safe canonicality primitive at
 * both call sites. Treating a serialization exception as invalid rather than
 * allowing each caller to classify it independently preserves the fail-closed
 * provenance boundary and prevents replay and check from drifting apart.
 */
export function isGroundingCanonicalForClaim(
  sourceText: string,
  parsedDocument: GroundingDocumentType,
): boolean {
  try {
    return toCanonicalArtifactText(parsedDocument as unknown as JsonValueT) === sourceText;
  } catch {
    return false;
  }
}
