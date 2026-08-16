import { createHash } from 'node:crypto';
import {
  type AccessibilityNode,
  isSnapshotInvalid,
} from './aria-snapshot.js';
import { toCanonicalDigestBytes } from './canonical-json.js';
import type { AccessibilityElementRef, Fingerprint, JsonValueT } from './schema.js';

/**
 * Preserves the structural position of one role-and-name match while the
 * traversal still has direct access to its parent and child index.
 *
 * The index is part of the match evidence rather than a value recovered later.
 * Object-identity `parent.children.indexOf(match.node)` is correct for this
 * acyclic, freshly parsed tree, but repeats a linear scan for every match and
 * becomes quadratic when many nodes share a role and name. Capturing the
 * position during the single traversal preserves linear work in exactly those
 * ambiguity-heavy snapshots.
 */
type AccessibilityMatch = {
  readonly node: AccessibilityNode;
  readonly parent: AccessibilityNode;
  readonly index: number;
};

/**
 * Represents the stable identity contribution of one accessibility node.
 *
 * The fingerprint deliberately excludes descendants and other volatile node
 * data. Role and normalized accessible name are the smallest shared identity
 * shape that keeps the descriptor serializable and reviewable.
 */
type NodeIdentity = {
  readonly role: string;
  readonly name: string;
};

/**
 * Defines the frozen `a11y-neighborhood-v2` hash preimage.
 *
 * The descriptor retains only the target, its direct parent, and its immediate
 * siblings on either side. That bounded neighborhood detects local structural
 * drift without invalidating grounding for unrelated changes elsewhere in the
 * page tree.
 */
type AccessibilityFingerprintDescriptor = NodeIdentity & {
  readonly parent: NodeIdentity | null;
  readonly siblingBefore: NodeIdentity | null;
  readonly siblingAfter: NodeIdentity | null;
};

const UNPAIRED_SURROGATE_ERROR_MESSAGE = 'Cannot canonicalize a string with an unpaired surrogate.';

function isUnpairedSurrogateError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === UNPAIRED_SURROGATE_ERROR_MESSAGE;
}

/**
 * Checks that a JSON value has the complete recursive tree shape used by the
 * fingerprint traversal.
 *
 * The public boundary accepts general JSON because snapshots are serializable
 * data. Rejecting a malformed hand-constructed value as an absent match keeps
 * the matching operation total without pretending arbitrary JSON is an
 * accessibility node. Snapshot producers construct this tree top-down from
 * linear ARIA data, so it is acyclic by construction; this shape guard does
 * not claim to detect cycles in a manually fabricated object graph.
 */
function isAccessibilityNode(value: JsonValueT): value is AccessibilityNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const { role, name, children } = value;

  return typeof role === 'string'
    && typeof name === 'string'
    && Array.isArray(children)
    && children.every(isAccessibilityNode);
}

/**
 * Canonicalizes an accessible name for fingerprint matching and descriptors.
 *
 * @param name - The raw accessible name captured from a snapshot or authored
 *   in an accessibility reference.
 * @returns The name after Unicode NFC normalization, replacement of every
 *   nonempty ECMAScript `\s` run with one ASCII space (U+0020), and removal of
 *   leading and trailing ECMAScript whitespace.
 *
 * @remarks
 * Matching and hashing apply the same NFC normalization, whitespace-run
 * collapsing, and trimming, where `\s` uses the ECMAScript regular-expression
 * whitespace set (WhiteSpace and LineTerminator code points). Each maximal
 * matching run becomes one ASCII space before leading and trailing whitespace
 * is removed. This prevents a reference from failing solely because the two
 * inputs differ by Unicode composition or incidental whitespace that the
 * descriptor treats as equivalent. Roles remain exact strings: only accessible
 * names have this text-equivalence contract.
 */
