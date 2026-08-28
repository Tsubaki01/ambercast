/**
 * Declares the generation-time semantic inputs that stale committed plans.
 *
 * This core-owned boundary represents static prompt and response contracts
 * directly, while revision counters stand in for usecase-layer transforms
 * that core must not import. One closed manifest serves both aggregate
 * freshness and compact diagnostics (Issue #204).
 */

import {
  GENERATE_PLAN_TASK_INSTRUCTION,
  GENERATOR_PROMPT_TEMPLATE,
} from '#core/ai/prompt-envelope.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { sha256HexOfCanonicalJson } from '#core/ir/digest.js';
import {
  GeneratedPlanResponse,
  GeneratedPlanResponseForPolicy,
  type JsonValueT,
} from '#core/ir/schema.js';

/**
 * Records human-maintained revisions for producer transforms outside core.
 *
 * The counters change only when their corresponding transform can change a
 * committed plan's meaning. Hashing source files would violate architecture
 * layering, so explicit revisions make that semantic dependency reviewable.
 */
export const PLAN_PRODUCER_SEMANTIC_REVISIONS = Object.freeze({
  instructionCoveragePolicy: 1,
  generatorSecretPolicy: 1,
} as const);

/**
 * Contains every declared semantic input to the producer bundle.
 *
 * Required members make omissions visible to TypeScript at manifest and
 * diagnostic call sites instead of allowing a wider runtime object to add
 * unreviewed provenance inputs.
 */
export interface PlanProducerBundleInputs {
  readonly generatorPromptTemplate: string;
  readonly generatorTaskInstruction: string;
  readonly generatedPlanResponseSchema: JsonValueT;
  readonly generatedPlanResponseLocalContract: JsonValueT;
  readonly instructionCoveragePolicyRevision: number;
  readonly generatorSecretPolicyRevision: number;
}

/**
 * Names the fixed manifest components for inventory and diagnostic checks.
 *
 * This list reflects semantic inputs rather than source-module names, so it
 * stays aligned with the closed input contract even when implementation files
 * are reorganized.
 */
export const PLAN_PRODUCER_BUNDLE_COMPONENT_NAMES = Object.freeze([
  'generatorPromptTemplate',
  'generatorTaskInstruction',
  'generatedPlanResponseSchema',
  'generatedPlanResponseLocalContract',
  'instructionCoveragePolicyRevision',
  'generatorSecretPolicyRevision',
] as const satisfies readonly (keyof PlanProducerBundleInputs)[]);

/**
 * Represents the exact JSON-shaped producer manifest.
 *
 * The mapped type preserves the required input keys rather than widening to a
 * string record, allowing the fingerprint preimage to remain closed.
 */
export type PlanProducerBundleManifest = { readonly [K in keyof PlanProducerBundleInputs]: JsonValueT };

/**
 * Reconstructs the closed manifest from declared producer inputs.
 *
 * Each declared member is copied into a fixed preimage rather than hashing
 * `inputs` directly, so extra runtime properties can
 * never silently affect committed-plan freshness.
 *
 * @param inputs - The complete semantic producer contract.
 * @returns The JSON-shaped provenance manifest.
 */
export function planProducerBundleManifest(inputs: PlanProducerBundleInputs): PlanProducerBundleManifest {
  return {
    generatorPromptTemplate: inputs.generatorPromptTemplate,
    generatorTaskInstruction: inputs.generatorTaskInstruction,
    generatedPlanResponseSchema: inputs.generatedPlanResponseSchema,
    generatedPlanResponseLocalContract: inputs.generatedPlanResponseLocalContract,
    instructionCoveragePolicyRevision: inputs.instructionCoveragePolicyRevision,
    generatorSecretPolicyRevision: inputs.generatorSecretPolicyRevision,
  };
}

/**
 * Computes the canonical aggregate fingerprint of a producer manifest.
 *
 * This reuses the IR canonical-JSON hash primitive so producer provenance and
 * other artifact digests share serialization
 * invariants rather than duplicating hashing behavior.
 *
 * @param inputs - The complete semantic producer contract.
 * @returns The lowercase SHA-256 producer-bundle fingerprint.
 */
export function computePlanProducerBundleFingerprint(inputs: PlanProducerBundleInputs): string {
  return sha256HexOfCanonicalJson(planProducerBundleManifest(inputs));
}

/**
 * Computes the fingerprint for the live generation producer configuration.
 *
 * This convenience wrapper centralizes static prompt, schema, and
 * transform-revision assembly so use cases cannot diverge from the manifest
 * recorded in generated-plan provenance.
 *
 * @returns The current lowercase SHA-256 producer-bundle fingerprint.
 */
export function planProducerBundleFingerprint(): string {
  return computePlanProducerBundleFingerprint(liveProducerBundleInputs());
}

/**
 * Assembles the semantic inputs for the live generation producer.
 *
 * This factory is the assembly point for static templates, response contracts,
 * and transform revisions. Sharing it with diagnostics
 * prevents the recorded component breakdown from describing different inputs
 * than the convenience fingerprint used for freshness.
 *
 * @returns The current complete producer-bundle input contract.
 */
export function liveProducerBundleInputs(): PlanProducerBundleInputs {
  return {
    generatorPromptTemplate: GENERATOR_PROMPT_TEMPLATE,
    generatorTaskInstruction: GENERATE_PLAN_TASK_INSTRUCTION,
    generatedPlanResponseSchema: typedJsonSchema(GeneratedPlanResponse) as unknown as JsonValueT,
    generatedPlanResponseLocalContract: typedJsonSchema(GeneratedPlanResponseForPolicy) as unknown as JsonValueT,
    instructionCoveragePolicyRevision: PLAN_PRODUCER_SEMANTIC_REVISIONS.instructionCoveragePolicy,
    generatorSecretPolicyRevision: PLAN_PRODUCER_SEMANTIC_REVISIONS.generatorSecretPolicy,
  };
}

/**
 * Provides a compact, per-component explanation of a bundle fingerprint.
 *
 * Large prompt and schema values are represented by individual hashes, while
 * compact revision integers remain readable raw values. This avoids
 * duplicating complete schemas and templates into every generated artifact.
 */
export interface PlanProducerBundleComponentDiagnostics {
  readonly generatorPromptTemplate: string;
  readonly generatorTaskInstruction: string;
  readonly generatedPlanResponseSchema: string;
  readonly generatedPlanResponseLocalContract: string;
  readonly instructionCoveragePolicyRevision: number;
  readonly generatorSecretPolicyRevision: number;
}

/**
 * Derives the compact diagnostic breakdown for `generatorMeta`.
 *
 * Diagnostics remain non-authoritative: they explain a freshness mismatch but
 * never participate in replay plan digests.
 *
 * @param inputs - The complete semantic producer contract.
 * @returns Per-component hashes and revision values for diagnostics.
 */
export function planProducerBundleComponentDiagnostics(
  inputs: PlanProducerBundleInputs,
): PlanProducerBundleComponentDiagnostics {
  return {
    generatorPromptTemplate: sha256HexOfCanonicalJson(inputs.generatorPromptTemplate),
    generatorTaskInstruction: sha256HexOfCanonicalJson(inputs.generatorTaskInstruction),
    generatedPlanResponseSchema: sha256HexOfCanonicalJson(inputs.generatedPlanResponseSchema),
    generatedPlanResponseLocalContract: sha256HexOfCanonicalJson(inputs.generatedPlanResponseLocalContract),
    instructionCoveragePolicyRevision: inputs.instructionCoveragePolicyRevision,
    generatorSecretPolicyRevision: inputs.generatorSecretPolicyRevision,
  };
}
