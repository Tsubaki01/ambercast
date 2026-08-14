import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeAccessibilityFingerprint,
  resolveAccessibilityFingerprint,
} from '#core/ir/fingerprint.js';
import { parseAriaSnapshot, SNAPSHOT_INVALID } from '#core/ir/aria-snapshot.js';
import { toCanonicalDigestBytes } from '#core/ir/canonical-json.js';
import type { ElementRef, Fingerprint, JsonValueT } from '#core/ir/schema.js';

const TARGET: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) };
const NO_RESOLVED_SECRETS: readonly ReadonlySet<string>[] = [];

function textTree(name: string): JsonValueT {
  return { role: 'root', name: '', children: [{ role: 'text', name, children: [] }] };
}

function createAccessibilityTree({
  parentRole = 'form',
  parentName = 'Sign in',
  siblingRole = 'textbox',
  siblingName = 'Email',
  targetRole = 'button',
  targetName = 'Submit',
}: {
  readonly parentRole?: string;
  readonly parentName?: string;
  readonly siblingRole?: string;
  readonly siblingName?: string;
  readonly targetRole?: string;
  readonly targetName?: string;
} = {}): JsonValueT {
  return {
    role: 'root',
    name: '',
    children: [{
      role: 'main',
      name: 'Application',
      children: [{
        role: parentRole,
        name: parentName,
        children: [
          { role: siblingRole, name: siblingName, children: [] },
          { role: targetRole, name: targetName, children: [] },
        ],
      }],
    }],
  };
}

function fingerprint(tree: JsonValueT, ref: ElementRef = TARGET): Fingerprint {
  const result = computeAccessibilityFingerprint(tree, ref, NO_RESOLVED_SECRETS);

  if (result.kind !== 'ok') {
    throw new Error(`Expected an accessibility fingerprint, received ${result.kind}.`);
  }

  return result.fingerprint;
}

function handHash(descriptor: JsonValueT): string {
  return createHash('sha256')
    .update(toCanonicalDigestBytes(descriptor))
    .digest('hex');
}

function createTargetNeighborhood({
  parentRole = 'form',
  parentName = 'Sign in',
  siblingBeforeRole = 'textbox',
  siblingBeforeName = 'Email',
  targetRole = 'button',
  targetName = 'Submit',
  siblingAfterRole = 'link',
  siblingAfterName = 'Forgot password?',
}: {
  readonly parentRole?: string;
  readonly parentName?: string;
  readonly siblingBeforeRole?: string;
  readonly siblingBeforeName?: string;
  readonly targetRole?: string;
  readonly targetName?: string;
  readonly siblingAfterRole?: string;
  readonly siblingAfterName?: string;
} = {}): JsonValueT {
  return {
    role: 'root',
    name: '',
    children: [{
      role: parentRole,
      name: parentName,
      children: [
        { role: siblingBeforeRole, name: siblingBeforeName, children: [] },
        { role: targetRole, name: targetName, children: [] },
        { role: siblingAfterRole, name: siblingAfterName, children: [] },
      ],
    }],
  };
}

type DescriptorNamePosition = 'target' | 'parent' | 'siblingBefore' | 'siblingAfter';

function neighborhoodWithNameAt(
  position: DescriptorNamePosition,
  name: string,
): { readonly tree: JsonValueT; readonly ref: ElementRef } {
  switch (position) {
    case 'target':
      return {
        tree: createTargetNeighborhood({ targetName: name }),
        ref: { strategy: 'accessibility', role: 'button', name },
      };
    case 'parent':
      return { tree: createTargetNeighborhood({ parentName: name }), ref: TARGET };
    case 'siblingBefore':
      return { tree: createTargetNeighborhood({ siblingBeforeName: name }), ref: TARGET };
    case 'siblingAfter':
      return { tree: createTargetNeighborhood({ siblingAfterName: name }), ref: TARGET };
  }
}

