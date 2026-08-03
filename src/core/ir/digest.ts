/**
 * Defines the provenance calculations that make compiled plans and grounding
 * caches independently verifiable.
 *
 * Digest inputs form a deliberately closed contract: a plan changes when its
 * normalized prompt, schema, compiler instructions, or named targets change.
 * The type is the structural half of that containment guarantee; the
 * separate static rule that restricts callers completes it (Issue #2).
 * Hashing uses the canonical JSON bytes shared with artifact
 * serialization, so construction order never changes a provenance value.
 */
import { createHash } from 'node:crypto';
import { toCanonicalDigestBytes } from './canonical-json.js';
import type { NormalizedTestMd } from './normalize.js';
import type {
  GroundingDocument,
  JsonValueT,
  PlanDocument,
  TargetDefinition,
} from './schema.js';

function sha256Hex(value: JsonValueT): string {
  return createHash('sha256').update(toCanonicalDigestBytes(value)).digest('hex');
}

/**
 * Contains every declared compiler input that participates in `inputsDigest`.
 *
 * Readonly members prevent a caller from treating the input as mutable
 * compiler state. This closed shape catches excess properties at object
 * literal call sites and documents the values whose changes require a plan to
 * be regenerated.
 */
export interface DigestInputs {
  /**
   * Supplies the prompt after representation-only normalization.
   *
   * Its brand makes the normalization boundary visible to callers before the
   * source becomes part of a provenance calculation.
   */
  readonly normalizedTestMd: NormalizedTestMd;

  /**
   * Captures the schema contract whose interpretation defines the plan.
   *
   * A schema evolution can change compilation semantics even when the prompt
   * and targets are unchanged, so it remains part of freshness provenance.
   */
  readonly schemaVersion: number;

  /**
   * Identifies the compiler instruction template used to derive the plan.
   *
   * Template changes can alter how identical prompt text is compiled and must
   * therefore make an existing artifact stale.
   */
  readonly compilerPromptTemplateFingerprint: string;

  /**
   * Preserves target names as well as their definitions in the digest input.
   *
   * Matching `PlanDocument.targets` as a named record makes a target rename
   * observable and lets canonical member ordering ignore insertion order. An
   * array would lose identity and would make semantically irrelevant ordering
   * affect freshness.
   */
  readonly targetDefinitions: Readonly<Record<string, TargetDefinition>>;
}

/**
 * Computes the canonical SHA-256 provenance digest for compiler inputs.
 *
 * @remarks Before canonical serialization, the implementation constructs a
 * fresh, fixed-shape preimage containing exactly `normalizedTestMd`,
 * `schemaVersion`, `compilerPromptTemplateFingerprint`, and
 * `targetDefinitions`. It deliberately does not hash the received `inputs`
 * object directly: a structurally wider runtime object can carry extra
 * properties, and letting those silently influence the digest would defeat
 * `DigestInputs` as a closed, declared contract.
 *
 * @param inputs - The complete declared input contract for one compilation.
 * @returns The lowercase hexadecimal digest embedded in a compiled plan.
 */
export function computeInputsDigest(inputs: DigestInputs): string {
  const preimage = {
    normalizedTestMd: inputs.normalizedTestMd,
    schemaVersion: inputs.schemaVersion,
    compilerPromptTemplateFingerprint: inputs.compilerPromptTemplateFingerprint,
    targetDefinitions: inputs.targetDefinitions,
  };

  return sha256Hex(preimage as JsonValueT);
}

/**
 * Computes the canonical SHA-256 digest that grounding uses to identify a
 * plan's replay-relevant content.
 *
 * @remarks Compiler metadata describes how a plan was produced rather than
 * what it replays, so it remains outside this digest. The calculation derives
 * its digest view without mutating the caller's plan.
 *
 * @param plan - A schema-valid compiled plan.
 * @returns The lowercase hexadecimal digest recorded by grounding artifacts.
 */
export function computePlanDigest(plan: PlanDocument): string {
  const { compilerMeta: _compilerMeta, ...canonicalPlan } = plan;

  return sha256Hex(canonicalPlan as JsonValueT);
}

/**
 * Answers whether grounding provenance matches a supplied plan digest.
 *
 * @remarks This is a narrow, pure equality helper. It does not decide how to
 * handle a stale cache; errors, exits, and local-versus-CI policy remain
 * outside the IR trust kernel.
 *
 * @param grounding - The grounding cache whose recorded provenance is read.
 * @param planDigest - The digest calculated for the plan under consideration.
 * @returns `true` only when both provenance values are identical.
 */
export function isPlanDigestCurrent(
  grounding: GroundingDocument,
  planDigest: string,
): boolean {
  return grounding.planDigest === planDigest;
}
