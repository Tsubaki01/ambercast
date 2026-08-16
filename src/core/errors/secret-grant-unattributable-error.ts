/*
 * Provides the classified failure raised when a secret use cannot be matched
 * to one explicit grant in the test prompt.
 */

import type { SourceSpan } from '#core/ir/schema.js';
import { AmbercastError } from './types.js';

/**
 * Identifies an unauthorized secret use or a declared grant left unclaimed by any step.
 *
 * Citation failures cover a missing, ambiguous, reference-free, or otherwise
 * unresolved provider excerpt. Duplicate claims and missing coverage are
 * rejected during generation and when committed plans are validated for fresh
 * reuse or replay, while a stale span belongs only to committed-plan
 * validation.
 */
export type SecretGrantUnattributableReason =
  | 'citation-not-found'
  | 'citation-not-unique'
  | 'citation-missing-ref'
  | 'citation-unresolved'
  | 'multiply-attributed-grant'
  | 'uncovered-grant'
  | 'stale-grant-span';

/**
 * Identifies a reason that belongs to a concrete secret use in a plan step.
 */
type SecretGrantUsageReason = Exclude<
  SecretGrantUnattributableReason,
  'uncovered-grant'
>;

/**
 * Diagnostic details for a failure associated with one secret use.
 *
 * The step identifier identifies the exact generated or replayed use that
 * needs correction, while the reference and hint keep remediation specific.
 */
type SecretGrantUsageDetails = {
  readonly reason: SecretGrantUsageReason;
  readonly secretRef: string;
  readonly stepId: string;
  readonly hint: string;
};

/**
 * Diagnostic details for a declared grant that no generated step claimed.
 *
 * This branch records a source range rather than a step ID because there is no
 * truthful step to name when the failure is unused authorization.
 */
type SecretGrantUncoveredDetails = {
  readonly reason: 'uncovered-grant';
  readonly secretRef: string;
  readonly sourceSpan: SourceSpan;
  readonly hint: string;
};

/**
 * The reason-specific context carried by a secret-grant attribution failure.
 *
 * A discriminated union keeps an uncovered grant from acquiring a fabricated
 * step identifier while preserving complete remediation context for every
 * failure class.
 */
export type SecretGrantUnattributableDetails =
  | SecretGrantUsageDetails
  | SecretGrantUncoveredDetails;

/**
 * Reports a secret use whose prompt grant cannot be attributed safely.
 *
 * | Reason | Meaning |
 * | --- | --- |
 * | `citation-not-found` | The provider excerpt does not occur in the prompt. |
 * | `citation-not-unique` | The provider excerpt occurs more than once. |
 * | `citation-missing-ref` | The excerpt omits the literal secret reference. |
 * | `citation-unresolved` | Its unique source range contains zero or more than one matching grant. |
 * | `multiply-attributed-grant` | The same grant occurrence is claimed twice. |
 * | `uncovered-grant` | A declared grant was not claimed by a generated step. |
 * | `stale-grant-span` | Committed provenance no longer matches the current grant line. |
 *
 * @remarks
 * The details hint is intentionally diagnostic-only. Structured reports carry
 * an error kind, code, and message but do not serialize error details for any
 * classified failure, so exposing hints there would broaden that established
 * report contract rather than improve attribution itself.
 */
export class SecretGrantUnattributableError extends AmbercastError {
  readonly kind = 'secret-grant-unattributable' as const;
}