describe('computeAccessibilityFingerprint', () => {
  it('returns the same hash for exact matching trees', () => {
    expect(fingerprint(createAccessibilityTree()).hash).toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('changes the hash when the matched node role changes', () => {
    const changedTarget: ElementRef = { strategy: 'accessibility', role: 'link', name: 'Submit' };

    expect(fingerprint(createAccessibilityTree({ targetRole: 'link' }), changedTarget).hash)
      .not.toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('changes the hash when the matched node name changes', () => {
    const changedTarget: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Send' };

    expect(fingerprint(createAccessibilityTree({ targetName: 'Send' }), changedTarget).hash)
      .not.toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('changes the hash when a sibling role changes', () => {
    expect(fingerprint(createAccessibilityTree({ siblingRole: 'combobox' })).hash)
      .not.toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('changes the hash when only an adjacent sibling name changes', () => {
    expect(fingerprint(createAccessibilityTree({ siblingName: 'Work email' })).hash)
      .not.toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('hashes the hand-authored bounded sibling-before and sibling-after descriptor', () => {
    const descriptor: JsonValueT = {
      role: 'button',
      name: 'Submit',
      parent: { role: 'form', name: 'Sign in' },
      siblingBefore: { role: 'button', name: 'Cancel' },
      siblingAfter: { role: 'link', name: 'Forgot password?' },
    };

    const expectedHash = handHash(descriptor);
    // This fixed known answer independently guards canonical JSON encoding; do not refresh it merely to match handHash after a regression.
    expect(expectedHash).toBe('a0725a4bd3e4503098e9bd10839afa0ab8ae10d75801e7f35baa4f85cfb50e92');

    expect(fingerprint({
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'button', name: 'Cancel', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
        ],
      }],
    }).hash).toBe(expectedHash);
  });

  it.each([
    ['first child', [
      { role: 'button', name: 'Submit', children: [] },
      { role: 'link', name: 'Cancel', children: [] },
    ], {
      role: 'button', name: 'Submit', parent: { role: 'form', name: 'Sign in' },
      siblingBefore: null, siblingAfter: { role: 'link', name: 'Cancel' },
    }],
    ['last child', [
      { role: 'link', name: 'Cancel', children: [] },
      { role: 'button', name: 'Submit', children: [] },
    ], {
      role: 'button', name: 'Submit', parent: { role: 'form', name: 'Sign in' },
      siblingBefore: { role: 'link', name: 'Cancel' }, siblingAfter: null,
    }],
    ['only child', [
      { role: 'button', name: 'Submit', children: [] },
    ], {
      role: 'button', name: 'Submit', parent: { role: 'form', name: 'Sign in' },
      siblingBefore: null, siblingAfter: null,
    }],
  ])('uses null for the missing neighbors when the target is the %s', (_placement, children, descriptor) => {
    const tree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{ role: 'form', name: 'Sign in', children }],
    };

    expect(fingerprint(tree).hash).toBe(handHash(descriptor));
  });

  it.each([
    ['siblingBefore role', createTargetNeighborhood({ siblingBeforeRole: 'combobox' })],
    ['siblingBefore name', createTargetNeighborhood({ siblingBeforeName: 'Work email' })],
    ['siblingAfter role', createTargetNeighborhood({ siblingAfterRole: 'heading' })],
    ['siblingAfter name', createTargetNeighborhood({ siblingAfterName: 'Need help?' })],
  ] as const)('changes the hash when the immediate %s changes', (_field, changedTree) => {
    expect(fingerprint(changedTree).hash).not.toBe(fingerprint(createTargetNeighborhood()).hash);
  });

  it.each([
    ['before', {
      role: 'root', name: '', children: [{
        role: 'form', name: 'Sign in', children: [
          { role: 'heading', name: 'Far before A', children: [] },
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
        ],
      }],
    }, {
      role: 'root', name: '', children: [{
        role: 'form', name: 'Sign in', children: [
          { role: 'heading', name: 'Far before B', children: [] },
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
        ],
      }],
    }],
    ['after', {
      role: 'root', name: '', children: [{
        role: 'form', name: 'Sign in', children: [
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
          { role: 'status', name: 'Far after A', children: [] },
        ],
      }],
    }, {
      role: 'root', name: '', children: [{
        role: 'form', name: 'Sign in', children: [
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
          { role: 'status', name: 'Far after B', children: [] },
        ],
      }],
    }],
  ])('ignores a non-adjacent sibling on the %s side', (_side, changedTree, referenceTree) => {
    expect(fingerprint(changedTree).hash).toBe(fingerprint(referenceTree).hash);
  });

  it.each([
    ['role', createAccessibilityTree({ parentRole: 'region' })],
    ['name', createAccessibilityTree({ parentName: 'Authentication' })],
  ] as const)('changes the hash when the parent %s changes', (_field, changedTree) => {
    expect(fingerprint(changedTree).hash).not.toBe(fingerprint(createAccessibilityTree()).hash);
  });

  it('returns no-match when the target reference is absent from the tree', () => {
    const absentTarget: ElementRef = { strategy: 'accessibility', role: 'link', name: 'Forgot password?' };

    expect(computeAccessibilityFingerprint(createAccessibilityTree(), absentTarget, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'no-match' });
  });

  it('is deterministic when called repeatedly with the same tree and target', () => {
    const tree = createAccessibilityTree();

    expect(fingerprint(tree)).toEqual(fingerprint(tree));
  });

  it('tags the returned fingerprint with the a11y-neighborhood-v2 algorithm identifier', () => {
    expect(fingerprint(createAccessibilityTree()).algorithm).toBe('a11y-neighborhood-v2');
  });

  it('returns ambiguous-match when role-and-name matching finds more than one physical node', () => {
    const createDuplicateMatches = ({
      earlySiblingRole = 'link',
      lateMatchRole = 'button',
    }: {
      readonly earlySiblingRole?: string;
      readonly lateMatchRole?: string;
    } = {}): JsonValueT => ({
      role: 'root',
      name: '',
      children: [{
        role: 'main',
        name: 'Application',
        children: [
          {
            role: 'form',
            name: 'Early form',
            children: [
              { role: 'button', name: 'Submit', children: [] },
              { role: earlySiblingRole, name: 'Help', children: [] },
            ],
          },
          {
            role: 'region',
            name: 'Later region',
            children: [
              { role: 'textbox', name: 'Email', children: [] },
              { role: lateMatchRole, name: 'Submit', children: [] },
            ],
          },
        ],
      }],
    });

    const duplicateMatches = createDuplicateMatches();
    expect(computeAccessibilityFingerprint(duplicateMatches, TARGET, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'ambiguous-match' });
  });

  it('changes the hash when unchanged sibling roles are reordered', () => {
    const treeWithTextboxThenLink: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'link', name: 'Forgot password?', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };
    const treeWithLinkThenTextbox: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'link', name: 'Forgot password?', children: [] },
          { role: 'textbox', name: 'Email', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };

    expect(fingerprint(treeWithLinkThenTextbox).hash).not.toBe(fingerprint(treeWithTextboxThenLink).hash);
  });

  it('uses the synthetic root as the parent for a top-level target', () => {
    const topLevelTarget: JsonValueT = {
      role: 'root',
      name: '',
      children: [{ role: 'button', name: 'Submit', children: [] }],
    };
    const nestedUnderRootShapedParent: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'main',
        name: 'Application',
        children: [{
          role: 'root',
          name: '',
          children: [{ role: 'button', name: 'Submit', children: [] }],
        }],
      }],
    };
    const wrappedTarget: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'group',
        name: 'Actions',
        children: [{ role: 'button', name: 'Submit', children: [] }],
      }],
    };

    expect(fingerprint(topLevelTarget).hash).toBe(fingerprint(nestedUnderRootShapedParent).hash);
    expect(fingerprint(topLevelTarget).hash).not.toBe(fingerprint(wrappedTarget).hash);
  });

  it('normalizes NFC-equivalent names at every descriptor position', () => {
    const composed = createTargetNeighborhood({
      parentName: 'Café settings',
      siblingBeforeName: 'Résumé',
      targetName: 'Entrée',
      siblingAfterName: 'Crème brûlée',
    });
    const decomposed = createTargetNeighborhood({
      parentName: 'Cafe\u0301 settings',
      siblingBeforeName: 'Re\u0301sume\u0301',
      targetName: 'Entre\u0301e',
      siblingAfterName: 'Cre\u0300me bru\u0302le\u0301e',
    });
    const composedRef: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Entrée' };
    const decomposedRef: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Entre\u0301e' };

    expect(fingerprint(decomposed, decomposedRef).hash).toBe(fingerprint(composed, composedRef).hash);
  });

  it.each([
    ['target', createTargetNeighborhood({ targetName: ' \n Submit\t ' })],
    ['parent', createTargetNeighborhood({ parentName: ' \n Sign\t in  ' })],
    ['siblingBefore', createTargetNeighborhood({ siblingBeforeName: ' \n Email\t  ' })],
    ['siblingAfter', createTargetNeighborhood({ siblingAfterName: ' \n Forgot\t password?  ' })],
  ] as const)('collapses and trims whitespace in the %s name', (_position, changedTree) => {
    expect(fingerprint(changedTree).hash).toBe(fingerprint(createTargetNeighborhood()).hash);
  });

  it('matches a reference whose name differs only by whitespace', () => {
    const whitespaceReference: ElementRef = {
      strategy: 'accessibility',
      role: 'button',
      name: ' \n Submit\t ',
    };

    expect(fingerprint(createTargetNeighborhood(), whitespaceReference)).toEqual(fingerprint(createTargetNeighborhood()));
  });

  it('treats normalized-equivalent duplicate names as ambiguous', () => {
    const tree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'button', name: 'Café', children: [] },
          { role: 'button', name: 'Cafe\u0301', children: [] },
        ],
      }],
    };
    const ref: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Café' };

    expect(computeAccessibilityFingerprint(tree, ref, NO_RESOLVED_SECRETS)).toEqual({ kind: 'ambiguous-match' });
  });

  it('treats whitespace-equivalent duplicate names as ambiguous', () => {
    const tree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'button', name: 'Submit', children: [] },
          { role: 'button', name: ' \n Submit\t ', children: [] },
        ],
      }],
    };

    expect(computeAccessibilityFingerprint(tree, TARGET, NO_RESOLVED_SECRETS)).toEqual({ kind: 'ambiguous-match' });
  });

  it('never treats the synthetic root as a candidate, including after whitespace collapses to empty', () => {
    const syntheticRootOnly: JsonValueT = { role: 'root', name: '', children: [] };
    const rootReference: ElementRef = { strategy: 'accessibility', role: 'root', name: ' \t ' };

    expect(computeAccessibilityFingerprint(syntheticRootOnly, rootReference, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'no-match' });
  });

  it('returns no-match for a well-formed empty accessibility tree', () => {
    expect(computeAccessibilityFingerprint({ role: 'root', name: '', children: [] }, TARGET, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'no-match' });
  });

  it('returns no-match for malformed JSON rather than treating it as an empty tree', () => {
    expect(computeAccessibilityFingerprint({}, TARGET, NO_RESOLVED_SECRETS)).toEqual({ kind: 'no-match' });
  });

  it('finds a target in a deep but ordinary tree without changing the result', () => {
    type TreeNode = { role: string; name: string; children: TreeNode[] };
    const shallowBranch: TreeNode = {
      role: 'form',
      name: 'Sign in',
      children: [
        { role: 'textbox', name: 'Email', children: [] },
        { role: 'button', name: 'Submit', children: [] },
        { role: 'link', name: 'Forgot password?', children: [] },
      ],
    };
    let branch = shallowBranch;
    for (let depth = 0; depth < 64; depth += 1) {
      branch = { role: 'group', name: `Level ${depth}`, children: [branch] };
    }
    const deepTree: JsonValueT = { role: 'root', name: '', children: [branch] };
    const shallowTree: JsonValueT = { role: 'root', name: '', children: [shallowBranch] };

    expect(fingerprint(deepTree)).toEqual(fingerprint(shallowTree));
  });

  it.each([
    ['target', createAccessibilityTree({ targetName: '\ud800' }), { strategy: 'accessibility', role: 'button', name: '\ud800' }],
    ['parent', createAccessibilityTree({ parentName: '\ud800' }), TARGET],
    ['sibling', createAccessibilityTree({ siblingName: '\ud800' }), TARGET],
  ] as const)('treats an unpaired UTF-16 surrogate in the %s name as a non-match', (_position, tree, ref) => {
    expect(computeAccessibilityFingerprint(tree, ref, NO_RESOLVED_SECRETS)).toEqual({ kind: 'no-match' });
    expect(resolveAccessibilityFingerprint(tree, ref, FINGERPRINT)).toBe('element-not-found');
  });

  it('classifies the parser invalid-snapshot marker before malformed-tree matching', () => {
    expect(computeAccessibilityFingerprint(SNAPSHOT_INVALID, TARGET, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'snapshot-invalid' });
  });

  it('classifies a JSON-round-tripped invalid-snapshot marker structurally', () => {
    const clonedMarker = JSON.parse(JSON.stringify(SNAPSHOT_INVALID)) as JsonValueT;

    expect(clonedMarker).not.toBe(SNAPSHOT_INVALID);
    expect(computeAccessibilityFingerprint(clonedMarker, TARGET, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'snapshot-invalid' });
  });

  it.each([
    ['target role', createTargetNeighborhood(), TARGET, 'button'],
    ['target name', createTargetNeighborhood(), TARGET, 'Submit'],
    ['parent role', createTargetNeighborhood({ parentRole: 'secret-form' }), TARGET, 'secret-form'],
    ['parent name', createTargetNeighborhood({ parentName: 'Secret parent' }), TARGET, 'Secret parent'],
    ['sibling-before role', createTargetNeighborhood({ siblingBeforeRole: 'secret-before' }), TARGET, 'secret-before'],
    ['sibling-before name', createTargetNeighborhood({ siblingBeforeName: 'Secret before' }), TARGET, 'Secret before'],
    ['sibling-after role', createTargetNeighborhood({ siblingAfterRole: 'secret-after' }), TARGET, 'secret-after'],
    ['sibling-after name', createTargetNeighborhood({ siblingAfterName: 'Secret after' }), TARGET, 'Secret after'],
  ] as const)('rejects a resolved secret found in the descriptor %s', (_field, tree, ref, secret) => {
    expect(computeAccessibilityFingerprint(tree, ref, [new Set([secret])]))
      .toEqual({ kind: 'secret-contaminated' });
  });

  it('materializes a genuine single-use secret iterator before checking every descriptor field', () => {
    let iterations = 0;
    function* resolvedSecretSets(): Generator<ReadonlySet<string>> {
      iterations += 1;
      yield new Set(['Secret after']);
    }
    const secretValues = resolvedSecretSets();

    expect(computeAccessibilityFingerprint(createTargetNeighborhood({ siblingAfterName: 'Secret after' }), TARGET, secretValues))
      .toEqual({ kind: 'secret-contaminated' });
    expect(iterations).toBe(1);
  });

  it.each([
    [
      'an exact two-code-unit value',
      createTargetNeighborhood({ targetName: 'xy' }),
      { strategy: 'accessibility', role: 'button', name: 'xy' } as const,
      new Set(['xy']),
      { kind: 'secret-contaminated' },
    ],
    [
      'a three-code-unit substring',
      createTargetNeighborhood({ targetName: 'contains abc value' }),
      { strategy: 'accessibility', role: 'button', name: 'contains abc value' } as const,
      new Set(['abc']),
      { kind: 'secret-contaminated' },
    ],
    [
      'a two-code-unit substring',
      createTargetNeighborhood({ targetName: 'contains ab value' }),
      { strategy: 'accessibility', role: 'button', name: 'contains ab value' } as const,
      new Set(['ab']),
      { kind: 'ok' },
    ],
    [
      'an empty resolved value',
      createTargetNeighborhood(),
      TARGET,
      new Set(['']),
      { kind: 'ok' },
    ],
  ] as const)('applies the secret matching threshold for %s', (_description, tree, ref, secrets, expected) => {
    expect(computeAccessibilityFingerprint(tree, ref, [secrets])).toMatchObject(expected);
  });

  it.each([
    [
      'does not use the raw secret length when whitespace normalization leaves a two-code-unit substring',
      'contains ab value',
      'ab  ',
      { kind: 'ok' },
    ],
    [
      'uses the normalized secret length when whitespace normalization leaves a three-code-unit substring',
      'contains abc value',
      'abc  ',
      { kind: 'secret-contaminated' },
    ],
  ] as const)('measures the secret substring threshold on the normalized comparison string when it %s', (
    _description,
    targetName,
    secret,
    expected,
  ) => {
    const { tree, ref } = neighborhoodWithNameAt('target', targetName);

    expect(computeAccessibilityFingerprint(tree, ref, [new Set([secret])])).toMatchObject(expected);
  });

  it.each(['target', 'parent', 'siblingBefore', 'siblingAfter'] as const)(
    'normalizes a decomposed %s name against a composed resolved secret before checking taint',
    (position) => {
      const { tree, ref } = neighborhoodWithNameAt(position, 'Cafe\u0301 settings');

      expect(computeAccessibilityFingerprint(tree, ref, [new Set(['Café settings'])]))
        .toEqual({ kind: 'secret-contaminated' });
    },
  );

  it.each(['target', 'parent', 'siblingBefore', 'siblingAfter'] as const)(
    'normalizes a composed %s name against a decomposed resolved secret before checking taint',
    (position) => {
      const { tree, ref } = neighborhoodWithNameAt(position, 'Café settings');

      expect(computeAccessibilityFingerprint(tree, ref, [new Set(['Cafe\u0301 settings'])]))
        .toEqual({ kind: 'secret-contaminated' });
    },
  );

  it.each(['target', 'parent', 'siblingBefore', 'siblingAfter'] as const)(
    'normalizes an irregular-whitespace %s name against a collapsed resolved secret before checking taint',
    (position) => {
      const { tree, ref } = neighborhoodWithNameAt(position, '  account\t\n settings  ');

      expect(computeAccessibilityFingerprint(tree, ref, [new Set(['account settings'])]))
        .toEqual({ kind: 'secret-contaminated' });
    },
  );

  it.each(['target', 'parent', 'siblingBefore', 'siblingAfter'] as const)(
    'normalizes a collapsed %s name against an irregular-whitespace resolved secret before checking taint',
    (position) => {
      const { tree, ref } = neighborhoodWithNameAt(position, 'account settings');

      expect(computeAccessibilityFingerprint(tree, ref, [new Set(['  account\t\n settings  '])]))
        .toEqual({ kind: 'secret-contaminated' });
    },
  );

  it('taints a role that contains a raw resolved secret value', () => {
    const targetRole = 'button-secret-field';
    const target: ElementRef = { strategy: 'accessibility', role: targetRole, name: 'Submit' };

    expect(computeAccessibilityFingerprint(
      createTargetNeighborhood({ targetRole }),
      target,
      [new Set(['secret'])],
    )).toEqual({ kind: 'secret-contaminated' });
  });

  it.each([
    ['Unicode composition', 'button Cafe\u0301 field', 'button Café field'],
    ['whitespace collapsing', 'button   submit field', 'button submit field'],
  ] as const)('does not apply name normalization to roles for %s-only matches', (_description, targetRole, secret) => {
    const target: ElementRef = { strategy: 'accessibility', role: targetRole, name: 'Submit' };

    expect(computeAccessibilityFingerprint(
      createTargetNeighborhood({ targetRole }),
      target,
      [new Set([secret])],
    )).toMatchObject({ kind: 'ok' });
  });

  it('does not inspect a non-adjacent descendant for secret contamination', () => {
    const tree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: 'Sign in',
        children: [
          { role: 'group', name: 'Safe group', children: [{ role: 'text', name: 'LEAKED_SECRET', children: [] }] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };

    expect(computeAccessibilityFingerprint(tree, TARGET, [new Set(['LEAKED_SECRET'])]))
      .toMatchObject({ kind: 'ok' });
  });

  it.each([
    [
      'a decomposed colon-value text name',
      '- text: Cafe\u0301',
      { strategy: 'accessibility', role: 'text', name: 'Café' } as const,
      textTree('Café'),
    ],
    [
      'a whitespace-irregular colon-value text name',
      '- text: "  Release\\t notes  "',
      { strategy: 'accessibility', role: 'text', name: 'Release notes' } as const,
      textTree('Release notes'),
    ],
  ] as const)('normalizes %s after parser name promotion', (_description, snapshot, ref, normalizedTree) => {
    expect(computeAccessibilityFingerprint(parseAriaSnapshot(snapshot), ref, NO_RESOLVED_SECRETS))
      .toEqual(computeAccessibilityFingerprint(normalizedTree, ref, NO_RESOLVED_SECRETS));
  });
});

