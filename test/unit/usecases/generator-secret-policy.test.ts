import { describe, expect, it } from 'vitest';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type { GeneratedStep, PlanDocument, Step } from '#core/ir/schema.js';
import { SecretGrantUnattributableError } from '#core/errors/secret-grant-unattributable-error.js';
import { SecretLiteralRejectedError } from '#core/errors/secret-literal-rejected-error.js';
import {
  assertNoLiteralSecrets,
  assertCommittedSecretAttributionSound,
  attributeSecretGrants,
  normalizeAiStepSecretGrants,
  SECRET_GRANT_UNATTRIBUTABLE_HINTS,
} from '#usecases/generator-secret-policy.js';

const INPUTS_DIGEST = '0123456789abcdef'.repeat(4);
const TARGET = { strategy: 'accessibility', role: 'textbox', name: 'Password' } as const;
const FIRST_REF = '{{secrets.FIRST}}';
const SECOND_REF = '{{secrets.SECOND}}';
const THIRD_REF = '{{secrets.THIRD}}';
const WHOLE_SECRET_REFERENCE = '{{secrets.PRODUCTION_PAYMENTS_API_KEY_Q7X9M2V8R4K6T1C3Z5}}';
const SUCCESS_CRITERION_ID = 'sign-in-complete';

function prompt(...grantRefs: readonly string[]) {
  return normalizeTestMd([
    '# Sign in',
    '',
    ...grantRefs.map((ref) => `@ambercast-secret ${ref}`),
    '',
  ].join('\n'));
}

function grantLine(ref: string): string {
  return `@ambercast-secret ${ref}`;
}

function generatedFill(
  ref = FIRST_REF,
  citation = grantLine(ref),
  id = 'fill-password',
): Extract<GeneratedStep, { kind: 'action'; action: 'fill-secret' }> {
  return { id, kind: 'action', action: 'fill-secret', target: TARGET, secretRef: ref, citation };
}

function generatedAi(
  secrets: readonly { readonly ref: string; readonly citation: string }[] = [],
  id = 'complete-sign-in',
): Extract<GeneratedStep, { kind: 'ai' }> {
  return {
    id,
    kind: 'ai',
    instruction: 'Complete sign-in.',
    instructionCoverage: [{ id: SUCCESS_CRITERION_ID, kind: 'success', citation: '# Sign in' }],
    verificationIntent: [{
      criterionId: SUCCESS_CRITERION_ID,
      assertion: { type: 'assert', check: 'text-visible', text: 'Sign in' },
    }],
    ...(secrets.length === 0 ? {} : { secrets: [...secrets] }),
  } as unknown as Extract<GeneratedStep, { kind: 'ai' }>;
}

function committedFill(
  ref = FIRST_REF,
  startLine = 3,
  id = 'fill-password',
): Extract<Step, { kind: 'action'; action: 'fill-secret' }> {
  return {
    id,
    kind: 'action',
    action: 'fill-secret',
    target: TARGET,
    secretRef: ref,
    secretGrantSpan: { startLine, endLine: startLine },
  };
}

function committedAi(
  secrets: readonly { readonly ref: string; readonly startLine: number }[] = [],
  id = 'complete-sign-in',
): Extract<Step, { kind: 'ai' }> {
  return {
    id,
    kind: 'ai',
    instruction: 'Complete sign-in.',
    instructionCoverage: [{
      id: SUCCESS_CRITERION_ID,
      kind: 'success',
      sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
    }],
    ...(secrets.length === 0 ? {} : {
      secrets: secrets.map(({ ref, startLine }) => ({ ref, sourceSpan: { startLine, endLine: startLine } })),
    }),
  } as unknown as Extract<Step, { kind: 'ai' }>;
}

function plan(steps: readonly Step[]): PlanDocument {
  return {
    schemaVersion: 2,
    source: { inputsDigest: INPUTS_DIGEST },
    targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
    steps: [...steps],
  } as unknown as PlanDocument;
}

