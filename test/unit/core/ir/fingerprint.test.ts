import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeAccessibilityFingerprint,
  parseAriaSnapshot,
  resolveAccessibilityFingerprint,
} from '#core/ir/fingerprint.js';
import { toCanonicalDigestBytes } from '#core/ir/canonical-json.js';
import type { ElementRef, Fingerprint, JsonValueT } from '#core/ir/schema.js';

const TARGET: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(64) };

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
  const result = computeAccessibilityFingerprint(tree, ref);

  expect(result).toBeDefined();
  return result as Fingerprint;
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

describe('parseAriaSnapshot', () => {
  it('parses a single flat item', () => {
    expect(parseAriaSnapshot('- button "Save"')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'button', name: 'Save', children: [] }],
    });
  });

  it('builds parent-child edges across increasing and decreasing indentation depths', () => {
    expect(parseAriaSnapshot([
      '- navigation "Main":',
      '  - list:',
      '    - listitem:',
      '      - link "Home"',
      '  - link "Support"',
      '- contentinfo "Footer"',
    ].join('\n'))).toEqual({
      role: 'root',
      name: '',
      children: [
        {
          role: 'navigation',
          name: 'Main',
          children: [
            {
              role: 'list',
              name: '',
              children: [{
                role: 'listitem',
                name: '',
                children: [{ role: 'link', name: 'Home', children: [] }],
              }],
            },
            { role: 'link', name: 'Support', children: [] },
          ],
        },
        { role: 'contentinfo', name: 'Footer', children: [] },
      ],
    });
  });

  it('assigns an empty name to a bareword role', () => {
    expect(parseAriaSnapshot('- separator')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'separator', name: '', children: [] }],
    });
  });

  it('removes a structural colon from an unnamed role', () => {
    expect(parseAriaSnapshot('- listitem:')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'listitem', name: '', children: [] }],
    });
  });

  it('unescapes a quoted name containing an escaped quote', () => {
    expect(parseAriaSnapshot('- button "Save \\"draft\\""')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'button', name: 'Save "draft"', children: [] }],
    });
  });

  it.each([
    ['C:\\Temp\\file', '- button "C:\\\\Temp\\\\file"'],
    ['C:\\Temp\\file "quoted" here', '- button "C:\\\\Temp\\\\file \\"quoted\\" here"'],
  ] as const)('unescapes literal backslashes in a quoted name', (name, snapshot) => {
    expect(parseAriaSnapshot(snapshot)).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'button', name, children: [] }],
    });
  });

  it('skips slash-prefixed metadata without making it a genuine child or sibling', () => {
    const snapshot = [
      '- link "Download":',
      '  - /url: /downloads/ambercast',
      '  - text: Download the release',
    ].join('\n');
    const expectedTree: JsonValueT = {
      role: 'root',
      name: '',
      children: [{
        role: 'link',
        name: 'Download',
        children: [{ role: 'text', name: '', children: [] }],
      }],
    };
    const textRef: ElementRef = { strategy: 'accessibility', role: 'text', name: '' };

    expect(parseAriaSnapshot(snapshot)).toEqual(expectedTree);
    expect(fingerprint(parseAriaSnapshot(snapshot), textRef).hash)
      .toBe(fingerprint(expectedTree, textRef).hash);
  });

  it('discards an attribute suffix without preventing later lines from parsing', () => {
    expect(parseAriaSnapshot('- heading "Sign in" [level=1]\n- button "Continue"')).toEqual({
      role: 'root',
      name: '',
      children: [
        { role: 'heading', name: 'Sign in', children: [] },
        { role: 'button', name: 'Continue', children: [] },
      ],
    });
  });

  it('places multiple top-level items beneath the one exact synthetic root shape', () => {
    expect(parseAriaSnapshot('- banner\n- main "Content"\n- contentinfo "Footer"')).toEqual({
      role: 'root',
      name: '',
      children: [
        { role: 'banner', name: '', children: [] },
        { role: 'main', name: 'Content', children: [] },
        { role: 'contentinfo', name: 'Footer', children: [] },
      ],
    });
  });

  it('returns the synthetic root with no children for empty input', () => {
    expect(parseAriaSnapshot('')).toEqual({ role: 'root', name: '', children: [] });
  });

  it('skips malformed unindented lines and continues parsing later valid outline lines', () => {
    expect(parseAriaSnapshot('heading "This is not an outline"\n- button "Continue"\ntrailing malformed text')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'button', name: 'Continue', children: [] }],
    });
  });
});

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

  it('returns undefined when the target reference is absent from the tree', () => {
    const absentTarget: ElementRef = { strategy: 'accessibility', role: 'link', name: 'Forgot password?' };

    expect(computeAccessibilityFingerprint(createAccessibilityTree(), absentTarget)).toBeUndefined();
  });

  it('is deterministic when called repeatedly with the same tree and target', () => {
    const tree = createAccessibilityTree();

    expect(fingerprint(tree)).toEqual(fingerprint(tree));
  });

  it('tags the returned fingerprint with the a11y-neighborhood-v1 algorithm identifier', () => {
    expect(fingerprint(createAccessibilityTree()).algorithm).toBe('a11y-neighborhood-v1');
  });

  it('returns undefined when role-and-name matching finds more than one physical node', () => {
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
    expect(computeAccessibilityFingerprint(duplicateMatches, TARGET)).toBeUndefined();
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

    expect(computeAccessibilityFingerprint(tree, ref)).toBeUndefined();
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

    expect(computeAccessibilityFingerprint(tree, TARGET)).toBeUndefined();
  });

  it('never treats the synthetic root as a candidate, including after whitespace collapses to empty', () => {
    const syntheticRootOnly: JsonValueT = { role: 'root', name: '', children: [] };
    const rootReference: ElementRef = { strategy: 'accessibility', role: 'root', name: ' \t ' };

    expect(computeAccessibilityFingerprint(syntheticRootOnly, rootReference)).toBeUndefined();
  });

  it('returns undefined for a well-formed empty accessibility tree', () => {
    expect(computeAccessibilityFingerprint({ role: 'root', name: '', children: [] }, TARGET)).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than treating it as an empty tree', () => {
    expect(computeAccessibilityFingerprint({}, TARGET)).toBeUndefined();
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
    expect(computeAccessibilityFingerprint(tree, ref)).toBeUndefined();
    expect(resolveAccessibilityFingerprint(tree, ref, FINGERPRINT)).toBe('element-not-found');
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

    expect(computeAccessibilityFingerprint(duplicateCandidatesWithUnhashableParent, TARGET)).toBeUndefined();
    expect(resolveAccessibilityFingerprint(duplicateCandidatesWithUnhashableParent, TARGET, FINGERPRINT)).toBe('ambiguous-match');
  });
});
