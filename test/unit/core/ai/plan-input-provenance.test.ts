import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as planProducerBundle from '#core/ai/plan-producer-bundle.js';
import { deriveCurrentPlanInputProvenance } from '#core/ai/plan-input-provenance.js';
import { computeInputsDigest, type DigestInputs } from '#core/ir/digest.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import type { NormalizedTestMd } from '#core/ir/normalize.js';
import { PLAN_SCHEMA_VERSION, type TargetDefinition } from '#core/ir/schema.js';

const NORMALIZED = '# Sign in\n' as NormalizedTestMd;
const SINGLE_TARGET = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const satisfies Readonly<Record<string, TargetDefinition>>;
const MULTIPLE_TARGETS = {
  staging: { baseUrl: 'https://staging.example.test', browser: 'chromium' },
  production: { baseUrl: 'https://production.example.test', browser: 'chromium' },
} as const satisfies Readonly<Record<string, TargetDefinition>>;

function sha256(preimage: string): string {
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

describe('deriveCurrentPlanInputProvenance()', () => {
  it.each([
    ['one target', SINGLE_TARGET],
    ['multiple targets', MULTIPLE_TARGETS],
    ['no targets', {}],
  ] as const)('returns a lowercase inputs digest for %s', (_name, targetDefinitions) => {
    expect(deriveCurrentPlanInputProvenance({ normalizedTestMd: NORMALIZED, targetDefinitions })).toMatchObject({
      inputsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      producerBundleFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('matches the independently fixed SHA-256 oracle for a fixed DigestInputs vector', () => {
    const fixedInputs: DigestInputs = {
      normalizedTestMd: '# Fixed\n' as NormalizedTestMd,
      schemaVersion: PLAN_SCHEMA_VERSION,
      generatorPromptTemplateFingerprint: 'fixed-template-fingerprint',
      planProducerBundleFingerprint: 'fixed-bundle-fingerprint',
      targetDefinitions: { web: { baseUrl: 'https://fixed.example.test', browser: 'chromium' } },
    };
    const fixedCanonicalPreimage = '{"generatorPromptTemplateFingerprint":"fixed-template-fingerprint","normalizedTestMd":"# Fixed\\n","planProducerBundleFingerprint":"fixed-bundle-fingerprint","schemaVersion":2,"targetDefinitions":{"web":{"baseUrl":"https://fixed.example.test","browser":"chromium"}}}';
    const fixedExpectedDigest = 'c40cd8e81d15e47927e020a517c2ccdd326d8cb010e4be60aea6777edcdb5b23';

    expect(sha256(fixedCanonicalPreimage)).toBe(fixedExpectedDigest);
    expect(computeInputsDigest(fixedInputs)).toBe(fixedExpectedDigest);
  });

  it('is independent of target-definition insertion order', () => {
    const first = deriveCurrentPlanInputProvenance({ normalizedTestMd: NORMALIZED, targetDefinitions: MULTIPLE_TARGETS });
    const second = deriveCurrentPlanInputProvenance({
      normalizedTestMd: NORMALIZED,
      targetDefinitions: {
        production: MULTIPLE_TARGETS.production,
        staging: MULTIPLE_TARGETS.staging,
      },
    });

    expect(first.inputsDigest).toBe(second.inputsDigest);
  });

  it('makes prompt and target changes stale relative to the same authority contract', () => {
    const fresh = deriveCurrentPlanInputProvenance({ normalizedTestMd: NORMALIZED, targetDefinitions: SINGLE_TARGET });
    const changedPrompt = deriveCurrentPlanInputProvenance({ normalizedTestMd: '# Changed\n' as NormalizedTestMd, targetDefinitions: SINGLE_TARGET });
    const changedTarget = deriveCurrentPlanInputProvenance({
      normalizedTestMd: NORMALIZED,
      targetDefinitions: { web: { ...SINGLE_TARGET.web, baseUrl: 'https://changed.example.test' } },
    });

    expect(fresh.inputsDigest).not.toBe(changedPrompt.inputsDigest);
    expect(fresh.inputsDigest).not.toBe(changedTarget.inputsDigest);
  });

  it('derives every returned bundle value from exactly one live snapshot', () => {
    const producerBundleInputs = {
      generatorPromptTemplate: 'template',
      generatorTaskInstruction: 'task',
      generatedPlanResponseSchema: { type: 'object' },
      generatedPlanResponseLocalContract: { type: 'object' },
      instructionCoveragePolicyRevision: 7,
      generatorSecretPolicyRevision: 11,
    };
    const liveInputs = vi.spyOn(planProducerBundle, 'liveProducerBundleInputs').mockReturnValue(producerBundleInputs);

    try {
      const provenance = deriveCurrentPlanInputProvenance({ normalizedTestMd: NORMALIZED, targetDefinitions: SINGLE_TARGET });
      const expectedFingerprint = planProducerBundle.computePlanProducerBundleFingerprint(producerBundleInputs);
      const expectedDigestPreimage = JSON.stringify({
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        normalizedTestMd: NORMALIZED,
        planProducerBundleFingerprint: expectedFingerprint,
        schemaVersion: PLAN_SCHEMA_VERSION,
        targetDefinitions: SINGLE_TARGET,
      });

      expect(liveInputs).toHaveBeenCalledTimes(1);
      expect(provenance.producerBundleInputs).toBe(producerBundleInputs);
      expect(provenance.producerBundleFingerprint).toBe(expectedFingerprint);
      expect(provenance.inputsDigest).toBe(sha256(expectedDigestPreimage));
    } finally {
      liveInputs.mockRestore();
    }
  });
});
