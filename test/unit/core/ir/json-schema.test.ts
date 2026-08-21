import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { getGroundingJsonSchema, getPlanJsonSchema } from '../../../../src/core/ir/json-schema.js';
import { GroundingDocument, PlanDocument } from '../../../../src/core/ir/schema.js';

type DocumentKind = 'plan' | 'grounding';
type ExpectedVerdict = 'valid' | 'invalid';

interface CorpusFixture {
  document: DocumentKind;
  expected: ExpectedVerdict;
  value: unknown;
}

interface NamedCorpusFixture extends CorpusFixture {
  name: string;
}

const corpusDirectoryUrl = new URL('../../../fixtures/ir/corpus/', import.meta.url);
const corpusDirectory = fileURLToPath(corpusDirectoryUrl);

function isCorpusFixture(value: unknown): value is CorpusFixture {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (candidate.document === 'plan' || candidate.document === 'grounding')
    && (candidate.expected === 'valid' || candidate.expected === 'invalid')
    && 'value' in candidate;
}

function loadCorpus(): NamedCorpusFixture[] {
  return readdirSync(corpusDirectory)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => {
      const parsed: unknown = JSON.parse(readFileSync(new URL(fileName, corpusDirectoryUrl), 'utf8'));

      if (!isCorpusFixture(parsed)) {
        throw new TypeError(`Invalid IR corpus fixture: ${fileName}`);
      }

      return { ...parsed, name: fileName };
    });
}

const corpus = loadCorpus();
const ajv = new Ajv2020({ strict: true });
const validators = {
  plan: ajv.compile(getPlanJsonSchema()),
  grounding: ajv.compile(getGroundingJsonSchema()),
};

describe('IR JSON Schema corpus equivalence', () => {
  it('contains valid and invalid fixtures for plan and grounding documents', () => {
    expect(corpus).not.toHaveLength(0);

    for (const document of ['plan', 'grounding'] as const) {
      const fixtures = corpus.filter((fixture) => fixture.document === document);
      expect(fixtures.some((fixture) => fixture.expected === 'valid')).toBe(true);
      expect(fixtures.some((fixture) => fixture.expected === 'invalid')).toBe(true);
    }
  });

  it.each(corpus)('$name has the expected zod and AJV verdict', (fixture) => {
    const expected = fixture.expected === 'valid';
    const zodSchema = fixture.document === 'plan' ? PlanDocument : GroundingDocument;
    const zodVerdict = zodSchema.safeParse(fixture.value).success;
    const ajvVerdict = validators[fixture.document](fixture.value);

    expect.soft(zodVerdict).toBe(expected);
    expect.soft(ajvVerdict).toBe(expected);
    expect(ajvVerdict).toBe(zodVerdict);
  });
});

describe('IR JSON Schema documents', () => {
  it.each([
    ['plan', getPlanJsonSchema],
    ['grounding', getGroundingJsonSchema],
  ] as const)('returns a strict-compilable JSON Schema 2020-12 document for %s', (_document, getSchema) => {
    const schema = getSchema();

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
  });

  it('publishes Plan v2 instruction coverage and additive Grounding-v1 trace coverage', () => {
    const planV2 = {
      schemaVersion: 2,
      source: { inputsDigest: 'a'.repeat(64) },
      targets: { app: { baseUrl: 'https://example.test', browser: 'chromium' } },
      steps: [{
        id: 'reach-dashboard',
        kind: 'ai',
        instruction: 'Reach the dashboard.',
        instructionCoverage: [{
          id: 'dashboard-reached',
          kind: 'success',
          sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 21 },
        }],
      }],
    };
    const coveredGroundingV1 = {
      schemaVersion: 1,
      planDigest: 'b'.repeat(64),
      entries: {
        'reach-dashboard': {
          kind: 'ai',
          trace: {
            events: [],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Dashboard' }],
            verificationCoverage: { 'dashboard-reached': 0 },
          },
        },
      },
    };

    expect(PlanDocument.safeParse(planV2).success).toBe(true);
    expect(validators.plan(planV2)).toBe(true);
    const { instructionCoverage: _coverage, ...aiStepWithoutCoverage } = planV2.steps[0]!;
    const planWithoutCoverage = { ...planV2, steps: [aiStepWithoutCoverage] };
    expect(PlanDocument.safeParse(planWithoutCoverage).success).toBe(false);
    expect(validators.plan(planWithoutCoverage)).toBe(false);
    expect(PlanDocument.safeParse({ ...planV2, schemaVersion: 1 }).success).toBe(false);
    expect(validators.plan({ ...planV2, schemaVersion: 1 })).toBe(false);
    expect(GroundingDocument.safeParse(coveredGroundingV1).success).toBe(true);
    expect(validators.grounding(coveredGroundingV1)).toBe(true);
  });
});
