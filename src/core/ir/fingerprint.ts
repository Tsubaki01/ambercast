import { createHash } from 'node:crypto';
import { toCanonicalDigestBytes } from './canonical-json.js';
import type { AccessibilityElementRef, Fingerprint, JsonValueT } from './schema.js';

type AccessibilityNode = {
  readonly role: string;
  readonly name: string;
  readonly children: AccessibilityNode[];
};

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
 * Defines the frozen `a11y-neighborhood-v1` hash preimage.
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
 * Counts the physical accessibility nodes that match a locator.
 *
 * @param tree - The serializable accessibility tree captured from the page.
 * @param ref - The accessibility role and name to match.
 * @returns The number of normalized role-and-name matches, or `undefined`
 *   when the tree is malformed.
 *
 * @remarks
 * This exposes match-count evidence without exposing the traversal's internal
 * node and position records. Callers that cannot compute a fingerprint can
 * use it to distinguish no local target from duplicate local targets while
 * preserving malformed evidence as a separate condition.
 */
export function countAccessibilityMatches(
  tree: JsonValueT,
  ref: AccessibilityElementRef,
): number | undefined {
  return isAccessibilityNode(tree) ? findAllAccessibilityMatches(tree, ref).length : undefined;
}

/**
 * Builds the bounded neighborhood descriptor for one unambiguous match.
 *
 * @param match - A candidate whose parent and child position came from the
 *   matching traversal.
 * @returns The serializable `a11y-neighborhood-v1` descriptor for that node.
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
    algorithm: 'a11y-neighborhood-v1',
    hash: createHash('sha256').update(canonicalBytes).digest('hex'),
  };
}

/**
 * Parses a Playwright ARIA snapshot into a serializable, single-rooted
 * accessibility tree.
 *
 * @param yaml - The string returned by Playwright's `ariaSnapshot()` API.
 * @returns A tree of role, name, and child values wrapped in a synthetic root.
 *
 * @remarks
 * The outline regex captures only a matched leading dash marker's
 * indentation, its role token, and an optional quoted name. Any remaining
 * trailing content on that matched line is outside both identity captures and
 * is always discarded uniformly: bracketed attributes with or without a
 * value, a trailing structural colon, and every other suffix do not affect a
 * node's identity. Within a quoted name, an escaped quote represents a
 * literal quote and an escaped backslash represents a literal backslash.
 *
 * A line that does not match the leading `- ` outline marker is skipped,
 * contributes no node, and does not stop parsing later lines. A matched
 * `/key: value` metadata line is also skipped: its slash-prefixed role token
 * identifies link metadata rather than an accessibility node, so it must not
 * alter the indentation stack or any node's neighborhood. Malformed input
 * never throws.
 *
 * Indentation uses two-space units, so a line's depth is its indentation
 * length divided by two. A stack builds parent/child edges by popping entries
 * whose depth is greater than or equal to the current line's depth, then
 * placing the new node beneath the remaining stack top or the synthetic root
 * when the stack is empty. This makes the capture format an explicit, pure
 * boundary rather than a Playwright dependency in the fingerprinting
 * algorithm.
 *
 * Every top-level item is placed beneath one synthetic
 * `{ role: 'root', name: '', children: [] }` root, so snapshots with several
 * top-level entries still provide a single tree to later consumers.
 */
export function parseAriaSnapshot(yaml: string): JsonValueT {
  const root: AccessibilityNode = { role: 'root', name: '', children: [] };
  const stack: Array<{ readonly node: AccessibilityNode; readonly depth: number }> = [];
  const outlinePattern = /^(\s*)-\s+([^\s:]+)(?::(?=\s*$))?(?:\s+"((?:[^"\\]|\\.)*)")?/;

  for (const line of yaml.split(/\r?\n/)) {
    const match = outlinePattern.exec(line);

    if (match === null) {
      continue;
    }

    const indentation = match[1];
    const role = match[2];
    const capturedName = match[3];

    if (indentation === undefined || role === undefined) {
      continue;
    }

    if (role.startsWith('/')) {
      continue;
    }

    const node: AccessibilityNode = {
      role,
      name: capturedName?.replace(/\\(["\\])/g, '$1') ?? '',
      children: [],
    };
    const depth = indentation.length / 2;

    while (true) {
      const previous = stack.at(-1);

      if (previous === undefined || previous.depth < depth) {
        break;
      }

      stack.pop();
    }

    (stack.at(-1)?.node ?? root).children.push(node);
    stack.push({ node, depth });
  }

  return root;
}

/**
 * Computes the versioned accessibility-neighborhood fingerprint for an
 * element reference.
 *
 * @param tree - The serializable accessibility tree captured from the page.
 * @param ref - The accessibility role and name that identify the target node.
 * @returns The `a11y-neighborhood-v1` fingerprint, or `undefined` when the
 *   tree is malformed, the reference has no matching node, or multiple
 *   physical nodes match it.
 *
 * @remarks
 * The algorithm accepts exactly one normalized role-and-name match. It hashes
 * that node's order-preserving descriptor through `toCanonicalDigestBytes`
 * from `./canonical-json.js`, which emits compact canonical JSON encoded as
 * UTF-8 bytes. SHA-256 hashes those exact bytes; its lowercase hexadecimal
 * digest is recorded with the existing `a11y-neighborhood-v1` algorithm tag.
 * The descriptor includes normalized identities for the target, its parent,
 * and its immediately adjacent siblings; a first or last child records the
 * missing neighbor as `null`. The synthetic root contributes as the parent of
 * top-level page nodes but is never a match candidate itself.
 *
 * Zero and multiple matches both return `undefined`. In particular, a full
 * neighborhood hash never chooses among duplicate role-and-name matches:
 * downstream role-and-name locators cannot retain which physical duplicate was
 * fingerprinted, so treating one duplicate as a confirmed target is unsound.
 *
 * Malformed values are ordinary non-matches rather than hashing errors. When
 * the hashing step catches the specific `RangeError` from
 * `toCanonicalDigestBytes` for an unpaired UTF-16 surrogate in a role or name
 * string, it returns `undefined`: that identity cannot be canonically hashed
 * and is an ordinary no-confident-fingerprint outcome, not a hashing error.
 * This catch provides a non-throwing outcome specifically for that documented
 * unpaired-surrogate case; other unexpected canonicalization or hashing
 * errors still propagate.
 */
export function computeAccessibilityFingerprint(
  tree: JsonValueT,
  ref: AccessibilityElementRef,
): Fingerprint | undefined {
  if (!isAccessibilityNode(tree)) {
    return undefined;
  }

  const matches = findAllAccessibilityMatches(tree, ref);

  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0];

  if (match === undefined) {
    return undefined;
  }

  return hashMatch(match);
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
 *   when no node exists or the tree is malformed, or `ambiguous-match` when
 *   two or more nodes share the exact role and normalized name.
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
 * result so callers retain one deterministic, non-throwing resolution branch.
 * If hashing catches the specific `RangeError` from
 * `toCanonicalDigestBytes` for an unpaired UTF-16 surrogate in a role or name
 * string, this function likewise returns `element-not-found`: that identity
 * cannot be canonically hashed and is an ordinary non-match, not a hashing
 * error. This catch provides an ordinary `element-not-found` result
 * specifically for that documented unpaired-surrogate case; other unexpected
 * canonicalization or hashing errors still propagate.
 */
export function resolveAccessibilityFingerprint(
  tree: JsonValueT,
  ref: AccessibilityElementRef,
  expected: Fingerprint,
): 'hit' | 'fingerprint-mismatch' | 'element-not-found' | 'ambiguous-match' {
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
