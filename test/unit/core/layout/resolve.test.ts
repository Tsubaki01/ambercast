import { describe, expect, it } from 'vitest';
import type { LayoutConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { GROUNDING_SUFFIX, PLAN_SUFFIX, createLayoutResolver } from '#core/layout/resolve.js';

const CONFIG = {
  testDir: '/workspace/tests/ambercast',
  runsDir: '/workspace/.runs',
} as const satisfies LayoutConfig;
const RUN_ID = '2026-08-01T090000Z-550e8400-e29b-41d4-a716-446655440000';

describe('companion suffix exports', () => {
  it('provides the exact suffixes shared by configuration and discovery', () => {
    expect({ PLAN_SUFFIX, GROUNDING_SUFFIX }).toStrictEqual({
      PLAN_SUFFIX: '.ambercast.plan.json',
      GROUNDING_SUFFIX: '.ambercast.grounding.json',
    });
  });
});

describe('createLayoutResolver', () => {
  it('constructs a resolver for a well-formed absolute layout configuration', () => {
    expect(() => createLayoutResolver(CONFIG)).not.toThrow();
  });

  it('constructs a resolver when testDir is the absolute root boundary', () => {
    expect(() => createLayoutResolver({ testDir: '/', runsDir: '/workspace/.runs' })).not.toThrow();
  });

  it.each([
    ['testDir', '', '', '/workspace/.runs'],
    ['testDir', 'tests/ambercast', 'tests/ambercast', '/workspace/.runs'],
    ['testDir', '.', '.', '/workspace/.runs'],
    ['testDir', '/workspace/tests/../tests/ambercast', '/workspace/tests/../tests/ambercast', '/workspace/.runs'],
    ['testDir', '/workspace/tests/./ambercast', '/workspace/tests/./ambercast', '/workspace/.runs'],
    ['testDir', '/workspace/tests//ambercast', '/workspace/tests//ambercast', '/workspace/.runs'],
    ['testDir', '/workspace/tests/ambercast/', '/workspace/tests/ambercast/', '/workspace/.runs'],
    ['runsDir', 'workspace/.runs', '/workspace/tests/ambercast', 'workspace/.runs'],
    ['runsDir', '/workspace/.runs/', '/workspace/tests/ambercast', '/workspace/.runs/'],
  ] as const)('rejects malformed %s %j during construction', (invalidField, invalidValue, testDir, runsDir) => {
    let thrown: unknown;

    try {
      createLayoutResolver({ testDir, runsDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigInvalidError);

    if (thrown instanceof ConfigInvalidError) {
      expect(thrown.message).toContain(invalidField);
      expect(thrown.details?.[invalidField]).toBe(invalidValue);
      expect(thrown.cause).toBeInstanceOf(RangeError);
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
    ['/workspace/tests/ambercast/login.test.md', `/workspace/.runs/${RUN_ID}/login`],
    ['/workspace/tests/ambercast/ui/checkout.mobile.test.md', `/workspace/.runs/${RUN_ID}/ui/checkout.mobile`],
    ['/workspace/tests/ambercast/deep/a/b/case.test.md', `/workspace/.runs/${RUN_ID}/deep/a/b/case`],
  ] as const)('maps test %s into its dedicated run directory %s', (testPath, runsDir) => {
    expect(resolver.runsDirFor(testPath, RUN_ID)).toBe(runsDir);
  });

  it.each(['planPathFor', 'groundingPathFor'] as const)('%s rejects an anonymous empty-stem test path', (method) => {
    expect(() => resolver[method]('/workspace/tests/ambercast/.test.md')).toThrow(RangeError);
  });

  it('rejects an anonymous empty-stem test path when deriving a run directory', () => {
    expect(() => resolver.runsDirFor('/workspace/tests/ambercast/.test.md', RUN_ID)).toThrow(RangeError);
  });

  it('prevents the previously colliding named and anonymous test paths from sharing a runs directory', () => {
    const namedTestPath = '/workspace/tests/ambercast/ui.test.md';
    const anonymousTestPath = '/workspace/tests/ambercast/ui/.test.md';

    expect(resolver.runsDirFor(namedTestPath, RUN_ID)).toBe(`/workspace/.runs/${RUN_ID}/ui`);
    expect(() => resolver.runsDirFor(anonymousTestPath, RUN_ID)).toThrow(RangeError);
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
    expect(rootResolver.runsDirFor(testPath, RUN_ID)).toBe(`/.runs/${RUN_ID}/日本語/space name/@scope/[case]`);
  });

  it('keeps different invocations for the same test in separate evidence directories', () => {
    const firstRunId = '2026-08-01T090000Z-550e8400-e29b-41d4-a716-446655440000';
    const secondRunId = '2026-08-01T090000Z-550e8400-e29b-41d4-a716-446655440001';

    expect(resolver.runsDirFor('/workspace/tests/ambercast/login.test.md', firstRunId))
      .toBe(`/workspace/.runs/${firstRunId}/login`);
    expect(resolver.runsDirFor('/workspace/tests/ambercast/login.test.md', secondRunId))
      .toBe(`/workspace/.runs/${secondRunId}/login`);
  });

  it('maps an invocation report directly under its validated run directory', () => {
    expect(resolver.runReportPathFor(RUN_ID)).toBe(`/workspace/.runs/${RUN_ID}/report.json`);
  });

  it.each(['', '.', '..', 'nested/run', '/absolute', 'back\\slash', 'a--b', '-a', 'a-', 'a_b', 'with space'] as const)(
    'rejects unsafe invocation identity %j for every run-artifact mapping',
    (runId) => {
      expect(() => resolver.runsDirFor('/workspace/tests/ambercast/login.test.md', runId)).toThrow(RangeError);
      expect(() => resolver.runReportPathFor(runId)).toThrow(RangeError);
    },
  );

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

  it.each(['planPathFor', 'groundingPathFor'] as const)('%s rejects every path outside its discovered-test domain', (method) => {
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

  it('rejects every path outside its discovered-test domain when deriving a run directory', () => {
    for (const testPath of [
      '/workspace/other/login.test.md',
      '/workspace/tests/ambercast-evil/login.test.md',
      'login.test.md',
      '/workspace/tests/ambercast/./login.test.md',
      '/workspace/tests/ambercast/login.md',
    ]) {
      expect(() => resolver.runsDirFor(testPath, RUN_ID)).toThrow(RangeError);
    }
  });
});
