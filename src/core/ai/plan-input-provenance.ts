/**
 * Declares the sole live assembly boundary for a generated plan's input
 * provenance.
 *
 * This authority keeps use cases from independently
 * rebuilding the five-field digest preimage, which could otherwise let prompt
 * template, schema, or producer-bundle changes disagree about freshness. The
 * low-level {@link computeInputsDigest} primitive and its `DigestInputs`
 * contract remain unchanged: this module supplies their live values,
 * rather than widening or duplicating that core boundary.
 */
import type { PlanProducerBundleInputs } from '#core/ai/plan-producer-bundle.js';
import {
  computePlanProducerBundleFingerprint,
  liveProducerBundleInputs,
} from '#core/ai/plan-producer-bundle.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { computeInputsDigest } from '#core/ir/digest.js';
import type { NormalizedTestMd } from '#core/ir/normalize.js';
import { PLAN_SCHEMA_VERSION, type TargetDefinition } from '#core/ir/schema.js';

/**
 * Provides the related provenance values assembled from one producer-bundle
 * snapshot.
 *
 * Returning the inputs alongside both derived strings lets generation
 * retain its component diagnostics without asking the three consumers that
 * need only freshness to pay for those diagnostics. The authority derives all
 * three members from one live snapshot, so a fingerprint and
 * the digest that embeds it cannot describe different producer contracts.
 */
export interface PlanInputProvenance {
  readonly inputsDigest: string;
  readonly producerBundleInputs: PlanProducerBundleInputs;
  readonly producerBundleFingerprint: string;
}

/**
 * Derives the live provenance contract for a plan generation input.
 *
 * This is the only production location that calls `computeInputsDigest`. It
 * assembles the closed producer manifest once by taking exactly one
 * `liveProducerBundleInputs()` snapshot. It then
 * computes `producerBundleFingerprint` from that exact snapshot before
 * embedding the fingerprint into the digest alongside the normalized prompt,
 * `PLAN_SCHEMA_VERSION` (never `GROUNDING_SCHEMA_VERSION`),
 * prompt-template fingerprint, and named targets. This construction sequence
 * preserves the primitive's explicit input contract while making divergent
 * live assembly impossible at use-case call sites.
 *
 * @param params - The normalized prompt and resolved targets whose changes
 * participate in plan freshness.
 * @returns The digest plus the matching producer-bundle inputs and
 * fingerprint for consumers that need diagnostics.
 * @example
 * ```ts
 * const provenance = deriveCurrentPlanInputProvenance({
 *   normalizedTestMd,
 *   targetDefinitions,
 * });
 * useFreshnessDigest(provenance.inputsDigest);
 * ```
 */
export function deriveCurrentPlanInputProvenance(params: {
  readonly normalizedTestMd: NormalizedTestMd;
  readonly targetDefinitions: Readonly<Record<string, TargetDefinition>>;
}): PlanInputProvenance {
  const producerBundleInputs = liveProducerBundleInputs();
  const producerBundleFingerprint = computePlanProducerBundleFingerprint(producerBundleInputs);
  const inputsDigest = computeInputsDigest({
    normalizedTestMd: params.normalizedTestMd,
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    planProducerBundleFingerprint: producerBundleFingerprint,
    targetDefinitions: params.targetDefinitions,
  });

  return { inputsDigest, producerBundleInputs, producerBundleFingerprint };
}