function expectAttributionFailure(
  operation: () => unknown,
  expected: {
    readonly reason: keyof typeof SECRET_GRANT_UNATTRIBUTABLE_HINTS;
    readonly secretRef: string;
    readonly stepId?: string;
    readonly sourceSpan?: { readonly startLine: number; readonly endLine: number };
  },
): void {
  let thrown: unknown;

  try {
    operation();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SecretGrantUnattributableError);
  if (thrown instanceof SecretGrantUnattributableError) {
    const details = thrown.details;
    expect(details).toMatchObject(expected);
    expect(details?.hint).toBe(
      SECRET_GRANT_UNATTRIBUTABLE_HINTS[expected.reason](expected.secretRef),
    );
    if (expected.reason === 'uncovered-grant') {
      expect(details).not.toHaveProperty('stepId');
    }
  }
}

function expectLiteralSecretRejected(
  document: PlanDocument,
  rejectedLiteral: string,
  detector: unknown,
  path: string,
): void {
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

describe('normalizeAiStepSecretGrants', () => {
  it('orders AI grants by ref, start line, and end line', () => {
    expect(normalizeAiStepSecretGrants([committedAi([
      { ref: '{{secrets.zeta}}', startLine: 3 },
      { ref: '{{secrets.item}}', startLine: 3 },
      { ref: '{{secrets.Item}}', startLine: 3 },
      { ref: '{{secrets.alpha}}', startLine: 8 },
      { ref: '{{secrets.alpha}}', startLine: 4 },
    ])])).toEqual([committedAi([
      { ref: '{{secrets.Item}}', startLine: 3 },
      { ref: '{{secrets.alpha}}', startLine: 4 },
      { ref: '{{secrets.alpha}}', startLine: 8 },
      { ref: '{{secrets.item}}', startLine: 3 },
      { ref: '{{secrets.zeta}}', startLine: 3 },
    ])]);
  });

  it('keeps two independently verified grants for the same reference', () => {
    const normalized = normalizeAiStepSecretGrants([committedAi([
      { ref: FIRST_REF, startLine: 9 },
      { ref: FIRST_REF, startLine: 3 },
    ])]);

    expect(normalized[0]).toMatchObject({
      secrets: [
        { ref: FIRST_REF, sourceSpan: { startLine: 3, endLine: 3 } },
        { ref: FIRST_REF, sourceSpan: { startLine: 9, endLine: 9 } },
      ],
    });
  });

  it('uses end line as the final tie-break when refs and start lines match', () => {
    const normalized = normalizeAiStepSecretGrants([{
      id: 'complete-sign-in',
      kind: 'ai',
      instruction: 'Complete sign-in.',
      instructionCoverage: [{
        id: SUCCESS_CRITERION_ID,
        kind: 'success',
        sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 },
      }],
      secrets: [
        { ref: FIRST_REF, sourceSpan: { startLine: 3, endLine: 9 } },
        { ref: FIRST_REF, sourceSpan: { startLine: 3, endLine: 4 } },
      ],
    }]);

    expect(normalized[0]).toMatchObject({
      secrets: [
        { ref: FIRST_REF, sourceSpan: { startLine: 3, endLine: 4 } },
        { ref: FIRST_REF, sourceSpan: { startLine: 3, endLine: 9 } },
      ],
    });
  });

  it('omits explicit empty AI grant arrays and preserves untouched branch identity', () => {
    const action: Step = { id: 'open-home', kind: 'action', action: 'navigate', url: '/' };
    const emptyAi = committedAi([]);
    const normalized = normalizeAiStepSecretGrants([action, emptyAi]);

    expect(normalized[0]).toBe(action);
    expect(normalized[1]).toEqual(committedAi());
    expect(normalized[1]).not.toHaveProperty('secrets');
  });
});

