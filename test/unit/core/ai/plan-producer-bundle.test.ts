import { describe, expect, it } from 'vitest';
import {
  computePlanProducerBundleFingerprint,
  liveProducerBundleInputs,
  PLAN_PRODUCER_BUNDLE_COMPONENT_NAMES,
  planProducerBundleComponentDiagnostics,
  planProducerBundleFingerprint,
  planProducerBundleManifest,
  type PlanProducerBundleInputs,
} from '#core/ai/plan-producer-bundle.js';

function createInputs(overrides: Partial<PlanProducerBundleInputs> = {}): PlanProducerBundleInputs {
  return {
    generatorPromptTemplate: 'template',
    generatorTaskInstruction: 'task',
    generatedPlanResponseSchema: { type: 'object' },
    generatedPlanResponseLocalContract: { type: 'object', additionalProperties: false },
    instructionCoveragePolicyRevision: 1,
    generatorSecretPolicyRevision: 1,
    ...overrides,
  };
}

describe('plan producer bundle', () => {
  it('returns deterministic lowercase SHA-256 hex for deep-equal inputs', () => {
    expect(computePlanProducerBundleFingerprint(createInputs())).toMatch(/^[0-9a-f]{64}$/);
    expect(computePlanProducerBundleFingerprint(createInputs())).toBe(computePlanProducerBundleFingerprint(createInputs()));
  });

  it('matches the independently derived SHA-256 oracle for a six-field preimage', () => {
    // Recorded with: printf '%s' '<canonical six-field JSON preimage>' | shasum -a 256
    expect(computePlanProducerBundleFingerprint(createInputs())).toBe('2f5046995ee6207a945716030a97de787fb9baefb72fcea8bf51c4c857bdc5be');
  });

  it.each(Object.entries({
    generatorPromptTemplate: (inputs: PlanProducerBundleInputs) => ({ ...inputs, generatorPromptTemplate: 'changed template' }),
    generatorTaskInstruction: (inputs: PlanProducerBundleInputs) => ({ ...inputs, generatorTaskInstruction: 'changed task' }),
    generatedPlanResponseSchema: (inputs: PlanProducerBundleInputs) => ({ ...inputs, generatedPlanResponseSchema: { type: 'array' } }),
    generatedPlanResponseLocalContract: (inputs: PlanProducerBundleInputs) => ({ ...inputs, generatedPlanResponseLocalContract: { type: 'array' } }),
    instructionCoveragePolicyRevision: (inputs: PlanProducerBundleInputs) => ({ ...inputs, instructionCoveragePolicyRevision: 2 }),
    generatorSecretPolicyRevision: (inputs: PlanProducerBundleInputs) => ({ ...inputs, generatorSecretPolicyRevision: 2 }),
  } satisfies { [K in keyof PlanProducerBundleInputs]-?: (inputs: PlanProducerBundleInputs) => PlanProducerBundleInputs }))(
    'changes when only %s changes',
    (_field, mutate) => expect(computePlanProducerBundleFingerprint(mutate(createInputs())))
      .not.toBe(computePlanProducerBundleFingerprint(createInputs())),
  );

  it('keeps the manifest shape aligned with its exported component inventory', () => {
    expect(Object.keys(planProducerBundleManifest(createInputs())).sort())
      .toEqual([...PLAN_PRODUCER_BUNDLE_COMPONENT_NAMES].sort());
  });

  it('assembles the live fingerprint from a cold module load', () => {
    expect(planProducerBundleFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(liveProducerBundleInputs()).toBeDefined();
  });

  it.each(Object.keys(createInputs()) as (keyof PlanProducerBundleInputs)[])('isolates diagnostics for %s', (field) => {
    const baseline = planProducerBundleComponentDiagnostics(createInputs());
    const changed = planProducerBundleComponentDiagnostics({ ...createInputs(), [field]: field.endsWith('Revision') ? 2 : 'changed' } as PlanProducerBundleInputs);
    expect(Object.entries(changed).filter(([key, value]) => value !== baseline[key as keyof typeof baseline]).map(([key]) => key)).toEqual([field]);
  });

  it('uses hashes for text and schema diagnostics while preserving raw revision integers', () => {
    const inputs = createInputs({ instructionCoveragePolicyRevision: 17, generatorSecretPolicyRevision: 23 });
    const diagnostics = planProducerBundleComponentDiagnostics(inputs);

    expect(diagnostics.generatorPromptTemplate).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostics.generatorTaskInstruction).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostics.generatedPlanResponseSchema).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostics.generatedPlanResponseLocalContract).toMatch(/^[0-9a-f]{64}$/);
    expect(diagnostics.instructionCoveragePolicyRevision).toBe(inputs.instructionCoveragePolicyRevision);
    expect(diagnostics.generatorSecretPolicyRevision).toBe(inputs.generatorSecretPolicyRevision);
  });
});
