import { describe, expect, it } from 'vitest';
import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { TargetDefinition } from '#core/ir/schema.js';
import { computeInputsDigest } from '#core/ir/digest.js';
import { planProducerBundleFingerprint } from '#core/ai/plan-producer-bundle.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  resolveTarget,
  toTargetDefinition,
  type TargetSelection,
} from '#core/target/resolve.js';
import type { ResolvedTargetConfigEntry } from '#core/config/schema.js';

const WEB = Object.freeze({ baseUrl: 'https://web.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const });
const ADMIN = Object.freeze({ baseUrl: 'https://admin.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const });
const MOBILE = Object.freeze({ baseUrl: 'https://mobile.example.test', browser: 'chromium' as const, healReplayIsolation: 'stateful' as const });
const WEB_DEFINITION = toTargetDefinition(WEB);
const ADMIN_DEFINITION = toTargetDefinition(ADMIN);
const MOBILE_DEFINITION = toTargetDefinition(MOBILE);

type Targets = Readonly<Record<string, Readonly<ResolvedTargetConfigEntry>>>;
type Resolution = TargetSelection | TargetUnresolvedError;

function expectSelection(result: Resolution): asserts result is TargetSelection {
  expect(result).not.toBeInstanceOf(TargetUnresolvedError);
  if (result instanceof TargetUnresolvedError) {
    throw result;
  }
}

function expectUnresolved(
  result: Resolution,
  message: string,
  details: Record<string, unknown>,
): asserts result is TargetUnresolvedError {
  expect(result).toBeInstanceOf(TargetUnresolvedError);
  if (!(result instanceof TargetUnresolvedError)) {
    throw new Error('Expected target resolution to return TargetUnresolvedError.');
  }
  expect(result).toMatchObject({
    kind: 'target-unresolved',
    exitCode: 2,
    message,
    details,
  });
  expect(result.details).toEqual(details);
}

function inheritedTarget(name: string, definition: Readonly<TargetDefinition> = WEB): Targets {
  const prototype = Object.create(null) as Record<string, Readonly<TargetDefinition>>;
  Object.defineProperty(prototype, name, { value: definition, enumerable: true });
  return Object.create(prototype) as Targets;
}

describe('resolveTarget', () => {
  it('projects live replay isolation out of plan and input-digest target definitions', () => {
    const idempotent: ResolvedTargetConfigEntry = { baseUrl: 'https://web.example.test', browser: 'chromium', healReplayIsolation: 'idempotent' };
    const stateful: ResolvedTargetConfigEntry = { ...idempotent, healReplayIsolation: 'stateful' };

    expect(toTargetDefinition(idempotent)).toEqual({ baseUrl: 'https://web.example.test', browser: 'chromium' });
    expect(toTargetDefinition(stateful)).toEqual(toTargetDefinition(idempotent));
    expect(toTargetDefinition(stateful)).not.toHaveProperty('healReplayIsolation');
  });

  it('keeps the resolved target selection input digest byte-identical across isolation-only configuration changes', () => {
    const common = { baseUrl: 'https://web.example.test', browser: 'chromium' as const };
    const idempotent: ResolvedTargetConfigEntry = { ...common, healReplayIsolation: 'idempotent' };
    const stateful: ResolvedTargetConfigEntry = { ...common, healReplayIsolation: 'stateful' };
    const digest = (target: ResolvedTargetConfigEntry) => {
      const selected = resolveTarget({ targets: { web: target }, defaultTarget: 'web', explicitTarget: undefined });
      expectSelection(selected);
      return computeInputsDigest({
        normalizedTestMd: normalizeTestMd('# test\n'),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: 'generator-template-fixture',
        planProducerBundleFingerprint: planProducerBundleFingerprint(),
        targetDefinitions: selected.definitions,
      });
    };

    expect(digest(idempotent)).toBe(digest(stateful));
  });
  it('gives an explicit own target precedence over a different valid default', () => {
    const targets = { web: WEB, admin: ADMIN };

    const result = resolveTarget({ targets, defaultTarget: 'web', explicitTarget: 'admin' });

    expectSelection(result);
    expect(result).toEqual({ name: 'admin', definition: ADMIN_DEFINITION, definitions: { admin: ADMIN_DEFINITION } });
    expect(result.definition).toEqual(ADMIN_DEFINITION);
    expect(result.definitions.admin).toEqual(ADMIN_DEFINITION);
  });

  it('honors an explicit own target even when the same target is eligible as the sole implicit key', () => {
    const targets = { admin: ADMIN };

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: 'admin' });

    expectSelection(result);
    expect(result.name).toBe('admin');
    expect(result.definition).toEqual(ADMIN_DEFINITION);
  });

  it.each([
    ['a valid default', { web: WEB, admin: ADMIN }, 'web'],
    ['a sole implicit key', { web: WEB }, undefined],
  ] as const)('does not fall back from an invalid explicit target to %s', (_case, targets, defaultTarget) => {
    const result = resolveTarget({ targets, defaultTarget, explicitTarget: 'missing' });

    expectUnresolved(result, 'The requested target is not configured.', { target: 'missing' });
  });

  it('gives a valid default precedence over implicit cardinality', () => {
    const targets = { web: WEB, admin: ADMIN };

    const result = resolveTarget({ targets, defaultTarget: 'web', explicitTarget: undefined });

    expectSelection(result);
    expect(result).toEqual({ name: 'web', definition: WEB_DEFINITION, definitions: { web: WEB_DEFINITION } });
  });

  it('selects the sole enumerable own target when named selections are absent', () => {
    const targets = { mobile: MOBILE };

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: undefined });

    expectSelection(result);
    expect(result).toEqual({ name: 'mobile', definition: MOBILE_DEFINITION, definitions: { mobile: MOBILE_DEFINITION } });
  });

  it('classifies an empty implicit target record with a stable empty target-name list', () => {
    const result = resolveTarget({ targets: {}, defaultTarget: undefined, explicitTarget: undefined });

    expectUnresolved(
      result,
      'A target could not be selected from the configured targets.',
      { target: '(default)', targetNames: [] },
    );
  });

  it('sorts ambiguous enumerable own names in the implicit error details', () => {
    const targets = Object.fromEntries([
      ['zeta', WEB],
      ['alpha', ADMIN],
      ['middle', MOBILE],
    ]);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: undefined });

    expect(Object.keys(targets)).toEqual(['zeta', 'alpha', 'middle']);
    expectUnresolved(
      result,
      'A target could not be selected from the configured targets.',
      { target: '(default)', targetNames: ['alpha', 'middle', 'zeta'] },
    );
  });

  it('uses own membership for an explicit non-enumerable target', () => {
    const targets = Object.defineProperty({}, 'hidden', {
      value: WEB,
      enumerable: false,
    }) as Targets;

    expect(Object.hasOwn(targets, 'hidden')).toBe(true);
    expect(Object.keys(targets)).toEqual([]);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: 'hidden' });

    expectSelection(result);
    expect(result.name).toBe('hidden');
    expect(result.definition).toEqual(WEB_DEFINITION);
    expect(result.definitions.hidden).toEqual(WEB_DEFINITION);
  });

  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
    'inheritedCustomTarget',
  ])('rejects inherited target name %s for explicit selection', (name) => {
    const targets = inheritedTarget(name);

    expect(Object.hasOwn(targets, name)).toBe(false);
    expect(Object.keys(targets)).toEqual([]);
    expect(targets[name]).toBe(WEB);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: name });

    expectUnresolved(result, 'The requested target is not configured.', { target: name });
  });

  it('ignores an enumerable prototype target when computing implicit cardinality', () => {
    const prototype = Object.fromEntries([['inheritedCustomTarget', ADMIN]]);
    const targets = Object.assign(Object.create(prototype) as Record<string, Readonly<ResolvedTargetConfigEntry>>, {
      web: WEB,
    });

    expect(Object.hasOwn(targets, 'inheritedCustomTarget')).toBe(false);
    expect(Object.keys(targets)).toEqual(['web']);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: undefined });

    expectSelection(result);
    expect(result).toEqual({ name: 'web', definition: WEB_DEFINITION, definitions: { web: WEB_DEFINITION } });
  });

  it.each([
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__',
  ])('selects genuine enumerable own special name %s', (name) => {
    const targets = Object.fromEntries([[name, WEB]]);

    expect(Object.hasOwn(targets, name)).toBe(true);
    expect(Object.keys(targets)).toEqual([name]);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: name });

    expectSelection(result);
    expect(result.name).toBe(name);
    expect(result.definition).toEqual(WEB_DEFINITION);
    expect(result.definitions[name]).toEqual(WEB_DEFINITION);
  });

  it.each([
    ['explicit', { '': WEB, other: ADMIN }, undefined, ''],
    ['default', { '': WEB, other: ADMIN }, '', undefined],
    ['sole implicit', { '': WEB }, undefined, undefined],
  ] as const)('selects an own empty-string target through the %s route', (
    _route,
    targets,
    defaultTarget,
    explicitTarget,
  ) => {
    expect(Object.hasOwn(targets, '')).toBe(true);

    const result = resolveTarget({ targets, defaultTarget, explicitTarget });

    expectSelection(result);
    expect(result.name).toBe('');
    expect(result.definition).toEqual(WEB_DEFINITION);
    expect(result.definitions['']).toEqual(WEB_DEFINITION);
  });

  it('does not mutate frozen inputs and exposes only the selected definition by exact identity', () => {
    const targets = Object.freeze({ web: WEB, admin: ADMIN });
    const input = Object.freeze({
      targets,
      defaultTarget: 'web' as string | undefined,
      explicitTarget: undefined as string | undefined,
    });
    const beforeEntries = Object.entries(targets);

    const result = resolveTarget(input);

    expectSelection(result);
    expect(Object.keys(result).sort()).toEqual(['definition', 'definitions', 'name']);
    expect(Object.keys(result.definitions)).toEqual(['web']);
    expect(result.definition).toEqual(WEB_DEFINITION);
    expect(result.definitions.web).toEqual(WEB_DEFINITION);
    expect(Object.hasOwn(result.definitions, 'admin')).toBe(false);
    expect(Object.entries(targets)).toEqual(beforeEntries);
    expect(Object.isFrozen(targets)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
  });

  it('constructs an own __proto__ selection property without mutating the output prototype', () => {
    const targets = Object.fromEntries([['__proto__', WEB]]);

    expect(Object.hasOwn(targets, '__proto__')).toBe(true);
    expect(Object.keys(targets)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(targets)).toBe(Object.prototype);

    const result = resolveTarget({ targets, defaultTarget: undefined, explicitTarget: undefined });

    expectSelection(result);
    expect(Object.keys(result.definitions)).toEqual(['__proto__']);
    expect(Object.hasOwn(result.definitions, '__proto__')).toBe(true);
    expect(result.definitions.__proto__).toEqual(WEB_DEFINITION);
    expect(Object.getPrototypeOf(result.definitions)).toBe(Object.prototype);
  });
});
