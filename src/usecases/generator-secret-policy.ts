/**
 * Defines the secret-policy boundary shared by generated and replayed plans.
 *
 * This module keeps reviewable artifacts free of literal secrets while
 * requiring each permitted secret use to trace to one explicit prompt grant.
 * Local attribution keeps provider citations transient and gives generation
 * and replay the same authorization boundary before a plan can rely on an
 * externally resolved value.
 */

import {
  SecretRef,
  type GeneratedStep,
  type PlanDocument as PlanDocumentType,
  type Step,
} from '#core/ir/schema.js';
import type { NormalizedTestMd } from '#core/ir/normalize.js';
import { extractSecretGrants, type SecretGrant } from '#core/ir/secret-grant-source.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import {
  type SecretGrantUnattributableDetails,
  type SecretGrantUnattributableReason,
  SecretGrantUnattributableError,
} from '#core/errors/secret-grant-unattributable-error.js';

export type SecretDetector =
  | 'credential-prefix-sk'
  | 'credential-prefix-ghp'
  | 'credential-prefix-aws-access-key'
  | 'high-entropy-token';

const REDACTED_KEY_PATH_SEGMENT = '[redacted-key]';

/**
 * Supplies self-correcting diagnostics for each failed grant-attribution
 * reason.
 *
 * Centralizing the text keeps every generation and replay failure actionable
 * without making error wording depend on an individual throw site. Hints stay
 * in diagnostic details rather than the structured-report contract.
 */
export const SECRET_GRANT_UNATTRIBUTABLE_HINTS: Record<
  SecretGrantUnattributableReason,
  (ref: string) => string
> = {
  'citation-not-found': (ref) =>
    `If the secret use is intended, cite an exact, unique prompt excerpt containing one complete @ambercast-secret ${ref} grant line, adding that line if it is absent; otherwise remove the secret use.`,
  'citation-not-unique': (ref) =>
    `If the secret use is intended, include enough prompt text for the citation to identify exactly one complete @ambercast-secret ${ref} grant line, adding that line if it is absent; otherwise remove the secret use.`,
  'citation-missing-ref': (ref) =>
    `If the secret use is intended, cite one complete @ambercast-secret ${ref} grant line including the literal ${ref} token, adding that line if it is absent; otherwise remove the secret use.`,
  'citation-unresolved': (ref) =>
    `If the secret use is intended, cite exactly one complete @ambercast-secret ${ref} grant line outside Markdown code, narrowing the citation or adding that line as needed; otherwise remove the secret use.`,
  'multiply-attributed-grant': (ref) =>
    `Remove the duplicate secret use, or give each intended use of ${ref} a distinct @ambercast-secret grant line, cite each line during generation, and regenerate the plan before replay.`,
  'uncovered-grant': (ref) =>
    `Use the @ambercast-secret ${ref} grant for one intended secret use and cite it during generation, or remove the unused grant line.`,
  'stale-grant-span': (ref) =>
    `If the secret use remains intended, restore its matching @ambercast-secret ${ref} grant line and regenerate the plan; otherwise remove the use and regenerate the plan.`,
};

/**
 * Attributes provider-authored secret citations to locally parsed prompt
 * grants and returns committed plan steps.
 *
 * This function treats its input as immutable, returns a new array, and
 * passes non-secret branches through by reference. It walks steps and AI-step
 * grant entries in source order, stopping at the first failure so a provider
 * response has one deterministic correction target. Verified citations become
 * local source spans before the response can be persisted.
 *
 * Claimed occurrences use `grant.offsetStart`, which remains unique when two
 * complete grant lines have identical text. Citation and duplicate-claim
 * failures therefore take precedence over the final document-order scan for
 * an uncovered grant elsewhere in the prompt.
 *
 * Each citation failure and `multiply-attributed-grant` uses
 * `SecretGrantUsageDetails`, with `reason`, `secretRef`, `stepId`, and `hint`.
 * The final uncovered-grant scan instead uses `SecretGrantUncoveredDetails`,
 * with `reason: 'uncovered-grant'`, `secretRef`, `sourceSpan`, and `hint`,
 * because an unused grant has no truthful step identifier.
 *
 * @param steps - Schema-validated provider steps whose secret uses still carry
 * verbatim prompt citations.
 * @param normalizedTestMd - Canonical prompt from which grants and persisted
 * line spans are derived.
 * @returns Committed-shape plan steps with citations replaced by source spans.
 * @throws {SecretGrantUnattributableError} When a citation is absent,
 * ambiguous, missing its reference, unresolved to exactly one grant, claims a
 * grant twice, or leaves a declared grant uncovered.
 * @remarks
 * Attribution is usecase policy rather than schema validation because it
 * requires the complete prompt, citation occurrence counts, and a plan-wide
 * claimed-grant map. Encoding it as a refinement would hide the contract from
 * generated JSON Schema and still could not express its document-wide state.
 */
