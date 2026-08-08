import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCodexCliExecutor } from '#adapters/ai/codex-cli/index.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';

let available = false;

describe('codex-cli smoke contract', () => {
  beforeAll(async () => {
    available = await createCodexCliExecutor().isAvailable();
  });

  // Availability is the only skip condition. A running provider call must
  // surface protocol and schema regressions as test failures.
  it('returns a validated trivial structured response from the live provider protocol', async (context) => {
    if (!available) {
      context.skip('The Codex CLI is unavailable for the opt-in live smoke check.');
    }

    const executor = createCodexCliExecutor();
    await expect(executor.execute({
      prompt: 'Respond with {"ok": true}.',
      responseSchema: typedJsonSchema(z.object({ ok: z.boolean() })),
    })).resolves.toMatchObject({ data: { ok: true } });
  });
});