function normalizeName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Collects every accessibility node whose role and normalized name match a
 * reference.
 *
 * @param tree - A validated synthetic-root accessibility tree.
 * @param ref - The authored accessibility locator to match.
 * @returns All matching physical nodes in depth-first pre-order, with their
 *   parent and index captured at discovery time.
 *
 * @remarks
 * Traversal starts at the synthetic root's children, never at the wrapper
 * itself. An authored `root` locator can therefore never resolve to parser
 * scaffolding when name normalization turns a whitespace-only reference into
 * an empty string. The single-pass traversal preserves source order and
 * records each index as it visits the parent, avoiding a later `indexOf`
 * lookup whose repeated scans become quadratic for duplicate-heavy trees.
 */
function findAllAccessibilityMatches(
  tree: AccessibilityNode,
  ref: AccessibilityElementRef,
): AccessibilityMatch[] {
  const matches: AccessibilityMatch[] = [];
  const normalizedReferenceName = normalizeName(ref.name);

  function visit(parent: AccessibilityNode): void {
    for (let index = 0; index < parent.children.length; index += 1) {
      const node = parent.children[index];

      if (node === undefined) {
        continue;
      }

      if (node.role === ref.role && normalizeName(node.name) === normalizedReferenceName) {
        matches.push({ node, parent, index });
      }

      visit(node);
    }
  }

  visit(tree);
  return matches;
}

/**
 * Builds the bounded neighborhood descriptor for one unambiguous match.
 *
 * @param match - A candidate whose parent and child position came from the
 *   matching traversal.
 * @returns The serializable `a11y-neighborhood-v2` descriptor for that node.
 *
 * @remarks
 * The descriptor contains normalized role-and-name identities for the target,
 * its direct parent, and only the immediately preceding and following
 * siblings. Missing neighbors are represented by `null`, which preserves edge
 * placement without inventing placeholder nodes. Capturing the index during
 * matching makes both sibling choices positional even when several nodes have
 * indistinguishable role and name values.
 */
function descriptorFor(match: AccessibilityMatch): AccessibilityFingerprintDescriptor {
  const identityFor = (node: AccessibilityNode): NodeIdentity => ({
    role: node.role,
    name: normalizeName(node.name),
  });
  const siblingBefore = match.index === 0 ? undefined : match.parent.children[match.index - 1];
  const siblingAfter = match.parent.children[match.index + 1];

  return {
    ...identityFor(match.node),
    parent: identityFor(match.parent),
    siblingBefore: siblingBefore === undefined ? null : identityFor(siblingBefore),
    siblingAfter: siblingAfter === undefined ? null : identityFor(siblingAfter),
  };
}

/**
 * Hashes one unambiguous accessibility match into its versioned fingerprint.
 *
 * The shared conversion keeps computation and resolution byte-identical while
 * retaining their distinct match-count classifications. An unpaired surrogate
 * has no canonical JSON byte representation, so it remains the one ordinary
 * no-fingerprint outcome; other canonicalization and hashing failures retain
 * their original propagation behavior.
 */
function hashMatch(match: AccessibilityMatch): Fingerprint | undefined {
  const descriptor = descriptorFor(match);
  let canonicalBytes: Uint8Array;

  try {
    canonicalBytes = toCanonicalDigestBytes(descriptor);
  } catch (error) {
    if (isUnpairedSurrogateError(error)) {
      return undefined;
    }

    throw error;
  }

  return {
    algorithm: 'a11y-neighborhood-v2',
    hash: createHash('sha256').update(canonicalBytes).digest('hex'),
  };
}

type ResolvedSecret = {
  readonly raw: string;
  readonly normalizedName: string;
};

function containsResolvedSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => value === secret || (secret.length >= 3 && value.includes(secret)));
}

function descriptorContainsResolvedSecret(
  descriptor: AccessibilityFingerprintDescriptor,
  resolvedSecrets: readonly ResolvedSecret[],
): boolean {
  const identities = [
    descriptor,
    descriptor.parent,
    descriptor.siblingBefore,
    descriptor.siblingAfter,
  ];
  const rawSecrets = resolvedSecrets.map(({ raw }) => raw);
  const normalizedNameSecrets = resolvedSecrets
    .map(({ normalizedName }) => normalizedName)
    .filter((secret) => secret.length > 0);

  return identities.some((identity) => identity !== null && (
    containsResolvedSecret(identity.role, rawSecrets)
    || containsResolvedSecret(identity.name, normalizedNameSecrets)
  ));
}