export function attributeSecretGrants(
  steps: readonly GeneratedStep[],
  normalizedTestMd: NormalizedTestMd,
): Step[] {
  const grants = extractSecretGrants(normalizedTestMd);
  const claimed = new Set<number>();
  const claim = (grant: SecretGrant, ref: string, stepId: string) => {
    if (claimed.has(grant.offsetStart)) {
      throwSecretGrantUsageError('multiply-attributed-grant', ref, stepId);
    }

    claimed.add(grant.offsetStart);
    return { startLine: grant.startLine, endLine: grant.endLine };
  };

  const attributed = steps.map((step): Step => {
    if (step.kind === 'action') {
      if (step.action !== 'fill-secret') {
        return step;
      }

      const grant = resolveCitation(step.citation, step.secretRef, step.id, normalizedTestMd, grants);
      const { citation: _citation, ...fillSecret } = step;
      return {
        ...fillSecret,
        secretGrantSpan: claim(grant, step.secretRef, step.id),
      };
    }

    if (step.kind !== 'ai') {
      return step;
    }

    const { secrets, ...aiStep } = step;
    if (secrets === undefined) {
      return aiStep;
    }

    return {
      ...aiStep,
      secrets: secrets.map(({ ref, citation }) => {
        const grant = resolveCitation(citation, ref, step.id, normalizedTestMd, grants);
        return { ref, sourceSpan: claim(grant, ref, step.id) };
      }),
    };
  });

  const uncoveredGrant = grants.find((grant) => !claimed.has(grant.offsetStart));
  if (uncoveredGrant !== undefined) {
    throwSecretGrantUncoveredError(uncoveredGrant);
  }

  return attributed;
}

/**
 * Resolves one provider citation to its unique matching prompt grant.
 *
 * It counts overlapping citation occurrences, which prevents a
 * self-overlapping excerpt from being misclassified as unique. The citation
 * is non-empty because its schema enforces that boundary before this function
 * runs. Its unique source occurrence must include the literal reference and
 * exactly one same-reference grant by offset containment; text equality alone
 * would confuse identical grant lines at different locations.
 *
 * Validation first counts every occurrence, advancing one code unit after
 * each match so overlaps count. It next requires the literal reference, then
 * selects same-reference grants whose complete offset ranges are contained by
 * the unique citation. Each failure reports `SecretGrantUsageDetails` for the
 * supplied step.
 *
 * @param citation - The schema-validated non-empty provider excerpt.
 * @param ref - The literal secret reference that the excerpt must contain.
 * @param stepId - The secret-using step retained in a failure's diagnostics.
 * @param testMd - Canonical prompt in which the excerpt is resolved.
 * @param grants - Locally extracted grants in the same prompt.
 * @returns The unique prompt grant the citation authorizes.
 * @throws {SecretGrantUnattributableError} When the citation cannot authorize
 * exactly one grant for this reference.
 * @remarks
 * The step identifier enters at this low level so all citation failures name
 * the actual use that needs correction rather than an arbitrary caller.
 */
function resolveCitation(
  citation: string,
  ref: string,
  stepId: string,
  testMd: NormalizedTestMd,
  grants: readonly SecretGrant[],
): SecretGrant {
  let firstOffset = -1;
  let occurrences = 0;

  for (let fromIndex = 0; ; ) {
    const offset = testMd.indexOf(citation, fromIndex);
    if (offset === -1) {
      break;
    }

    if (occurrences === 0) {
      firstOffset = offset;
    }
    occurrences += 1;
    if (occurrences === 2) {
      throwSecretGrantUsageError('citation-not-unique', ref, stepId);
    }
    fromIndex = offset + 1;
  }

  if (occurrences === 0) {
    throwSecretGrantUsageError('citation-not-found', ref, stepId);
  }
  if (!citation.includes(ref)) {
    throwSecretGrantUsageError('citation-missing-ref', ref, stepId);
  }

  const citationEnd = firstOffset + citation.length;
  const matchingGrants = grants.filter((grant) => (
    grant.ref === ref
    && grant.offsetStart >= firstOffset
    && grant.offsetEnd <= citationEnd
  ));
  if (matchingGrants.length !== 1) {
    throwSecretGrantUsageError('citation-unresolved', ref, stepId);
  }

  return matchingGrants[0]!;
}

