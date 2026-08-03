import { describe, expect, it } from 'vitest';
import {
  computeInputsDigest,
  computePlanDigest,
  isPlanDigestCurrent,
} from '../../../../src/core/ir/digest.js';
import type { DigestInputs } from '../../../../src/core/ir/digest.js';
import type { NormalizedTestMd } from '../../../../src/core/ir/normalize.js';
import { GroundingDocument, PlanDocument } from '../../../../src/core/ir/schema.js';
import type { JsonValueT, TargetDefinition } from '../../../../src/core/ir/schema.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function targetDefinition(baseUrl = 'https://example.test'): TargetDefinition {
  return { baseUrl, browser: 'chromium' };
}

function asNormalizedTestMd(value: string): NormalizedTestMd {
  return value as NormalizedTestMd;
}

function createInputs(overrides: Partial<DigestInputs> = {}): DigestInputs {
  return {
    normalizedTestMd: asNormalizedTestMd('# Smoke\n'),
    schemaVersion: 1,
    compilerPromptTemplateFingerprint: 'compiler-template-v1',
    targetDefinitions: { app: targetDefinition() },
    ...overrides,
  };
}

function createPlan({
  inputsDigest = DIGEST_A,
  targetBaseUrl = 'https://example.test',
  navigateUrl = 'https://example.test/login',
  compilerMeta,
}: {
  inputsDigest?: string;
  targetBaseUrl?: string;
  navigateUrl?: string;
  compilerMeta?: Record<string, JsonValueT>;
} = {}): PlanDocument {
  return PlanDocument.parse({
    schemaVersion: 1,
    source: { inputsDigest },
    ...(compilerMeta === undefined ? {} : { compilerMeta }),
    targets: { app: targetDefinition(targetBaseUrl) },
    steps: [
      {
        id: 'navigate-home',
        kind: 'action',
        action: 'navigate',
        url: navigateUrl,
      },
    ],
  });
}

function createGrounding(planDigest: string): GroundingDocument {
  return GroundingDocument.parse({
    schemaVersion: 1,
    planDigest,
    entries: {},
  });
}

describe('computeInputsDigest', () => {
  it('returns lowercase SHA-256 hex for equivalent inputs constructed in different orders', () => {
    const first = createInputs({
      targetDefinitions: {
        production: targetDefinition('https://production.example.test'),
        staging: targetDefinition('https://staging.example.test'),
      },
    });
    const second = createInputs({
      targetDefinitions: {
        staging: targetDefinition('https://staging.example.test'),
        production: targetDefinition('https://production.example.test'),
      },
    });

    expect(computeInputsDigest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeInputsDigest(first)).toBe(computeInputsDigest(second));
  });

  // The expected SHA-256 was calculated without calling the implementation.
  // Its exact JCS preimage is {"compilerPromptTemplateFingerprint":"compiler-template-v1","normalizedTestMd":"# Smoke\n","schemaVersion":1,"targetDefinitions":{"app":{"baseUrl":"https://example.test","browser":"chromium"}}}.
  // Command: printf '%s' '{"compilerPromptTemplateFingerprint":"compiler-template-v1","normalizedTestMd":"# Smoke\n","schemaVersion":1,"targetDefinitions":{"app":{"baseUrl":"https://example.test","browser":"chromium"}}}' | shasum -a 256
  it('matches the independently derived SHA-256 oracle for the fixed preimage', () => {
    expect(computeInputsDigest(createInputs())).toBe('47d93e230bb0e2139401d889e67462843cd1bf1d0590ebe3a982661d2887c26a');
  });

  it.each([
    ['normalized test Markdown', () => createInputs({ normalizedTestMd: asNormalizedTestMd('# Changed smoke\n') })],
    ['schema version', () => createInputs({ schemaVersion: 2 })],
    ['compiler prompt-template fingerprint', () => createInputs({ compilerPromptTemplateFingerprint: 'compiler-template-v2' })],
    ['target definitions', () => createInputs({ targetDefinitions: { app: targetDefinition('https://changed.example.test') } })],
  ])('changes when only the %s changes', (_field, change) => {
    const baseline = computeInputsDigest(createInputs());

    expect(computeInputsDigest(change())).not.toBe(baseline);
  });

  it('is unchanged across fresh deep-equal input objects', () => {
    expect(computeInputsDigest(createInputs())).toBe(computeInputsDigest(createInputs()));
  });

  it('changes when a target is renamed even when its definition is identical', () => {
    const baseline = createInputs({ targetDefinitions: { production: targetDefinition() } });
    const renamed = createInputs({ targetDefinitions: { staging: targetDefinition() } });

    expect(computeInputsDigest(renamed)).not.toBe(computeInputsDigest(baseline));
  });

  it('does not change when the same named targets are inserted in a different order', () => {
    const first = createInputs({
      targetDefinitions: {
        production: targetDefinition('https://production.example.test'),
        staging: targetDefinition('https://staging.example.test'),
      },
    });
    const reordered = createInputs({
      targetDefinitions: {
        staging: targetDefinition('https://staging.example.test'),
        production: targetDefinition('https://production.example.test'),
      },
    });

    expect(computeInputsDigest(reordered)).toBe(computeInputsDigest(first));
  });

  it('hashes only its four declared fields when passed a structurally wider runtime object', () => {
    const declaredInputs = createInputs();
    const widerRuntimeInputs = {
      ...declaredInputs,
      extraRuntimeProperty: 'must not affect the digest',
    } as DigestInputs;

    expect(computeInputsDigest(widerRuntimeInputs)).toBe(computeInputsDigest(declaredInputs));
  });
});

