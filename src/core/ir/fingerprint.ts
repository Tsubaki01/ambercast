import { createHash } from 'node:crypto';
import { toCanonicalDigestBytes } from './canonical-json.js';
import type { ElementRef, Fingerprint, JsonValueT } from './schema.js';

type AccessibilityNode = {
  readonly role: string;
  readonly name: string;
  readonly children: AccessibilityNode[];
};

type AccessibilityMatch = {
  readonly node: AccessibilityNode;
  readonly parent: AccessibilityNode | undefined;
};

/**
 * Checks that a JSON value has the complete recursive tree shape used by the
 * fingerprint traversal.
 *
 * The public boundary accepts general JSON because snapshots are serializable
 * data. Rejecting a malformed hand-constructed value as an absent match keeps
 * the matching operation total without pretending arbitrary JSON is an
 * accessibility node.
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
 * Finds the first matching node in the stable depth-first pre-order required
 * by the fingerprint format.
 *
 * Carrying the parent with the result preserves the target's neighborhood
 * without a second traversal or mutable parent links in the serialized tree.
 */
function findAccessibilityMatch(
  node: AccessibilityNode,
  ref: ElementRef,
  parent: AccessibilityNode | undefined,
): AccessibilityMatch | undefined {
  if (node.role === ref.role && node.name === ref.name) {
    return { node, parent };
  }

  for (const child of node.children) {
    const match = findAccessibilityMatch(child, ref, node);

    if (match !== undefined) {
      return match;
    }
  }

  return undefined;
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
 * node's identity. Within a quoted name, `\"` represents a literal `"`.
 *
 * A line that does not match the leading `- ` outline marker is skipped,
 * contributes no node, and does not stop parsing later lines. For example, a
 * `/key: value` metadata line follows this general fallback rule rather than
 * receiving attribute-specific handling; malformed input never throws.
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
  const outlinePattern = /^(\s*)-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?/;

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

    const node: AccessibilityNode = {
      role,
      name: capturedName?.replace(/\\"/g, '"') ?? '',
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
 *   reference has no matching node.
 *
 * @remarks
 * The matching node is the first match in a stable pre-order traversal:
 * depth-first, with each parent visited before its children and children kept
 * in their original left-to-right order. Version one hashes the
 * order-preserving descriptor `{ role, name, parent:
 * { role, name } | null, siblingRoles: string[] }`. For a top-level target,
 * `parent` is the synthetic root's `{ role: 'root', name: '' }`, so those
 * exact values participate in the hash. Siblings contribute roles but not
 * names because names are more likely to carry dynamic or
 * secret-adjacent text; roles are the structural signal this version needs.
 *
 * An unmatched reference is an ordinary absence, not a hashing error. The
 * browser adapter turns it into `element-not-found` before comparing any
 * fingerprint, preserving `BrowserSession.resolveGrounded`'s documented
 * precedence.
 *
 * The `a11y-neighborhood-v1` identifier versions this hashing scheme, letting
 * a later descriptor shape coexist without changing existing tags. Its hash
 * deliberately computes SHA-256 with `createHash('sha256')` over the
 * descriptor's canonical bytes from `toCanonicalDigestBytes`, the shared
 * canonical digest convention used elsewhere in core IR code, rather than
 * introducing another hashing convention.
 */
export function computeAccessibilityFingerprint(
  tree: JsonValueT,
  ref: ElementRef,
): Fingerprint | undefined {
  if (!isAccessibilityNode(tree)) {
    return undefined;
  }

  const match = findAccessibilityMatch(tree, ref, undefined);

  if (match === undefined) {
    return undefined;
  }

  const descriptor: JsonValueT = {
    role: match.node.role,
    name: match.node.name,
    parent: match.parent === undefined
      ? null
      : { role: match.parent.role, name: match.parent.name },
    siblingRoles: match.parent?.children.map((sibling) => sibling.role) ?? [],
  };

  return {
    algorithm: 'a11y-neighborhood-v1',
    hash: createHash('sha256').update(toCanonicalDigestBytes(descriptor)).digest('hex'),
  };
}