describe('attributeSecretGrants', () => {
  it.each([
    ['citation-not-found', [generatedFill(FIRST_REF, 'not in prompt')], prompt(FIRST_REF), { reason: 'citation-not-found', secretRef: FIRST_REF, stepId: 'fill-password' }],
    ['citation-not-unique', [generatedFill(FIRST_REF, 'aa')], normalizeTestMd('aaaa'), { reason: 'citation-not-unique', secretRef: FIRST_REF, stepId: 'fill-password' }],
    ['citation-missing-ref', [generatedFill(FIRST_REF, grantLine(SECOND_REF))], prompt(SECOND_REF), { reason: 'citation-missing-ref', secretRef: FIRST_REF, stepId: 'fill-password' }],
    ['citation-unresolved', [generatedFill(FIRST_REF, `Use ${FIRST_REF} in prose.`)], normalizeTestMd(`Use ${FIRST_REF} in prose.\n`), { reason: 'citation-unresolved', secretRef: FIRST_REF, stepId: 'fill-password' }],
    ['multiply-attributed-grant', [generatedFill(), generatedFill(FIRST_REF, grantLine(FIRST_REF), 'fill-password-again')], prompt(FIRST_REF), { reason: 'multiply-attributed-grant', secretRef: FIRST_REF, stepId: 'fill-password-again' }],
    ['uncovered-grant', [], prompt(FIRST_REF), { reason: 'uncovered-grant', secretRef: FIRST_REF, sourceSpan: { startLine: 3, endLine: 3 } }],
  ] as const)('reports %s with reason-discriminated details', (_description, steps, testMd, details) => {
    expectAttributionFailure(() => attributeSecretGrants(steps, testMd), details);
  });

  it('recognizes overlapping citation occurrences as non-unique', () => {
    expectAttributionFailure(
      () => attributeSecretGrants([generatedFill(FIRST_REF, 'aba')], normalizeTestMd('ababa')),
      { reason: 'citation-not-unique', secretRef: FIRST_REF, stepId: 'fill-password' },
    );
  });

  it('attributes a fill-secret action to the locally computed grant span', () => {
    expect(attributeSecretGrants([generatedFill()], prompt(FIRST_REF))).toEqual([committedFill(FIRST_REF, 3)]);
  });

  it('accepts AI steps with zero, one, and multiple independently cited grants', () => {
    const testMd = prompt(FIRST_REF, SECOND_REF, THIRD_REF);
    const steps = [
      generatedAi(),
      generatedAi([{ ref: FIRST_REF, citation: `# Sign in\n\n${grantLine(FIRST_REF)}` }], 'one-grant'),
      generatedAi([
        { ref: SECOND_REF, citation: `${grantLine(FIRST_REF)}\n${grantLine(SECOND_REF)}` },
        { ref: THIRD_REF, citation: `${grantLine(SECOND_REF)}\n${grantLine(THIRD_REF)}` },
      ], 'two-grants'),
    ];

    expect(attributeSecretGrants(steps, testMd)).toEqual([
      committedAi(),
      committedAi([{ ref: FIRST_REF, startLine: 3 }], 'one-grant'),
      committedAi([
        { ref: SECOND_REF, startLine: 4 },
        { ref: THIRD_REF, startLine: 5 },
      ], 'two-grants'),
    ]);
  });

  it('resolves two different reference grants inside one unique citation by their respective refs', () => {
    const citation = `${grantLine(FIRST_REF)}\n${grantLine(SECOND_REF)}`;

    expect(attributeSecretGrants([
      generatedAi([
        { ref: FIRST_REF, citation },
        { ref: SECOND_REF, citation },
      ]),
    ], prompt(FIRST_REF, SECOND_REF))).toEqual([
      committedAi([
        { ref: FIRST_REF, startLine: 3 },
        { ref: SECOND_REF, startLine: 4 },
      ]),
    ]);
  });

  it('rejects one citation that contains two matching-reference grant lines', () => {
    const citation = `${grantLine(FIRST_REF)}\n${grantLine(FIRST_REF)}`;

    expectAttributionFailure(
      () => attributeSecretGrants([generatedFill(FIRST_REF, citation)], normalizeTestMd(`${citation}\n`)),
      { reason: 'citation-unresolved', secretRef: FIRST_REF, stepId: 'fill-password' },
    );
  });

  it('permits two steps to claim distinct matching grants for the same ref', () => {
    const testMd = normalizeTestMd(`${grantLine(FIRST_REF)}\ncontext\n${grantLine(FIRST_REF)}\n`);

    expect(attributeSecretGrants([
      generatedFill(FIRST_REF, `${grantLine(FIRST_REF)}\ncontext`, 'first-use'),
      generatedFill(FIRST_REF, `context\n${grantLine(FIRST_REF)}`, 'second-use'),
    ], testMd)).toEqual([
      committedFill(FIRST_REF, 1, 'first-use'),
      committedFill(FIRST_REF, 3, 'second-use'),
    ]);
  });

  it('reports the first violation in plan order before later independent violations', () => {
    expectAttributionFailure(
      () => attributeSecretGrants([
        generatedFill(FIRST_REF, 'not present', 'first-invalid'),
        generatedFill(SECOND_REF, 'also not present', 'second-invalid'),
      ], prompt(FIRST_REF, SECOND_REF)),
      { reason: 'citation-not-found', secretRef: FIRST_REF, stepId: 'first-invalid' },
    );
  });

  it('does not mutate provider-owned inputs and preserves an unchanged branch by identity', () => {
    const unchanged: GeneratedStep = { id: 'open-home', kind: 'action', action: 'navigate', url: '/' };
    const secretStep = generatedFill();
    const input: readonly GeneratedStep[] = [unchanged, secretStep];
    const snapshot = structuredClone(input);
    const attributed = attributeSecretGrants(input, prompt(FIRST_REF));

    expect(input).toStrictEqual(snapshot);
    expect(attributed).not.toBe(input);
    expect(attributed[0]).toBe(unchanged);
  });

  it('retains two same-reference grants when distinct citations resolve distinct occurrences', () => {
    const testMd = normalizeTestMd(`# Sign in\n${grantLine(FIRST_REF)}\nnotes\n${grantLine(FIRST_REF)}\n`);

    expect(attributeSecretGrants([generatedAi([
      { ref: FIRST_REF, citation: `${grantLine(FIRST_REF)}\nnotes` },
      { ref: FIRST_REF, citation: `notes\n${grantLine(FIRST_REF)}` },
    ])], testMd)).toEqual([committedAi([
      { ref: FIRST_REF, startLine: 2 },
      { ref: FIRST_REF, startLine: 4 },
    ])]);
  });

  it('rejects two same-reference citations that claim the same grant occurrence', () => {
    expectAttributionFailure(
      () => attributeSecretGrants([generatedAi([
        { ref: FIRST_REF, citation: grantLine(FIRST_REF) },
        { ref: FIRST_REF, citation: grantLine(FIRST_REF) },
      ])], prompt(FIRST_REF)),
      { reason: 'multiply-attributed-grant', secretRef: FIRST_REF, stepId: 'complete-sign-in' },
    );
  });
});

