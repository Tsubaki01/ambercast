import { describe, expect, it } from 'vitest';
import type { PlanDocument } from '#core/ir/schema.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import { assertNoLiteralSecrets } from '#usecases/generator-secret-policy.js';

// This is a valid SHA-256-shaped value with exactly 4.0 bits of Shannon
// entropy per character, so removing the path exemption would reject it.
const INPUTS_DIGEST = '0123456789abcdef'.repeat(4);
const WHOLE_SECRET_REFERENCE = '{{secrets.PRODUCTION_PAYMENTS_API_KEY_Q7X9M2V8R4K6T1C3Z5}}';

function plan(generatorMeta: PlanDocument['generatorMeta'] = {}): PlanDocument {
  return {
    schemaVersion: 1,
    source: { inputsDigest: INPUTS_DIGEST },
    targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
    steps: [],
    generatorMeta,
  };
}

function expectRejected(document: PlanDocument, rejectedLiteral: string, detector: unknown, path: string): void {
  let thrown: unknown;

  try {
    assertNoLiteralSecrets(document);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SecretLiteralRejectedError);
  if (thrown instanceof SecretLiteralRejectedError) {
    expect(thrown).toMatchObject({ details: { detector, path } });
    expect(JSON.stringify(thrown.details)).not.toContain(rejectedLiteral);
    expect(JSON.stringify(thrown)).not.toContain(rejectedLiteral);
  }
}

describe('assertNoLiteralSecrets', () => {
  it.each([
    ['sk prefix', 'sk-live-secret-value', 'credential-prefix-sk'],
    ['GitHub token prefix', 'ghp_secret-value', 'credential-prefix-ghp'],
    ['AWS access key prefix', 'AKIASECRET123456789', 'credential-prefix-aws-access-key'],
  ] as const)('rejects a nested %s without retaining its literal value', (_description, value, detector) => {
    expectRejected(plan({ nested: { credentials: [value] } }), value, detector, 'generatorMeta.nested.credentials[0]');
  });

  it('rejects a high-entropy unconstrained generator-metadata token', () => {
    const token = 'aB3!dE5@fG7#hI9$jK2%mN4^pQ6&rS8T';
    expectRejected(
      plan({ token }),
      token,
      'high-entropy-token',
      'generatorMeta.token',
    );
  });

  it('exempts the usecase-computed source inputs digest by exact field path', () => {
    expect(() => assertNoLiteralSecrets(plan())).not.toThrow();
  });

  it('exempts a valid whole-value secret reference', () => {
    expect(() => assertNoLiteralSecrets(plan({ credential: WHOLE_SECRET_REFERENCE }))).not.toThrow();
  });

  it('still rejects an embedded secret-reference marker in unconstrained metadata', () => {
    const note = 'Use {{secrets.LOGIN_PASSWORD}} exactly as copied.';
    expectRejected(
      plan({ note }),
      note,
      expect.any(String),
      'generatorMeta.note',
    );
  });

  it('applies the high-entropy threshold only at 32 characters and 4.0 bits per character', () => {
    const belowLength = 'aB3!dE5@fG7#hI9$jK2%mN4^pQ6&rS8';
    const atThreshold = `${belowLength}T`;

    expect(() => assertNoLiteralSecrets(plan({ belowLength }))).not.toThrow();
    expect(() => assertNoLiteralSecrets(plan({ lowEntropy: 'a'.repeat(32) }))).not.toThrow();
    expectRejected(plan({ atThreshold }), atThreshold, 'high-entropy-token', 'generatorMeta.atThreshold');
  });

  it('traverses schema-defined plan fields as well as unconstrained generator metadata', () => {
    const literal = 'sk-live-secret-in-fill-value';
    const document: PlanDocument = {
      ...plan(),
      steps: [{
        id: 'fill-token',
        kind: 'action',
        action: 'fill',
        target: { strategy: 'accessibility', role: 'textbox', name: 'API token' },
        value: literal,
      }],
    };

    expectRejected(document, literal, 'credential-prefix-sk', 'steps[0].value');
  });

  it('reports the deterministic first violation in lexical object-key order', () => {
    const first = 'ghp_first-secret-value';
    const later = 'sk-later-secret-value';

    expectRejected(
      plan({ zeta: later, alpha: first }),
      first,
      'credential-prefix-ghp',
      'generatorMeta.alpha',
    );
  });

  it('detects a secret-like metadata key without exposing that key in diagnostics', () => {
    const rejectedKey = 'sk-live-secret-key';

    expectRejected(
      plan({ [rejectedKey]: 'ordinary metadata' }),
      rejectedKey,
      'credential-prefix-sk',
      'generatorMeta[redacted-key]',
    );
  });
});
