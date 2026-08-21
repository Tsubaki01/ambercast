import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJsonSchemaFiles } from '../../../src/build-tools/generate-json-schema.js';
import { getConfigJsonSchema } from '../../../src/core/config/json-schema.js';
import { getGroundingJsonSchema, getPlanJsonSchema } from '../../../src/core/ir/json-schema.js';

interface CapturedWrite {
  path: string;
  content: string;
}

function captureSchemaWrites(): CapturedWrite[] {
  const writes: CapturedWrite[] = [];

  writeJsonSchemaFiles({
    outDir: '/schema-output',
    writeFile: (path, content) => {
      writes.push({ path, content });
    },
  });

  return writes;
}

describe('writeJsonSchemaFiles', () => {
  it('writes the exact compact JSON from all pure JSON Schema getters', () => {
    const expectedWrites: CapturedWrite[] = [
      { path: join('/schema-output', 'plan.schema.json'), content: JSON.stringify(getPlanJsonSchema()) },
      { path: join('/schema-output', 'grounding.schema.json'), content: JSON.stringify(getGroundingJsonSchema()) },
      { path: join('/schema-output', 'config.schema.json'), content: JSON.stringify(getConfigJsonSchema()) },
    ];

    expect(captureSchemaWrites()).toEqual(expectedWrites);
  });

  it('produces byte-identical writes when generation is repeated', () => {
    expect(captureSchemaWrites()).toEqual(captureSchemaWrites());
  });

  it('emits Plan-v2 required coverage and additive Grounding-v1 coverage fields', () => {
    const writes = captureSchemaWrites();
    const planText = writes.find(({ path }) => path.endsWith('plan.schema.json'))?.content ?? '';
    const groundingText = writes.find(({ path }) => path.endsWith('grounding.schema.json'))?.content ?? '';

    expect(planText).toContain('instructionCoverage');
    expect(planText).toContain('sourceSpan');
    expect(planText).toContain('startColumn');
    expect(planText).toContain('endColumn');
    expect(planText).toMatch(/"const":2/);
    expect(groundingText).toContain('verificationCoverage');
    expect(groundingText).toMatch(/"const":1/);
  });
});