describe('assertCommittedSecretAttributionSound', () => {
  it('rejects a hand-edited fill-secret span that no longer identifies the matching grant', () => {
    expectAttributionFailure(
      () => assertCommittedSecretAttributionSound(plan([committedFill(FIRST_REF, 4)]), prompt(FIRST_REF)),
      { reason: 'stale-grant-span', secretRef: FIRST_REF, stepId: 'fill-password' },
    );
  });

  it('reports a stale span before an unrelated uncovered grant', () => {
    expectAttributionFailure(
      () => assertCommittedSecretAttributionSound(plan([committedFill(FIRST_REF, 4)]), prompt(FIRST_REF, SECOND_REF)),
      { reason: 'stale-grant-span', secretRef: FIRST_REF, stepId: 'fill-password' },
    );
  });

  it('rejects a duplicated persisted grant claim after each span passes staleness validation', () => {
    expectAttributionFailure(
      () => assertCommittedSecretAttributionSound(plan([
        committedFill(FIRST_REF, 3, 'first-use'),
        committedAi([{ ref: FIRST_REF, startLine: 3 }], 'second-use'),
      ]), prompt(FIRST_REF)),
      { reason: 'multiply-attributed-grant', secretRef: FIRST_REF, stepId: 'second-use' },
    );
  });

  it('reports a duplicate claim before an unrelated uncovered grant', () => {
    expectAttributionFailure(
      () => assertCommittedSecretAttributionSound(plan([
        committedFill(FIRST_REF, 3, 'first-use'),
        committedAi([{ ref: FIRST_REF, startLine: 3 }], 'second-use'),
      ]), prompt(FIRST_REF, SECOND_REF)),
      { reason: 'multiply-attributed-grant', secretRef: FIRST_REF, stepId: 'second-use' },
    );
  });

  it('rejects a fresh plan whose prompt has an unused grant', () => {
    expectAttributionFailure(
      () => assertCommittedSecretAttributionSound(plan([committedFill(FIRST_REF, 3)]), prompt(FIRST_REF, SECOND_REF)),
      {
        reason: 'uncovered-grant',
        secretRef: SECOND_REF,
        sourceSpan: { startLine: 4, endLine: 4 },
      },
    );
  });

  it('does not mutate the committed plan while checking persisted spans', () => {
    const document = plan([committedFill(FIRST_REF, 3)]);
    const snapshot = structuredClone(document);

    expect(() => assertCommittedSecretAttributionSound(document, prompt(FIRST_REF))).not.toThrow();
    expect(document).toStrictEqual(snapshot);
  });
});

