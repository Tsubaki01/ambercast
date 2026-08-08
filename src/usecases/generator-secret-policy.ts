/**
 * Defines the post-generation policy that prevents literal secrets from
 * reaching a reviewable plan artifact.
 */

import { SecretRef, type JsonValueT, type PlanDocument } from '#core/ir/schema.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';

type SecretDetector =
  | 'credential-prefix-sk'
  | 'credential-prefix-ghp'
  | 'credential-prefix-aws-access-key'
  | 'high-entropy-token';

const REDACTED_KEY_PATH_SEGMENT = '[redacted-key]';

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
 * Rejects a generated plan that contains a detected literal secret.
 *
 * @param plan - The complete schema-valid plan to inspect before persistence.
 * @throws {import('#core/errors/secret-literal-rejected-error.js').SecretLiteralRejectedError}
 * When a non-exempt string matches the literal-secret heuristics.
 * @remarks
 * The policy visits every string and object key in the schema-valid object
 * graph, including unconstrained `generatorMeta`, using lexical object-key
 * order and array-index order. It rejects the first match from this fixed detector set:
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
export function assertNoLiteralSecrets(plan: PlanDocument): void {
  const visit = (value: JsonValueT, path: string): void => {
    if (typeof value === 'string') {
      if (path === 'source.inputsDigest' || SecretRef.safeParse(value).success) {
        return;
      }

      const detector = detectSecretLiteral(value);
      if (detector !== undefined) {
        throw new SecretLiteralRejectedError('The generated plan contains a literal secret.', { detector, path });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value).sort()) {
        const detector = detectSecretLiteral(key);
        const childPath = detector === undefined
          ? (path === '' ? key : `${path}.${key}`)
          : `${path}${REDACTED_KEY_PATH_SEGMENT}`;

        if (detector !== undefined) {
          throw new SecretLiteralRejectedError('The generated plan contains a literal secret.', { detector, path: childPath });
        }

        visit(value[key]!, childPath);
      }
    }
  };

  visit(plan as JsonValueT, '');
}
