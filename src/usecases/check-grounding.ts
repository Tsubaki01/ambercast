import { computePlanDigest, isPlanDigestCurrent } from '#core/ir/digest.js';
import {
  isGroundingCanonicalForClaim,
  rawGroundingHasCoverageClaim,
} from '#core/ir/grounding-coverage-claim.js';
import { GroundingDocument, type PlanDocument } from '#core/ir/schema.js';
import type { ReadStorageAdapter } from '#ports/storage.js';

/*
 * Check needs to report which grounding lifecycle condition it observed, so it
 * keeps that inspection separate from both its plan-freshness loop and replay's
 * cache reader. The replay path deliberately turns every unusable companion
 * into one recoverable cache miss so it can choose an AI fallback; exposing
 * that collapsed vocabulary here would lose the distinction check must report.
 */

/**
 * `missing` denotes an absent companion, `invalid` content that cannot be
 * parsed or satisfy the grounding schema, a coverage-bearing document whose
 * bytes are not its canonical serialization, `stale` a valid document for
 * another plan, and `valid` a matching companion.
 *
 * @remarks
 * The inspection rejects JSON or schema failures before comparing the plan
 * digest, then applies the canonicality requirement only to a matching
 * coverage claim. A storage read failure is deliberately not another kind:
 * the caller already owns the CheckFileError path for I/O failures and must
 * retain that error rather than recast it as an invalid artifact.
 */
export type GroundingInspection =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'valid' };

/**
 * Classifies the grounding companion associated with one plan.
 *
 * @param storage - Read-only storage whose no-write contract is an invariant
 * of check's design: grounding inspection must never acquire authority to
 * create, replace, or otherwise mutate storage.
 * @param groundingPath - Opaque path of the companion artifact to inspect.
 * @param plan - The parsed plan whose digest the companion is compared
 * against.
 * @returns The companion's absence, validity, or relationship to `plan`.
 * @throws Propagates a storage rejection while reading an existing companion,
 * so the caller can preserve it as a per-file I/O error.
 *
 * @remarks
 * The helper returns only a classification because its caller
 * owns report-status selection; parsed content and parse diagnostics do not
 * cross that boundary. A named read port also keeps this check-closure helper
 * consistent with its parent use case instead of encoding the same capability
 * as an ad hoc structural `Pick`. Digest equality is the provenance gate for
 * coverage inspection: a document for another plan remains stale without
 * canonical scanning, because its bytes cannot establish usable current
 * grounding. The raw scan is caught here so malformed artifact structure is
 * classified as invalid rather than escaping into the caller's storage-I/O
 * error path. Once a claim is found, the shared canonicality primitive already
 * converts a serialization failure into an invalid result, so a second local
 * exception boundary would only duplicate and risk weakening that contract.
 */
export async function inspectGroundingArtifact(
  storage: ReadStorageAdapter,
  groundingPath: string,
  plan: PlanDocument,
): Promise<GroundingInspection> {
  if (!(await storage.exists(groundingPath))) {
    return { kind: 'missing' };
  }

  const text = await storage.readText(groundingPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }

  const grounding = GroundingDocument.safeParse(parsed);
  if (!grounding.success) {
    return { kind: 'invalid' };
  }

  if (!isPlanDigestCurrent(grounding.data, computePlanDigest(plan))) {
    return { kind: 'stale' };
  }

  let hasClaim: boolean;
  try {
    hasClaim = rawGroundingHasCoverageClaim(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (hasClaim && !isGroundingCanonicalForClaim(text, grounding.data)) {
    return { kind: 'invalid' };
  }

  return { kind: 'valid' };
}