/**
 * Asserts that a committed plan's secret grants remain sound against the
 * current normalized prompt.
 *
 * Generation uses this boundary when deciding whether a digest-fresh plan can
 * be reused, while replay uses it before opening a browser. Both call sites
 * need the same authorization result even though generation can regenerate an
 * unsound plan and replay must report the failure. The check only reads the
 * plan, preserving replay's lack of an AI dependency at this trust boundary.
 *
 * A claim uses the resolved grant's `startLine`, because the supported grammar
 * makes every grant exactly one physical line. Stale-span validation precedes
 * the duplicate check, and the coverage scan follows the complete
 * step walk. This preserves deterministic precedence from stale provenance to
 * a duplicate claim to an uncovered grant. Stale and duplicate failures use
 * `SecretGrantUsageDetails`; an uncovered grant uses its source span because
 * it has no truthful step identifier.
 *
 * @param plan - The schema-validated committed plan to verify without
 * mutation.
 * @param normalizedTestMd - Canonical current prompt from which grants are
 * re-extracted.
 * @throws {SecretGrantUnattributableError} When a persisted span is stale, one
 * grant span is claimed by more than one step, or a declared grant remains
 * unclaimed.
 * @remarks
 * Prompt edits without regeneration are rejected by the complete prompt digest
 * check. This independent boundary covers hand-edited plans whose digest still
 * matches but whose stored uses no longer have valid one-to-one grants.
 * Attribution proves that a secret use has authorization, not that the field
 * receiving the secret is semantically intended; that residual judgment stays
 * with the validated plan and human review.
 */
export function assertCommittedSecretAttributionSound(
  plan: PlanDocumentType,
  normalizedTestMd: NormalizedTestMd,
): void {
  const grants = extractSecretGrants(normalizedTestMd);
  const grantsByStartLine = new Map(
    grants.map((grant) => [grant.startLine, grant]),
  );
  const claimed = new Set<number>();
  const verifyGrant = (
    ref: string,
    sourceSpan: { readonly startLine: number; readonly endLine: number },
    stepId: string,
  ): void => {
    const grant = grantsByStartLine.get(sourceSpan.startLine);
    if (grant === undefined || grant.ref !== ref || grant.endLine !== sourceSpan.endLine) {
      throwSecretGrantUsageError('stale-grant-span', ref, stepId);
    }
    if (claimed.has(grant.startLine)) {
      throwSecretGrantUsageError('multiply-attributed-grant', ref, stepId);
    }

    claimed.add(grant.startLine);
  };

  for (const step of plan.steps) {
    if (step.kind === 'action' && step.action === 'fill-secret') {
      verifyGrant(step.secretRef, step.secretGrantSpan, step.id);
      continue;
    }
    if (step.kind === 'ai') {
      for (const secret of step.secrets ?? []) {
        verifyGrant(secret.ref, secret.sourceSpan, step.id);
      }
    }
  }

  const uncoveredGrant = grants.find((grant) => !claimed.has(grant.startLine));
  if (uncoveredGrant !== undefined) {
    throwSecretGrantUncoveredError(uncoveredGrant);
  }
}

/**
 * Canonicalizes verified secret grants on committed AI steps.
 *
 * @param steps - Committed-shape steps whose secret grants already passed
 * attribution.
 * @returns New step-array storage with AI grants ordered by reference, start
 * line, and end line, and with explicit empty grant lists omitted.
 * @remarks
 * Duplicate removal is deliberately absent. Equal references at different
 * spans are separate verified authorizations, while equal references at the
 * same span would already have failed the claimed-grant check before this
 * function runs. All three comparison keys make canonical JSON independent of
 * the provider's response order; reference-only sorting would preserve an
 * unstable order for distinct grants of the same secret. Secret references use
 * an ASCII-only schema, so direct lexical comparison produces the required
 * deterministic ASCII order without locale-dependent collation.
 */
