import { describe, expect, it } from 'vitest';
import type { PlanDocument, Step } from '#core/ir/schema.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import { SecretRefUndeclaredError } from '#core/errors/secret-ref-undeclared-error.js';
import {
  assertNoLiteralSecrets,
  assertSecretRefsGrounded,
  extractDeclaredSecretRefs,
  normalizeAiStepSecretGrants,
} from '#usecases/generator-secret-policy.js';

// This is a valid SHA-256-shaped value with exactly 4.0 bits of Shannon
// entropy per character, so removing the path exemption would reject it.
const INPUTS_DIGEST = '0123456789abcdef'.repeat(4);
const WHOLE_SECRET_REFERENCE = '{{secrets.PRODUCTION_PAYMENTS_API_KEY_Q7X9M2V8R4K6T1C3Z5}}';

function plan(generatorMeta: PlanDocument['generatorMeta'] = {}, steps: readonly Step[] = []): PlanDocument {
  return {
    schemaVersion: 1,
    source: { inputsDigest: INPUTS_DIGEST },
    targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
    steps: [...steps],
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

function expectUndeclared(
  document: PlanDocument,
  declaredRefs: ReadonlySet<string>,
  secretRef: string,
  stepId: string,
): void {
  let thrown: unknown;

  try {
    assertSecretRefsGrounded(document, declaredRefs);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SecretRefUndeclaredError);
  if (thrown instanceof SecretRefUndeclaredError) {
    expect(thrown.details).toStrictEqual({ secretRef, stepId });
  }
}

describe('normalizeAiStepSecretGrants', () => {
  it('deduplicates and ASCII-sorts declared secret grants', () => {
    const normalized = normalizeAiStepSecretGrants([{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
      secrets: [
        '{{secrets.zeta}}',
        '{{secrets.Alpha}}',
        '{{secrets.alpha}}',
        '{{secrets.zeta}}',
      ],
    }]);

    expect(normalized).toEqual([{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
      secrets: ['{{secrets.Alpha}}', '{{secrets.alpha}}', '{{secrets.zeta}}'],
    }]);
  });

  it('omits an explicit empty secret-grants field', () => {
    const normalized = normalizeAiStepSecretGrants([{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
      secrets: [],
    }]);

    expect(normalized).toEqual([{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
    }]);
    expect(normalized[0]).not.toHaveProperty('secrets');
  });

  it('passes a non-AI step through unchanged', () => {
    const action: Step = {
      id: 'open-payment',
      kind: 'action',
      action: 'navigate',
      url: '/payment',
    };

    const normalized = normalizeAiStepSecretGrants([action]);

    expect(normalized).toEqual([action]);
    expect(normalized[0]).toBe(action);
  });

  it('passes an AI step with omitted secret grants through unchanged', () => {
    const aiStep: Step = {
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
    };

    const normalized = normalizeAiStepSecretGrants([aiStep]);

    expect(normalized).toEqual([aiStep]);
    expect(normalized[0]).toBe(aiStep);
    expect(normalized[0]).not.toHaveProperty('secrets');
  });
});

describe('extractDeclaredSecretRefs', () => {
  it('returns an empty set when the prompt contains no secret references', () => {
    expect(extractDeclaredSecretRefs('# Sign in\n\nUse ordinary credentials.\n')).toEqual(new Set());
  });

  it('ignores negative prose and malformed near-misses outside the shared grammar', () => {
    expect(extractDeclaredSecretRefs('Never use secrets.ADMIN or {{secret.ADMIN}}.'))
      .toEqual(new Set());
  });

  it('extracts one complete secret reference into a fresh set', () => {
    const prompt = 'Use {{secrets.LOGIN_PASSWORD}} to sign in.';
    const declared = extractDeclaredSecretRefs(prompt);

    expect(declared).toEqual(new Set(['{{secrets.LOGIN_PASSWORD}}']));
    expect(extractDeclaredSecretRefs(prompt)).not.toBe(declared);
  });

  it('deduplicates repeated references', () => {
    expect(extractDeclaredSecretRefs('{{secrets.API_TOKEN}} then {{secrets.API_TOKEN}} again.'))
      .toEqual(new Set(['{{secrets.API_TOKEN}}']));
  });

  it('extracts dotted-path references with the shared grammar', () => {
    expect(extractDeclaredSecretRefs('Use {{secrets.account.production.password}}.'))
      .toEqual(new Set(['{{secrets.account.production.password}}']));
  });

  it('treats a reference inside a Markdown code fence as a textual declaration', () => {
    expect(extractDeclaredSecretRefs('```text\n{{secrets.EXAMPLE_TOKEN}}\n```'))
      .toEqual(new Set(['{{secrets.EXAMPLE_TOKEN}}']));
  });

  it('extracts adjacent references without requiring separating whitespace', () => {
    expect(extractDeclaredSecretRefs('{{secrets.FIRST}}{{secrets.SECOND}}'))
      .toEqual(new Set(['{{secrets.FIRST}}', '{{secrets.SECOND}}']));
  });
});

describe('assertSecretRefsGrounded', () => {
  it('accepts a grounded fill-secret reference', () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const document = plan({}, [{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: { strategy: 'accessibility', role: 'textbox', name: 'Password' },
      secretRef,
    }]);

    expect(() => assertSecretRefsGrounded(document, new Set([secretRef]))).not.toThrow();
  });

  it('reports the exact reference and step for an ungrounded fill-secret action', () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const document = plan({}, [{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: { strategy: 'accessibility', role: 'textbox', name: 'Password' },
      secretRef,
    }]);

    expectUndeclared(document, new Set(), secretRef, 'fill-password');
  });

  it('accepts a grounded AI-step secret grant', () => {
    const secretRef = '{{secrets.PAYMENT_TOKEN}}';
    const document = plan({}, [{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
      secrets: [secretRef],
    }]);

    expect(() => assertSecretRefsGrounded(document, new Set([secretRef]))).not.toThrow();
  });

  it('reports the exact reference and step for an ungrounded AI-step secret grant', () => {
    const secretRef = '{{secrets.PAYMENT_TOKEN}}';
    const document = plan({}, [{
      id: 'complete-payment',
      kind: 'ai',
      instruction: 'Complete the payment flow.',
      secrets: [secretRef],
    }]);

    expectUndeclared(document, new Set(), secretRef, 'complete-payment');
  });

  it('accepts a plan with no secret usage', () => {
    const document = plan({}, [{ id: 'open-home', kind: 'action', action: 'navigate', url: '/' }]);

    expect(() => assertSecretRefsGrounded(document, new Set())).not.toThrow();
  });

  it('reports the first undeclared secret-bearing step in plan array order', () => {
    const firstSecretRef = '{{secrets.FIRST}}';
    const document = plan({}, [
      {
        id: 'fill-first',
        kind: 'action',
        action: 'fill-secret',
        target: { strategy: 'accessibility', role: 'textbox', name: 'First' },
        secretRef: firstSecretRef,
      },
      {
        id: 'complete-second',
        kind: 'ai',
        instruction: 'Complete the second task.',
        secrets: ['{{secrets.SECOND}}'],
      },
    ]);

    expectUndeclared(document, new Set(), firstSecretRef, 'fill-first');
  });

  it('continues after a grounded secret-bearing step to report a later ungrounded step', () => {
    const groundedSecretRef = '{{secrets.FIRST}}';
    const ungroundedSecretRef = '{{secrets.SECOND}}';
    const document = plan({}, [
      {
        id: 'fill-first',
        kind: 'action',
        action: 'fill-secret',
        target: { strategy: 'accessibility', role: 'textbox', name: 'First' },
        secretRef: groundedSecretRef,
      },
      {
        id: 'complete-second',
        kind: 'ai',
        instruction: 'Complete the second task.',
        secrets: [ungroundedSecretRef],
      },
    ]);

    expectUndeclared(document, new Set([groundedSecretRef]), ungroundedSecretRef, 'complete-second');
  });

  it('reports an undeclared AI grant before a later undeclared fill-secret action', () => {
    const aiSecretRef = '{{secrets.FIRST}}';
    const fillSecretRef = '{{secrets.SECOND}}';
    const document = plan({}, [
      {
        id: 'complete-first',
        kind: 'ai',
        instruction: 'Complete the first task.',
        secrets: [aiSecretRef],
      },
      {
        id: 'fill-second',
        kind: 'action',
        action: 'fill-secret',
        target: { strategy: 'accessibility', role: 'textbox', name: 'Second' },
        secretRef: fillSecretRef,
      },
    ]);

    expectUndeclared(document, new Set(), aiSecretRef, 'complete-first');
  });

  it('reports the first undeclared grant in an AI step secrets-array order', () => {
    const firstSecretRef = '{{secrets.FIRST}}';
    const document = plan({}, [{
      id: 'complete-flow',
      kind: 'ai',
      instruction: 'Complete the flow.',
      secrets: [firstSecretRef, '{{secrets.SECOND}}'],
    }]);

    expectUndeclared(document, new Set(), firstSecretRef, 'complete-flow');
  });

  it('continues after a grounded AI grant to report a later ungrounded grant', () => {
    const groundedSecretRef = '{{secrets.FIRST}}';
    const ungroundedSecretRef = '{{secrets.SECOND}}';
    const document = plan({}, [{
      id: 'complete-flow',
      kind: 'ai',
      instruction: 'Complete the flow.',
      secrets: [groundedSecretRef, ungroundedSecretRef],
    }]);

    expectUndeclared(document, new Set([groundedSecretRef]), ungroundedSecretRef, 'complete-flow');
  });

  it('accepts every declared usage without mutating the plan or declaration set', () => {
    const fillSecretRef = '{{secrets.LOGIN_PASSWORD}}';
    const aiSecretRef = '{{secrets.PAYMENT_TOKEN}}';
    const document = plan({}, [
      {
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: { strategy: 'accessibility', role: 'textbox', name: 'Password' },
        secretRef: fillSecretRef,
      },
      {
        id: 'complete-payment',
        kind: 'ai',
        instruction: 'Complete the payment flow.',
        secrets: [aiSecretRef],
      },
    ]);
    const declaredRefs = new Set([fillSecretRef, aiSecretRef]);
    const expectedPlan = structuredClone(document);
    const expectedDeclaredRefs = new Set(declaredRefs);

    expect(() => assertSecretRefsGrounded(document, declaredRefs)).not.toThrow();
    expect(document).toStrictEqual(expectedPlan);
    expect(declaredRefs).toStrictEqual(expectedDeclaredRefs);
  });

  it('does not mutate the plan or declaration set when it rejects an undeclared reference', () => {
    const secretRef = '{{secrets.LOGIN_PASSWORD}}';
    const document = plan({}, [{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: { strategy: 'accessibility', role: 'textbox', name: 'Password' },
      secretRef,
    }]);
    const declaredRefs = new Set<string>();
    const expectedPlan = structuredClone(document);
    const expectedDeclaredRefs = new Set(declaredRefs);
    let thrown: unknown;

    try {
      assertSecretRefsGrounded(document, declaredRefs);
    } catch (error) {
      thrown = error;
    }

    expect(document).toStrictEqual(expectedPlan);
    expect(declaredRefs).toStrictEqual(expectedDeclaredRefs);
    expect(thrown).toBeInstanceOf(SecretRefUndeclaredError);
  });
});

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
