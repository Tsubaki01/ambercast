/**
 * Defines the post-generation policy that prevents literal secrets from
 * reaching a reviewable plan artifact.
 */

import { SecretRef, type Step } from '#core/ir/schema.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';

type SecretDetector =
  | 'credential-prefix-sk'
  | 'credential-prefix-ghp'
  | 'credential-prefix-aws-access-key'
  | 'high-entropy-token';

const REDACTED_KEY_PATH_SEGMENT = '[redacted-key]';

/**
 * Canonicalizes declared secret grants on generated AI steps.
 *
 * @param steps - Provider-authored plan steps that have not yet been persisted.
 * @returns New step-array storage with AI-step grants deduplicated, ASCII
 * sorted, and omitted when empty.
 * @remarks
 * Grant canonicalization is generator policy rather than schema policy:
 * validation deliberately preserves the digest-visible distinction between an
 * omitted `AiStep.secrets` field and an explicit empty list. Applying this
 * policy before plan validation gives generated artifacts one stable form
 * without changing the meaning or representation of every other step kind.
 * Secret references use an ASCII-only schema, so direct lexical comparison
 * produces the required deterministic ASCII order without locale-dependent
 * collation.
 */
export function normalizeAiStepSecretGrants(steps: readonly Step[]): Step[] {
  return steps.map((step) => {
    if (step.kind !== 'ai') {
      return step;
    }

    if (step.secrets === undefined) {
      return step;
    }

    if (step.secrets.length === 0) {
      const normalizedStep = { ...step };
      delete normalizedStep.secrets;
      return normalizedStep;
    }

    return {
      ...step,
      secrets: [...new Set(step.secrets)].sort((left, right) => {
        if (left < right) {
          return -1;
        }
        return left > right ? 1 : 0;
      }),
    };
  });
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

function detectSecretLiteral(value: string): SecretDetector | undefined {
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