/**
 * Computes the versioned accessibility-neighborhood fingerprint for an
 * element reference.
 *
 * @param tree - The serializable accessibility tree captured from the page.
 * @param ref - The accessibility role and name that identify the target node.
 * @param resolvedSecretValues - Resolved secret-value sets. Only their values
 *   matter at this core boundary, so callers pass a values iterator without
 *   exposing secret-reference keys.
 * @returns An `ok` result with the fingerprint, `no-match` for malformed,
 *   absent, or unhashable evidence, `ambiguous-match` for duplicate locator
 *   candidates, `snapshot-invalid` for evidence rejected by the ARIA parser,
 *   or `secret-contaminated` when descriptor data contains a resolved secret.
 *
 * @remarks
 * The algorithm accepts exactly one normalized role-and-name match. It hashes
 * that node's order-preserving descriptor through `toCanonicalDigestBytes`
 * from `./canonical-json.js`, which emits compact canonical JSON encoded as
 * UTF-8 bytes. SHA-256 hashes those exact bytes; its lowercase hexadecimal
 * digest is recorded with the `a11y-neighborhood-v2` algorithm tag.
 * The descriptor includes normalized identities for the target, its parent,
 * and its immediately adjacent siblings; a first or last child records the
 * missing neighbor as `null`. The synthetic root contributes as the parent of
 * top-level page nodes but is never a match candidate itself.
 *
 * The classification keeps absence and ambiguity distinct. A full
 * neighborhood hash never chooses among duplicate role-and-name matches:
 * downstream role-and-name locators cannot retain which physical duplicate was
 * fingerprinted, so treating one duplicate as a confirmed target is unsound.
 *
 * Malformed values are ordinary non-matches rather than hashing errors. When
 * the hashing step catches the specific `RangeError` from
 * `toCanonicalDigestBytes` for an unpaired UTF-16 surrogate in a role or name
 * string, it returns `no-match`: that identity cannot be canonically hashed
 * and is an ordinary no-confident-fingerprint outcome, not a hashing error.
 * This catch provides a non-throwing outcome specifically for that documented
 * unpaired-surrogate case; other unexpected canonicalization or hashing
 * errors still propagate.
 *
 * Before hashing a unique descriptor, the function rejects resolved secrets
 * in its eight role/name fields. Role fields compare against raw secret text,
 * while name fields compare against each secret normalized by
 * {@link normalizeName}; this symmetry checks exactly the text that is
 * hashed and closes Unicode-composition and whitespace-normalization gaps.
 * Empty resolved-secret values are always skipped and never taint a
 * descriptor. Every nonempty exact match taints regardless of its length. A
 * substring match taints only when the secret comparison value has at least
 * three UTF-16 code units: the raw secret for a role field and the normalized
 * secret for a name field. The length threshold is therefore measured on the
 * same string used in that field's comparison, never on its unnormalized
 * counterpart.
 *
 * `resolvedSecretValues` may be a single-use iterable such as `Map.values()`.
 * The implementation must consume that iterable in exactly one pass,
 * materializing it once before checking multiple descriptor fields rather
 * than starting a new iteration for each field and missing later taint checks.
 */
