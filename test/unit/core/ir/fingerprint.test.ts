import { describe, expect, it } from 'vitest';
import {
  computeAccessibilityFingerprint,
  parseAriaSnapshot,
} from '#core/ir/fingerprint.js';
import type { ElementRef, Fingerprint, JsonValueT } from '#core/ir/schema.js';

const TARGET: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };

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
              role: 'list:',
              name: '',
              children: [{
                role: 'listitem:',
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

  it('unescapes a quoted name containing an escaped quote', () => {
    expect(parseAriaSnapshot('- button "Save \\"draft\\""')).toEqual({
      role: 'root',
      name: '',
      children: [{ role: 'button', name: 'Save "draft"', children: [] }],
    });
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

  it('keeps the hash unchanged when only a sibling name changes', () => {
    expect(fingerprint(createAccessibilityTree({ siblingName: 'Work email' })).hash)
      .toBe(fingerprint(createAccessibilityTree()).hash);
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

  it('uses the first duplicate role-and-name match in stable pre-order traversal', () => {
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
    const changedLateDuplicate = createDuplicateMatches({ lateMatchRole: 'checkbox' });
    const changedEarlyMatchContext = createDuplicateMatches({ earlySiblingRole: 'heading' });

    expect(fingerprint(duplicateMatches).hash).toBe(fingerprint(changedLateDuplicate).hash);
    expect(fingerprint(duplicateMatches).hash)
      .not.toBe(fingerprint(changedEarlyMatchContext).hash);
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
});
