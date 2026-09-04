import { describe, expect, it } from 'vitest';
import { validateAiResponse } from '#adapters/ai/shared/response-validator.js';
import {
  computePlanProducerBundleFingerprint,
  liveProducerBundleInputs,
  PLAN_PRODUCER_BUNDLE_COMPONENT_NAMES,
  planProducerBundleComponentDiagnostics,
  planProducerBundleFingerprint,
  planProducerBundleManifest,
  type PlanProducerBundleInputs,
} from '#core/ai/plan-producer-bundle.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { GeneratedPlanResponseRequest } from '#core/ir/schema.js';

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
    expect(liveProducerBundleInputs().generatedPlanResponseSchema).toEqual(
      typedJsonSchema(GeneratedPlanResponseRequest),
    );
  });

  it('accepts an AI step with an empty verification intent through AJV', () => {
    const response = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete the sign-in flow.',
        instructionCoverage: [{
          id: 'submit-credentials',
          kind: 'action',
          citation: 'Submit the credentials.',
        }],
        verificationIntent: [],
      }],
      ambiguities: [],
    };

    const result = validateAiResponse(
      JSON.stringify(response),
      typedJsonSchema(GeneratedPlanResponseRequest),
    );

    expect(result.steps[0]?.kind).toBe('ai');
    if (result.steps[0]?.kind !== 'ai') {
      throw new Error('Expected the response to contain one AI step.');
    }
    expect(result.steps[0].verificationIntent).toEqual([]);
  });

  it('rejects an AI step with empty instruction coverage through AJV', () => {
    const response = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete the sign-in flow.',
        instructionCoverage: [],
        verificationIntent: [{
          criterionId: 'dashboard-reached',
          assertion: { type: 'assert', check: 'text-visible', text: 'Dashboard' },
        }],
      }],
      ambiguities: [],
    };

    expect(() => validateAiResponse(
      JSON.stringify(response),
      typedJsonSchema(GeneratedPlanResponseRequest),
    )).toThrow(AiResponseInvalidError);
  });

  it('rejects an invalid non-empty verification intent element through AJV', () => {
    const response = {
      steps: [{
        id: 'complete-sign-in',
        kind: 'ai',
        instruction: 'Complete the sign-in flow.',
        instructionCoverage: [{
          id: 'some-id',
          kind: 'action',
          citation: 'Complete the sign-in flow.',
        }],
        verificationIntent: [{
          criterionId: 'some-id',
          assertion: { type: 'not-a-real-assertion' },
        }],
      }],
      ambiguities: [],
    };

    expect(() => validateAiResponse(
      JSON.stringify(response),
      typedJsonSchema(GeneratedPlanResponseRequest),
    )).toThrow(AiResponseInvalidError);
  });

  it('has exactly one AI-shaped request alternative without a verification intent minimum', () => {
    const schema = typedJsonSchema(GeneratedPlanResponseRequest) as unknown as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const steps = properties.steps as Record<string, unknown>;
    const items = steps.items;

    function findAiSchemas(node: unknown): Record<string, unknown>[] {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        return [];
      }

      const schemaNode = node as Record<string, unknown>;
      const matches: Record<string, unknown>[] = [];
      const nodeProperties = schemaNode.properties;
      if (
        typeof nodeProperties === 'object'
        && nodeProperties !== null
        && !Array.isArray(nodeProperties)
        && Object.hasOwn(nodeProperties, 'verificationIntent')
      ) {
        matches.push(schemaNode);
      }

      for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
        const alternatives = schemaNode[keyword];
        if (Array.isArray(alternatives)) {
          for (const alternative of alternatives) {
            matches.push(...findAiSchemas(alternative));
          }
        }
      }

      return matches;
    }

    const aiSchemas = findAiSchemas(items);

    expect(aiSchemas).toHaveLength(1);
    const aiProperties = (aiSchemas[0] as Record<string, unknown>).properties as Record<string, unknown>;
    const verificationIntent = aiProperties.verificationIntent as Record<string, unknown>;
    expect(verificationIntent.minItems).toBeUndefined();
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
