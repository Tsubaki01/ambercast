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
    schemaVersion: 2,
    generatorPromptTemplateFingerprint: 'generator-template-v2',
    planProducerBundleFingerprint: 'producer-bundle-v1',
    targetDefinitions: { app: targetDefinition() },
    ...overrides,
  };
}

function createPlan({
  inputsDigest = DIGEST_A,
  targetBaseUrl = 'https://example.test',
  navigateUrl = 'https://example.test/login',
  generatorMeta,
}: {
  inputsDigest?: string;
  targetBaseUrl?: string;
  navigateUrl?: string;
  generatorMeta?: Record<string, JsonValueT>;
} = {}): PlanDocument {
  return PlanDocument.parse({
    schemaVersion: 2,
    source: { inputsDigest },
    ...(generatorMeta === undefined ? {} : { generatorMeta }),
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
  // Its exact JCS preimage is {"generatorPromptTemplateFingerprint":"generator-template-v2","normalizedTestMd":"# Smoke\n","planProducerBundleFingerprint":"producer-bundle-v1","schemaVersion":2,"targetDefinitions":{"app":{"baseUrl":"https://example.test","browser":"chromium"}}}.
  // Command: printf '%s' '{"generatorPromptTemplateFingerprint":"generator-template-v2","normalizedTestMd":"# Smoke\n","planProducerBundleFingerprint":"producer-bundle-v1","schemaVersion":2,"targetDefinitions":{"app":{"baseUrl":"https://example.test","browser":"chromium"}}}' | shasum -a 256
  it('matches the independently derived SHA-256 oracle for the fixed preimage', () => {
    expect(computeInputsDigest(createInputs())).toBe('7500082d9b70d1e2186bb1043b80538395d38de0a37a112ca70f2125de647385');
  });

  // The `-?` modifier prevents a future optional DigestInputs field from silently evading this completeness check.
  // Each mutator receives the baseline and returns a new object that changes only the field it covers.
  interface FieldMutation {
    readonly displayName: string;
    readonly mutate: (inputs: DigestInputs) => DigestInputs;
  }

  const FIELD_MUTATIONS: { [K in keyof DigestInputs]-?: FieldMutation } = {
    normalizedTestMd: {
      displayName: 'normalized test Markdown',
      mutate: (inputs) => ({ ...inputs, normalizedTestMd: asNormalizedTestMd('# Changed smoke\n') }),
    },
    schemaVersion: {
      displayName: 'schema version',
      mutate: (inputs) => ({ ...inputs, schemaVersion: inputs.schemaVersion + 1 }),
    },
    generatorPromptTemplateFingerprint: {
      displayName: 'generator prompt-template fingerprint',
      mutate: (inputs) => ({ ...inputs, generatorPromptTemplateFingerprint: 'generator-template-v2-mutated' }),
    },
    planProducerBundleFingerprint: {
      displayName: 'plan producer-bundle fingerprint',
      mutate: (inputs) => ({ ...inputs, planProducerBundleFingerprint: 'producer-bundle-v1-mutated' }),
    },
    targetDefinitions: {
      displayName: 'target definitions',
      mutate: (inputs) => ({
        ...inputs,
        targetDefinitions: { app: targetDefinition('https://changed.example.test') },
      }),
    },
  };

  it.each(Object.values(FIELD_MUTATIONS))('changes when only the $displayName changes', ({ mutate }) => {
    const baseline = createInputs();

    expect(computeInputsDigest(mutate(baseline))).not.toBe(computeInputsDigest(baseline));
  });

  it('is unchanged across fresh deep-equal input objects', () => {
    expect(computeInputsDigest(createInputs())).toBe(computeInputsDigest(createInputs()));
  });

  it('changes when a target is renamed even when its definition is identical', () => {
    const baseline = createInputs({ targetDefinitions: { production: targetDefinition() } });
    const renamed = createInputs({ targetDefinitions: { staging: targetDefinition() } });

    expect(computeInputsDigest(renamed)).not.toBe(computeInputsDigest(baseline));
  });

  it('changes when only a target secret-sink origin policy changes', () => {
    const baseline = createInputs();
    const changed = createInputs({
      targetDefinitions: {
        app: {
          ...targetDefinition(),
          secretSinkOrigins: { '{{secrets.app.password}}': ['https://idp.example.test'] },
        },
      },
    });

    expect(computeInputsDigest(changed)).not.toBe(computeInputsDigest(baseline));
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

  it('hashes only its five declared fields when passed a structurally wider runtime object', () => {
    const declaredInputs = createInputs();
    const widerRuntimeInputs = {
      ...declaredInputs,
      extraRuntimeProperty: 'must not affect the digest',
    } as DigestInputs;

    expect(computeInputsDigest(widerRuntimeInputs)).toBe(computeInputsDigest(declaredInputs));
  });
});

describe('computePlanDigest', () => {
  it('excludes generatorMeta from the digest', () => {
    const withoutGeneratorMeta = createPlan();
    const withGeneratorMeta = createPlan({ generatorMeta: { model: 'generator', retryCount: 1 } });

    expect(computePlanDigest(withoutGeneratorMeta)).toBe(computePlanDigest(withGeneratorMeta));
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

  it('tracks grounding provenance through real plan digest calculations', () => {
    const originalPlan = createPlan();
    const originalPlanDigest = computePlanDigest(originalPlan);
    const groundingCachedForOriginalPlan = createGrounding(originalPlanDigest);
    const planAfterCanonicalFieldChange = createPlan({
      navigateUrl: 'https://example.test/dashboard',
    });
    const planAfterGeneratorMetaOnlyChange = createPlan({
      generatorMeta: { model: 'generator-v2' },
    });
    const canonicalChangePlanDigest = computePlanDigest(planAfterCanonicalFieldChange);
    const generatorMetaOnlyChangePlanDigest = computePlanDigest(planAfterGeneratorMetaOnlyChange);

    expect(isPlanDigestCurrent(groundingCachedForOriginalPlan, originalPlanDigest)).toBe(true);
    expect(canonicalChangePlanDigest).not.toBe(originalPlanDigest);
    expect(isPlanDigestCurrent(groundingCachedForOriginalPlan, canonicalChangePlanDigest)).toBe(false);
    expect(generatorMetaOnlyChangePlanDigest).toBe(originalPlanDigest);
    expect(isPlanDigestCurrent(groundingCachedForOriginalPlan, generatorMetaOnlyChangePlanDigest)).toBe(true);
  });
});