describe('computePlanDigest', () => {
  it('excludes compilerMeta from the digest', () => {
    const withoutCompilerMeta = createPlan();
    const withCompilerMeta = createPlan({ compilerMeta: { model: 'compiler', retryCount: 1 } });

    expect(computePlanDigest(withoutCompilerMeta)).toBe(computePlanDigest(withCompilerMeta));
  });

  it.each([
    ['the input digest', createPlan({ inputsDigest: DIGEST_B })],
    ['a target definition', createPlan({ targetBaseUrl: 'https://other.example.test' })],
    ['a replay step', createPlan({ navigateUrl: 'https://example.test/dashboard' })],
  ])('changes when %s differs', (_field, changedPlan) => {
    expect(computePlanDigest(changedPlan)).not.toBe(computePlanDigest(createPlan()));
  });
});

describe('isPlanDigestCurrent', () => {
  it('accepts grounding that records the supplied plan digest', () => {
    const groundingWithA = createGrounding(DIGEST_A);

    expect(isPlanDigestCurrent(groundingWithA, DIGEST_A)).toBe(true);
  });

  it('rejects grounding that records a different plan digest', () => {
    const groundingWithB = createGrounding(DIGEST_B);

    expect(isPlanDigestCurrent(groundingWithB, DIGEST_A)).toBe(false);
  });

  it('keeps grounding current across a compilerMeta-only change but stale after a canonical plan change', () => {
    const originalPlan = createPlan();
    const planAfterCanonicalFieldChange = createPlan({
      navigateUrl: 'https://example.test/dashboard',
    });
    const planAfterCompilerMetaOnlyChange = createPlan({
      compilerMeta: { model: 'compiler-v2' },
    });
    const planDigestX = 'c'.repeat(64);
    const planDigestY = 'd'.repeat(64);
    const groundingCachedForPlanX = createGrounding(planDigestX);
    const groundingCachedForPlanY = createGrounding(planDigestY);

    expect(planAfterCanonicalFieldChange.steps).not.toEqual(originalPlan.steps);
    const { compilerMeta, ...canonicalPlanAfterCompilerMetaOnlyChange } = planAfterCompilerMetaOnlyChange;
    expect(compilerMeta).toEqual({ model: 'compiler-v2' });
    expect(canonicalPlanAfterCompilerMetaOnlyChange).toEqual(originalPlan);
    expect(isPlanDigestCurrent(groundingCachedForPlanX, planDigestX)).toBe(true);
    expect(isPlanDigestCurrent(groundingCachedForPlanX, planDigestY)).toBe(false);
    expect(isPlanDigestCurrent(groundingCachedForPlanY, planDigestY)).toBe(true);

    // computePlanDigest's compilerMeta exclusion is tested separately above.
    // This test verifies current/stale comparison once that calculation has
    // supplied the unchanged digest for a compilerMeta-only plan change.
    const planDigestAfterCompilerMetaOnlyChange = planDigestX;

    expect(isPlanDigestCurrent(groundingCachedForPlanX, planDigestAfterCompilerMetaOnlyChange)).toBe(true);
  });
});
