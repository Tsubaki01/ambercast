import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAN_PRODUCER_SEMANTIC_REVISIONS } from '#core/ai/plan-producer-bundle.js';

const INSTRUCTION_COVERAGE_POLICY_FILE = fileURLToPath(new URL('../../../../src/usecases/instruction-coverage-policy.ts', import.meta.url));
const GENERATOR_SECRET_POLICY_FILE = fileURLToPath(new URL('../../../../src/usecases/generator-secret-policy.ts', import.meta.url));

const INSTRUCTION_COVERAGE_POLICY_PIN = { revision: 1, sourceSha256: '5cfaff98dbdb14aaa0b8ae6faeb45e7a491cf2e14a8cfd79a077e0138952bd77' } as const;
const GENERATOR_SECRET_POLICY_PIN = { revision: 2, sourceSha256: 'cb5787ddfcfdbd3fb2879e5fe0bfe51cbc3b4133fdcb846353154c543ab1b21d' } as const;

async function sha256File(fileName: string): Promise<string> {
  return createHash('sha256').update(await readFile(fileName)).digest('hex');
}

describe('producer semantic revision tripwires', () => {
  it('couples instruction-coverage policy source changes to its live semantic revision', async () => {
    expect({
      revision: PLAN_PRODUCER_SEMANTIC_REVISIONS.instructionCoveragePolicy,
      sourceSha256: await sha256File(INSTRUCTION_COVERAGE_POLICY_FILE),
    }).toEqual(INSTRUCTION_COVERAGE_POLICY_PIN);
  });

  it('couples generator-secret policy source changes to its live semantic revision', async () => {
    expect({
      revision: PLAN_PRODUCER_SEMANTIC_REVISIONS.generatorSecretPolicy,
      sourceSha256: await sha256File(GENERATOR_SECRET_POLICY_FILE),
    }).toEqual(GENERATOR_SECRET_POLICY_PIN);
  });
});