export function computeAccessibilityFingerprint(
  tree: JsonValueT,
  ref: AccessibilityElementRef,
  resolvedSecretValues: Iterable<ReadonlySet<string>>,
):
  | { readonly kind: 'ok'; readonly fingerprint: Fingerprint }
  | { readonly kind: 'no-match' }
  | { readonly kind: 'ambiguous-match' }
  | { readonly kind: 'snapshot-invalid' }
  | { readonly kind: 'secret-contaminated' } {
  if (isSnapshotInvalid(tree)) {
    return { kind: 'snapshot-invalid' };
  }

  if (!isAccessibilityNode(tree)) {
    return { kind: 'no-match' };
  }

  const matches = findAllAccessibilityMatches(tree, ref);
  if (matches.length === 0) {
    return { kind: 'no-match' };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous-match' };
  }

  const match = matches[0];
  if (match === undefined) {
    return { kind: 'no-match' };
  }

  const resolvedSecrets: ResolvedSecret[] = [];
  for (const secretValues of resolvedSecretValues) {
    for (const raw of secretValues) {
      if (raw !== '') {
        resolvedSecrets.push({ raw, normalizedName: normalizeName(raw) });
      }
    }
  }

  if (descriptorContainsResolvedSecret(descriptorFor(match), resolvedSecrets)) {
    return { kind: 'secret-contaminated' };
  }

  const fingerprint = hashMatch(match);
  return fingerprint === undefined
    ? { kind: 'no-match' }
    : { kind: 'ok', fingerprint };
}

/**
 * Resolves a stored accessibility fingerprint against current snapshot
 * evidence.
 *
 * @param tree - The serializable accessibility tree captured from the page.
 * @param ref - The stored accessibility locator to resolve.
 * @param expected - The fingerprint recorded for that locator.
 * @returns `hit` when exactly one matching node hashes to `expected`,
 *   `fingerprint-mismatch` when one node exists but differs, `element-not-found`
 *   when no node exists or the tree is malformed, `ambiguous-match` when two
 *   or more nodes share the exact role and normalized name, or
 *   `snapshot-invalid` when the ARIA parser rejected the evidence.
 *
 * @remarks
 * This function shares the same exact-role, normalized-name matching and
 * descriptor construction as {@link computeAccessibilityFingerprint}. It
 * classifies the match count before any hash comparison: two or more matching
 * nodes always produce `ambiguous-match`, even when one candidate happens to
 * hash to `expected`.
 * A plain role-and-name browser locator can select a different duplicate from
 * the candidate whose neighborhood matched, so no hash can make that outcome
 * safe to honor. A malformed tree remains an ordinary `element-not-found`
 * result, while the parser's dedicated invalid marker remains distinct so
 * callers can explain that the captured evidence itself was untrusted.
 * If hashing catches the specific `RangeError` from
 * `toCanonicalDigestBytes` for an unpaired UTF-16 surrogate in a role or name
 * string, this function likewise returns `element-not-found`: that identity
 * cannot be canonically hashed and is an ordinary non-match, not a hashing
 * error. This catch provides an ordinary `element-not-found` result
 * specifically for that documented unpaired-surrogate case; other unexpected
 * canonicalization or hashing errors still propagate.
 *
 * This verification path intentionally has no resolved-secret parameter.
 * Secret taint guards fingerprint generation before a value can enter the
 * cache. Algorithm versioning rejects incompatible grounding documents before
 * live verification, so resolution receives fingerprints produced under the
 * same cache policy.
 */
export function resolveAccessibilityFingerprint(
  tree: JsonValueT,
  ref: AccessibilityElementRef,
  expected: Fingerprint,
): 'hit' | 'fingerprint-mismatch' | 'element-not-found' | 'ambiguous-match' | 'snapshot-invalid' {
  if (isSnapshotInvalid(tree)) {
    return 'snapshot-invalid';
  }

  if (!isAccessibilityNode(tree)) {
    return 'element-not-found';
  }

  const matches = findAllAccessibilityMatches(tree, ref);

  if (matches.length === 0) {
    return 'element-not-found';
  }

  if (matches.length > 1) {
    return 'ambiguous-match';
  }

  const match = matches[0];

  if (match === undefined) {
    return 'element-not-found';
  }

  const fingerprint = hashMatch(match);
  if (fingerprint === undefined) {
    return 'element-not-found';
  }

  return expected.algorithm === fingerprint.algorithm && expected.hash === fingerprint.hash
    ? 'hit'
    : 'fingerprint-mismatch';
}