describe('SECRET_GRANT_UNATTRIBUTABLE_HINTS', () => {
  it.each([
    ['citation-not-found', `If the secret use is intended, cite an exact, unique prompt excerpt containing one complete @ambercast-secret ${FIRST_REF} grant line, adding that line if it is absent; otherwise remove the secret use.`],
    ['citation-not-unique', `If the secret use is intended, include enough prompt text for the citation to identify exactly one complete @ambercast-secret ${FIRST_REF} grant line, adding that line if it is absent; otherwise remove the secret use.`],
    ['citation-missing-ref', `If the secret use is intended, cite one complete @ambercast-secret ${FIRST_REF} grant line including the literal ${FIRST_REF} token, adding that line if it is absent; otherwise remove the secret use.`],
    ['citation-unresolved', `If the secret use is intended, cite exactly one complete @ambercast-secret ${FIRST_REF} grant line outside Markdown code, narrowing the citation or adding that line as needed; otherwise remove the secret use.`],
    ['multiply-attributed-grant', `Remove the duplicate secret use, or give each intended use of ${FIRST_REF} a distinct @ambercast-secret grant line, cite each line during generation, and regenerate the plan before replay.`],
    ['uncovered-grant', `Use the @ambercast-secret ${FIRST_REF} grant for one intended secret use and cite it during generation, or remove the unused grant line.`],
    ['stale-grant-span', `If the secret use remains intended, restore its matching @ambercast-secret ${FIRST_REF} grant line and regenerate the plan; otherwise remove the use and regenerate the plan.`],
  ] as const)('keeps the %s remediation text exact', (reason, expected) => {
    expect(SECRET_GRANT_UNATTRIBUTABLE_HINTS[reason](FIRST_REF)).toBe(expected);
  });
});

