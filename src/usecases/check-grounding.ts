import { computePlanDigest, isPlanDigestCurrent } from '#core/ir/digest.js';
import { GroundingDocument, type PlanDocument } from '#core/ir/schema.js';
import type { StorageAdapter } from '#ports/storage.js';

/*
 * Check needs to report which grounding lifecycle condition it observed, so it
 * keeps that inspection separate from both its plan-freshness loop and replay's
 * cache reader. The replay path deliberately turns every unusable companion
 * into one recoverable cache miss so it can choose an AI fallback; exposing
 * that collapsed vocabulary here would lose the distinction check must report.
 */

/*
 * `missing` denotes an absent companion, `invalid` content that cannot be
 * parsed or satisfy the grounding schema, `stale` a valid document for another
 * plan, and `valid` a matching companion. The inspection recognizes absence;
 * for an existing file it rejects JSON or schema failures before comparing the
 * plan digest, leaving a match as valid. A
 * storage read failure is deliberately not another kind: the caller already
 * owns the CheckFileError path for I/O failures and must retain that error
 * rather than recast it as an invalid artifact.
 */
export type GroundingInspection =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'valid' };

/*
 * This inspects one plan's grounding companion using only the read
 * capability that check already has. Narrowing storage to `exists` and
 * `readText` prevents this reporting helper from gaining mutation authority.
 * It returns only a classification because the caller selects a report status;
 * neither a parsed document nor parse diagnostics are useful at that boundary.
 */
export async function inspectGroundingArtifact(
  storage: Pick<StorageAdapter, 'readText' | 'exists'>,
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

  return isPlanDigestCurrent(grounding.data, computePlanDigest(plan))
    ? { kind: 'valid' }
    : { kind: 'stale' };
}