export function normalizeAiStepSecretGrants(steps: readonly Step[]): Step[] {
  return steps.map((step): Step => {
    if (step.kind !== 'ai') {
      return step;
    }

    if (step.secrets === undefined) {
      return step;
    }

    if (step.secrets.length === 0) {
      const { secrets: _secrets, ...aiStep } = step;
      return aiStep;
    }

    return {
      ...step,
      secrets: [...step.secrets].sort((left, right) => (
        (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
        || left.sourceSpan.startLine - right.sourceSpan.startLine
        || left.sourceSpan.endLine - right.sourceSpan.endLine
      )),
    };
  });
}

function throwSecretGrantUsageError(
  reason: Exclude<SecretGrantUnattributableReason, 'uncovered-grant'>,
  secretRef: string,
  stepId: string,
): never {
  throw new SecretGrantUnattributableError(
    'A secret use could not be attributed to exactly one prompt grant.',
    {
      reason,
      secretRef,
      stepId,
      hint: SECRET_GRANT_UNATTRIBUTABLE_HINTS[reason](secretRef),
    } satisfies SecretGrantUnattributableDetails,
  );
}

function throwSecretGrantUncoveredError(grant: SecretGrant): never {
  throw new SecretGrantUnattributableError(
    'A declared secret grant is not used by the generated plan.',
    {
      reason: 'uncovered-grant',
      secretRef: grant.ref,
      sourceSpan: { startLine: grant.startLine, endLine: grant.endLine },
      hint: SECRET_GRANT_UNATTRIBUTABLE_HINTS['uncovered-grant'](grant.ref),
    } satisfies SecretGrantUnattributableDetails,
  );
}

function hasHighEntropy(value: string): boolean {
  if (value.length < 32) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  const entropy = [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);

  return entropy >= 4;
}

/**
 * Classifies a string using the shared credential-literal heuristic.
 *
 * Both `assertNoLiteralSecrets` and a run-time trust boundary consume this
 * primitive, while the result intentionally identifies only the matched
 * detector. It carries neither the caller's identity nor its reason for
 * classifying the value, so each boundary retains ownership of its own
 * exemptions and enforcement policy.
 *
 * @param value - Text to classify without retaining it in the result.
 * @returns The matched detector identifier, or `undefined` when no detector
 * matches.
 */
export function detectSecretLiteral(value: string): SecretDetector | undefined {
  if (value.startsWith('sk-')) {
    return 'credential-prefix-sk';
  }
  if (value.startsWith('ghp_')) {
    return 'credential-prefix-ghp';
  }
  if (value.startsWith('AKIA')) {
    return 'credential-prefix-aws-access-key';
  }
  if (hasHighEntropy(value)) {
    return 'high-entropy-token';
  }

  return undefined;
}

/**
 * Rejects generated JSON data that contains a detected literal secret.
 *
 * @param value - Any provider-derived JSON value to inspect before persistence
 * or report serialization.
 * @throws {import('#core/errors/secret-literal-rejected-error.js').SecretLiteralRejectedError}
 * When a non-exempt string matches the literal-secret heuristics.
 * @remarks
 * The policy visits every string and object key in the provider-derived JSON
 * graph, including unconstrained `generatorMeta` and reportable ambiguities,
 * using lexical object-key order and array-index order. It rejects the first
 * match from this fixed detector set:
 * `credential-prefix-sk` for strings beginning `sk-`,
 * `credential-prefix-ghp` for strings beginning `ghp_`,
 * `credential-prefix-aws-access-key` for strings beginning `AKIA`, and
 * `high-entropy-token` for an otherwise-unconstrained token of at least 32
 * characters whose Shannon entropy is at least 4.0 bits per character.
 *
 * A valid whole-value `{{secrets.*}}` reference is exempt because it is the
 * permitted representation, while an embedded reference remains ordinary text
 * for detection. `source.inputsDigest` is exempt by this exact field path
 * because the locally computed SHA-256 digest otherwise resembles high-entropy
 * data. Rejection details contain only the named detector and a dot/bracket
 * JSON-path-like location such as `generatorMeta.apiKeys[0]`; a detected
 * object key uses the fixed `[redacted-key]` segment instead of its value.
 * Diagnostics never retain the rejected literal itself.
 */
export function assertNoLiteralSecrets(value: unknown): void {
  const visit = (nextValue: unknown, path: string): void => {
    if (typeof nextValue === 'string') {
      if (path === 'source.inputsDigest' || SecretRef.safeParse(nextValue).success) {
        return;
      }

      const detector = detectSecretLiteral(nextValue);
      if (detector !== undefined) {
        throw new SecretLiteralRejectedError('The generated plan contains a literal secret.', { detector, path });
      }
      return;
    }

    if (Array.isArray(nextValue)) {
      nextValue.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }

    if (nextValue !== null && typeof nextValue === 'object') {
      const record = nextValue as Record<string, unknown>;
      for (const key of Object.keys(record).sort()) {
        const detector = detectSecretLiteral(key);
        const childPath = detector === undefined
          ? (path === '' ? key : `${path}.${key}`)
          : `${path}${REDACTED_KEY_PATH_SEGMENT}`;

        if (detector !== undefined) {
          throw new SecretLiteralRejectedError('The generated plan contains a literal secret.', { detector, path: childPath });
        }

        visit(record[key], childPath);
      }
    }
  };

  visit(value, '');
}
