import type { Step } from './schema.js';
import { createHash } from 'node:crypto';
import { toCanonicalDigestBytes } from './canonical-json.js';
import { extractStepRunRefs } from './run-ref.js';

/**
 * Computes the stable obligation fingerprint for one repairable plan step.
 *
 * @param step - The step whose semantic obligations form the canonical hash preimage.
 * @returns A SHA-256 fingerprint of the step's opcode, secret obligations,
 * instruction coverage, capture variable, and ordered run-reference usage.
 * @remarks
 * The preimage intentionally omits the step id and kind because the
 * replacement boundary checks those identity preconditions separately. It
 * keeps empty secret obligations, ordered coverage, and duplicate references
 * explicit so a provider cannot turn an omitted, reordered, or malformed
 * obligation into an apparently equivalent replacement.
 */
export function computeObligationFingerprint(step: Step): string {
  const opcode = step.kind === 'action' ? step.action : step.kind === 'assert' ? step.check : null;
  const secrets = step.kind === 'ai'
    ? (step.secrets ?? []).map(({ ref, sourceSpan }) => ({ ref, sourceSpan }))
    : step.kind === 'action' && step.action === 'fill-secret'
      ? [{ ref: step.secretRef, sourceSpan: step.secretGrantSpan }]
      : [];
  const instructionCoverage = step.kind === 'ai'
    ? step.instructionCoverage.map(({ id, kind, sourceSpan }) => ({ id, kind, sourceSpan }))
    : [];
  const capture = step.kind === 'capture' ? step.variable : null;
  return createHash('sha256').update(toCanonicalDigestBytes({ opcode, secrets, instructionCoverage, capture, runRefs: [...extractStepRunRefs(step)] })).digest('hex');
}

/**
 * Tests whether a proposed replacement preserves the original step's obligation.
 *
 * @param before - The committed frontier step selected for replacement.
 * @param after - The provider-proposed step at that exact position.
 * @returns `true` only when both identity preconditions and obligation
 * fingerprints match.
 * @remarks
 * Single-step repair cannot insert, delete, rename, or re-type a step. Checking
 * id and kind before comparing the canonical obligation hash makes that
 * boundary explicit instead of relying on a hash preimage to hide a malformed
 * provider response.
 */
export function obligationFingerprintMatches(before: Step, after: Step): boolean {
  return before.id === after.id
    && before.kind === after.kind
    && computeObligationFingerprint(before) === computeObligationFingerprint(after);
}