describe('resolveAccessibilityFingerprint', () => {
  it('reports element-not-found when no role-and-name candidate exists', () => {
    const emptySyntheticRoot: JsonValueT = { role: 'root', name: '', children: [] };

    expect(resolveAccessibilityFingerprint(emptySyntheticRoot, TARGET, FINGERPRINT)).toBe('element-not-found');
  });

  it('maps malformed evidence to element-not-found', () => {
    expect(resolveAccessibilityFingerprint({}, TARGET, FINGERPRINT)).toBe('element-not-found');
  });

  it('maps the parser invalid-snapshot marker to snapshot-invalid', () => {
    expect(resolveAccessibilityFingerprint(SNAPSHOT_INVALID, TARGET, FINGERPRINT)).toBe('snapshot-invalid');
  });

  it('maps a JSON-round-tripped invalid-snapshot marker to snapshot-invalid', () => {
    const clonedMarker = JSON.parse(JSON.stringify(SNAPSHOT_INVALID)) as JsonValueT;

    expect(clonedMarker).not.toBe(SNAPSHOT_INVALID);
    expect(resolveAccessibilityFingerprint(clonedMarker, TARGET, FINGERPRINT)).toBe('snapshot-invalid');
  });

  it('reports fingerprint-mismatch for one matching candidate whose neighborhood changed', () => {
    expect(resolveAccessibilityFingerprint(createAccessibilityTree(), TARGET, FINGERPRINT)).toBe('fingerprint-mismatch');
  });

  it('reports hit when the sole matching candidate has the expected fingerprint', () => {
    const tree = createAccessibilityTree();

    expect(resolveAccessibilityFingerprint(tree, TARGET, fingerprint(tree))).toBe('hit');
  });

  it('reports ambiguous-match even when one duplicate has the expected fingerprint', () => {
    const firstCandidateForm = {
      role: 'form',
      name: 'Early form',
      children: [
        { role: 'textbox', name: 'Email', children: [] },
        { role: 'button', name: 'Submit', children: [] },
      ],
    };
    const firstCandidateOnly: JsonValueT = {
      role: 'root',
      name: '',
      children: [firstCandidateForm],
    };
    const duplicateCandidates: JsonValueT = {
      role: 'root',
      name: '',
      children: [
        firstCandidateForm,
        {
          role: 'region',
          name: 'Later region',
          children: [
            { role: 'textbox', name: 'Search', children: [] },
            { role: 'button', name: 'Submit', children: [] },
          ],
        },
      ],
    };

    expect(resolveAccessibilityFingerprint(duplicateCandidates, TARGET, fingerprint(firstCandidateOnly))).toBe('ambiguous-match');
  });

  it('never attempts to hash a candidate when ambiguity alone determines the outcome', () => {
    const poisonedTarget: ElementRef = { strategy: 'accessibility', role: 'button', name: '\ud800' };
    const duplicateCandidatesWithUnhashableNames: JsonValueT = {
      role: 'root',
      name: '',
      children: [
        {
          role: 'form',
          name: 'Early form',
          children: [
            { role: 'textbox', name: 'Email', children: [] },
            { role: 'button', name: '\ud800', children: [] },
          ],
        },
        {
          role: 'region',
          name: 'Later region',
          children: [
            { role: 'textbox', name: 'Search', children: [] },
            { role: 'button', name: '\ud800', children: [] },
          ],
        },
      ],
    };

    expect(resolveAccessibilityFingerprint(
      duplicateCandidatesWithUnhashableNames,
      poisonedTarget,
      FINGERPRINT,
    )).toBe('ambiguous-match');
  });

  it('classifies duplicate candidates before canonicalizing either descriptor', () => {
    const duplicateCandidatesWithUnhashableParent: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'form',
        name: '\ud800',
        children: [
          { role: 'button', name: 'Submit', children: [] },
          { role: 'button', name: 'Submit', children: [] },
        ],
      }],
    };

    expect(computeAccessibilityFingerprint(duplicateCandidatesWithUnhashableParent, TARGET, NO_RESOLVED_SECRETS))
      .toEqual({ kind: 'ambiguous-match' });
    expect(resolveAccessibilityFingerprint(duplicateCandidatesWithUnhashableParent, TARGET, FINGERPRINT)).toBe('ambiguous-match');
  });
});
