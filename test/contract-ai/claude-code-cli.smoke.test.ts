import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClaudeCodeCliExecutor } from '#adapters/ai/claude-code-cli/index.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';

let available = false;

describe('claude-code-cli smoke contract', () => {
  beforeAll(async () => {
    available = await createClaudeCodeCliExecutor().isAvailable();
  });

  // Availability is the only skip condition. A running provider call must
  // surface protocol and schema regressions as test failures.
  it('returns a validated trivial structured response from the live provider protocol', async (context) => {
    if (!available) {
      context.skip('The Claude CLI is unavailable for the opt-in live smoke check.');
    }

    const executor = createClaudeCodeCliExecutor();
    await expect(executor.execute({
      prompt: 'Respond with {"ok": true}.',
      responseSchema: typedJsonSchema(z.object({ ok: z.boolean() })),
    })).resolves.toMatchObject({ data: { ok: true } });
  });
});