describe('assertNoLiteralSecrets', () => {
  it.each([
    ['sk prefix', 'sk-live-secret-value', 'credential-prefix-sk'],
    ['GitHub token prefix', 'ghp_secret-value', 'credential-prefix-ghp'],
    ['AWS access key prefix', 'AKIASECRET123456789', 'credential-prefix-aws-access-key'],
  ] as const)('continues to reject a nested %s without retaining its literal value', (_description, value, detector) => {
    const document = plan([]);
    document.generatorMeta = { nested: { credentials: [value] } };

    expectLiteralSecretRejected(document, value, detector, 'generatorMeta.nested.credentials[0]');
  });

  it('continues to reject a high-entropy unconstrained generator-metadata token', () => {
    const token = 'aB3!dE5@fG7#hI9$jK2%mN4^pQ6&rS8T';
    const document = plan([]);
    document.generatorMeta = { token };

    expectLiteralSecretRejected(document, token, 'high-entropy-token', 'generatorMeta.token');
  });

  it('continues to exempt the usecase-computed source inputs digest by exact field path', () => {
    expect(() => assertNoLiteralSecrets(plan([]))).not.toThrow();
  });

  it('continues to exempt a valid whole secret reference from literal-secret detection', () => {
    const document = plan([]);
    document.generatorMeta = { credential: WHOLE_SECRET_REFERENCE };

    expect(() => assertNoLiteralSecrets(document)).not.toThrow();
  });

  it('continues to reject an embedded secret-reference marker in unconstrained metadata', () => {
    const note = 'Use {{secrets.LOGIN_PASSWORD}} exactly as copied.';
    const document = plan([]);
    document.generatorMeta = { note };

    expectLiteralSecretRejected(document, note, expect.any(String), 'generatorMeta.note');
  });

  it('applies the high-entropy threshold only at 32 characters and 4.0 bits per character', () => {
    const belowLength = 'aB3!dE5@fG7#hI9$jK2%mN4^pQ6&rS8';
    const atThreshold = `${belowLength}T`;
    const belowLengthDocument = plan([]);
    belowLengthDocument.generatorMeta = { belowLength };
    const lowEntropyDocument = plan([]);
    lowEntropyDocument.generatorMeta = { lowEntropy: 'a'.repeat(32) };
    const atThresholdDocument = plan([]);
    atThresholdDocument.generatorMeta = { atThreshold };

    expect(() => assertNoLiteralSecrets(belowLengthDocument)).not.toThrow();
    expect(() => assertNoLiteralSecrets(lowEntropyDocument)).not.toThrow();
    expectLiteralSecretRejected(
      atThresholdDocument,
      atThreshold,
      'high-entropy-token',
      'generatorMeta.atThreshold',
    );
  });

  it('continues to traverse schema-defined plan fields as well as unconstrained generator metadata', () => {
    const literal = 'sk-live-secret-in-fill-value';
    const document = plan([{
      id: 'fill-token',
      kind: 'action',
      action: 'fill',
      target: { strategy: 'accessibility', role: 'textbox', name: 'API token' },
      value: literal,
    }]);

    expectLiteralSecretRejected(document, literal, 'credential-prefix-sk', 'steps[0].value');
  });

  it('reports the deterministic first violation in lexical object-key and array-index order', () => {
    const first = 'ghp_first-secret-value';
    const second = 'AKIASECONDSECRET123';
    const later = 'sk-later-secret-value';
    const document = plan([]);
    document.generatorMeta = { zeta: later, alpha: [first, second] };

    expectLiteralSecretRejected(document, first, 'credential-prefix-ghp', 'generatorMeta.alpha[0]');
  });

  it('detects a secret-like metadata key without exposing that key in diagnostics', () => {
    const rejectedKey = 'sk-live-secret-key';
    const document = plan([]);
    document.generatorMeta = { [rejectedKey]: 'ordinary metadata' };

    expectLiteralSecretRejected(
      document,
      rejectedKey,
      'credential-prefix-sk',
      'generatorMeta[redacted-key]',
    );
  });
});
