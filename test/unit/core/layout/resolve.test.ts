import { describe, expect, it } from 'vitest';
import type { LayoutConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { createLayoutResolver } from '#core/layout/resolve.js';

const CONFIG = {
  testDir: '/workspace/tests/ambercast',
  runsDir: '/workspace/.runs',
} as const satisfies LayoutConfig;

describe('createLayoutResolver', () => {
  it('constructs a resolver for a well-formed absolute layout configuration', () => {
    expect(() => createLayoutResolver(CONFIG)).not.toThrow();
  });

  it('constructs a resolver when testDir is the absolute root boundary', () => {
    expect(() => createLayoutResolver({ testDir: '/', runsDir: '/workspace/.runs' })).not.toThrow();
  });

  it.each([
    ['', '/workspace/.runs'],
    ['tests/ambercast', '/workspace/.runs'],
    ['.', '/workspace/.runs'],
    ['/workspace/tests/../tests/ambercast', '/workspace/.runs'],
    ['/workspace/tests/./ambercast', '/workspace/.runs'],
    ['/workspace/tests//ambercast', '/workspace/.runs'],
    ['/workspace/tests/ambercast/', '/workspace/.runs'],
  ] as const)('rejects malformed testDir %j during construction', (testDir, runsDir) => {
    let thrown: unknown;

    try {
      createLayoutResolver({ testDir, runsDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigInvalidError);

    if (thrown instanceof ConfigInvalidError) {
      expect(thrown.message).toContain('testDir');
      expect(thrown.details?.testDir).toBe(testDir);
    }
  });
});

describe('LayoutResolver companion derivation', () => {
  const resolver = createLayoutResolver(CONFIG);

  it.each([
    [
      '/workspace/tests/ambercast/login.test.md',
      '/workspace/tests/ambercast/login.ambercast.plan.json',
      '/workspace/tests/ambercast/login.ambercast.grounding.json',
    ],
    [
      '/workspace/tests/ambercast/ui/checkout.mobile.test.md',
      '/workspace/tests/ambercast/ui/checkout.mobile.ambercast.plan.json',
      '/workspace/tests/ambercast/ui/checkout.mobile.ambercast.grounding.json',
    ],
    [
      '/workspace/tests/ambercast/ui/foo.ambercast.plan.json.test.md',
      '/workspace/tests/ambercast/ui/foo.ambercast.plan.json.ambercast.plan.json',
      '/workspace/tests/ambercast/ui/foo.ambercast.plan.json.ambercast.grounding.json',
    ],
  ] as const)('replaces only the terminal test suffix for %s', (testPath, planPath, groundingPath) => {
    expect(resolver.planPathFor(testPath)).toBe(planPath);
    expect(resolver.groundingPathFor(testPath)).toBe(groundingPath);
  });

  it.each([
    ['/workspace/tests/ambercast/login.test.md', '/workspace/.runs/login'],
    ['/workspace/tests/ambercast/ui/checkout.mobile.test.md', '/workspace/.runs/ui/checkout.mobile'],
    ['/workspace/tests/ambercast/deep/a/b/case.test.md', '/workspace/.runs/deep/a/b/case'],
  ] as const)('maps test %s into its dedicated run directory %s', (testPath, runsDir) => {
    expect(resolver.runsDirFor(testPath)).toBe(runsDir);
  });

  it.each(['planPathFor', 'groundingPathFor', 'runsDirFor'] as const)('%s rejects an anonymous empty-stem test path', (method) => {
    expect(() => resolver[method]('/workspace/tests/ambercast/.test.md')).toThrow(RangeError);
  });

  it('prevents the previously colliding named and anonymous test paths from sharing a runs directory', () => {
    const namedTestPath = '/workspace/tests/ambercast/ui.test.md';
    const anonymousTestPath = '/workspace/tests/ambercast/ui/.test.md';

    expect(resolver.runsDirFor(namedTestPath)).toBe('/workspace/.runs/ui');
    expect(() => resolver.runsDirFor(anonymousTestPath)).toThrow(RangeError);
  });

  it.each([
    '/workspace/tests/ambercast/login.test.md',
    '/workspace/tests/ambercast/ui/checkout.mobile.test.md',
    '/workspace/tests/ambercast/deep/a/b/case.test.md',
  ])('recovers %s from both companion paths', (testPath) => {
    expect(resolver.testPathForPlan(resolver.planPathFor(testPath))).toBe(testPath);
    expect(resolver.testPathForGrounding(resolver.groundingPathFor(testPath))).toBe(testPath);
  });

  it('recognizes legal unusual characters under a root test directory', () => {
    const rootResolver = createLayoutResolver({ testDir: '/', runsDir: '/.runs' });
    const testPath = '/日本語/space name/@scope/[case].test.md';

    expect(rootResolver.planPathFor(testPath)).toBe('/日本語/space name/@scope/[case].ambercast.plan.json');
    expect(rootResolver.groundingPathFor(testPath)).toBe('/日本語/space name/@scope/[case].ambercast.grounding.json');
    expect(rootResolver.runsDirFor(testPath)).toBe('/.runs/日本語/space name/@scope/[case]');
  });

  it.each([
    [
      'plan',
      '/workspace/tests/ambercast/login.ambercast.plan.json',
      '/workspace/tests/ambercast/login.test.md',
    ],
    [
      'grounding',
      '/workspace/tests/ambercast/login.ambercast.grounding.json',
      '/workspace/tests/ambercast/login.test.md',
    ],
  ] as const)('recognizes a valid %s companion only through its matching inverse', (kind, companionPath, testPath) => {
    if (kind === 'plan') {
      expect(resolver.testPathForPlan(companionPath)).toBe(testPath);
      expect(resolver.testPathForGrounding(companionPath)).toBeUndefined();
      return;
    }

    expect(resolver.testPathForGrounding(companionPath)).toBe(testPath);
    expect(resolver.testPathForPlan(companionPath)).toBeUndefined();
  });

  it.each([
    ['testPathForPlan', 'a wrong suffix', '/workspace/tests/ambercast/login.md'],
    ['testPathForGrounding', 'a wrong suffix', '/workspace/tests/ambercast/login.md'],
    ['testPathForPlan', 'a plan-shaped path outside testDir', '/workspace/other/login.ambercast.plan.json'],
    ['testPathForGrounding', 'a grounding-shaped path outside testDir', '/workspace/other/login.ambercast.grounding.json'],
    ['testPathForPlan', 'a plan-shaped sibling-prefix path', '/workspace/tests/ambercast-evil/login.ambercast.plan.json'],
    ['testPathForGrounding', 'a grounding-shaped sibling-prefix path', '/workspace/tests/ambercast-evil/login.ambercast.grounding.json'],
    ['testPathForPlan', 'a non-terminal plan suffix', '/workspace/tests/ambercast/login.ambercast.plan.json.backup'],
    ['testPathForGrounding', 'a non-terminal grounding suffix', '/workspace/tests/ambercast/login.ambercast.grounding.json.backup'],
    ['testPathForPlan', 'a relative plan companion', 'login.ambercast.plan.json'],
    ['testPathForGrounding', 'a relative grounding companion', 'login.ambercast.grounding.json'],
    ['testPathForPlan', 'a repeated-separator plan companion', '/workspace/tests/ambercast/ui//login.ambercast.plan.json'],
    ['testPathForGrounding', 'a repeated-separator grounding companion', '/workspace/tests/ambercast/ui//login.ambercast.grounding.json'],
    ['testPathForPlan', 'a dot-segmented plan companion', '/workspace/tests/ambercast/./login.ambercast.plan.json'],
    ['testPathForGrounding', 'a dot-segmented grounding companion', '/workspace/tests/ambercast/./login.ambercast.grounding.json'],
    ['testPathForPlan', 'an anonymous plan companion', '/workspace/tests/ambercast/.ambercast.plan.json'],
    ['testPathForGrounding', 'an anonymous grounding companion', '/workspace/tests/ambercast/.ambercast.grounding.json'],
  ] as const)('%s returns undefined without throwing for %s', (method, _name, path) => {
    let result: string | undefined;

    expect(() => {
      result = resolver[method](path);
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it.each(['planPathFor', 'groundingPathFor', 'runsDirFor'] as const)('%s rejects every path outside its discovered-test domain', (method) => {
    for (const testPath of [
      '/workspace/other/login.test.md',
      '/workspace/tests/ambercast-evil/login.test.md',
      'login.test.md',
      '/workspace/tests/ambercast/./login.test.md',
      '/workspace/tests/ambercast/login.md',
    ]) {
      expect(() => resolver[method](testPath)).toThrow(RangeError);
    }
  });
});
