import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiExecutor } from '../../src/ports/ai.js';
import { typedJsonSchema } from '../../src/core/ai/typed-json-schema.js';
import { createFakeAiActionController } from '../doubles/fake-ai-action-controller.js';

function responseSchema() {
  return typedJsonSchema(z.object({ ok: z.boolean() }));
}

export interface AiExecutorTransportHarness {
  createExecutor(scenario: AiExecutorTransportScenario): AiExecutor | Promise<AiExecutor>;
  dispose?(): void | Promise<void>;
}

export type AiExecutorTransportScenario = 'success' | 'invalid-response' | 'pending' | 'availability' | 'agentic';

/**
 * Registers the transport subset shared by subprocess-backed executors.
 *
 * The full AI-executor contract exercises browser-controller dispatch, which
 * these structured CLI transports deliberately do not own. This suite fixes
 * their common abort, validation, availability, and capability boundary.
 */
export function registerAiExecutorTransportContract(harness: AiExecutorTransportHarness): void {
  describe('AiExecutor transport contract', () => {
    it('returns schema-validated structured data', async () => {
      try {
        const executor = await harness.createExecutor('success');

        await expect(executor.execute({
          prompt: 'Return {"ok": true}.',
          responseSchema: responseSchema(),
        })).resolves.toMatchObject({ data: { ok: true } });
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects malformed provider output instead of returning unvalidated data', async () => {
      try {
        const executor = await harness.createExecutor('invalid-response');

        await expect(executor.execute({
          prompt: 'Return valid JSON.',
          responseSchema: responseSchema(),
        })).rejects.toThrow(/response|json|invalid/i);
      } finally {
        await harness.dispose?.();
      }
    });

    it('does not invoke transport for an already-aborted structured request', async () => {
      try {
        const executor = await harness.createExecutor('pending');
        const controller = new AbortController();
        const reason = new Error('structured request cancelled before transport');
        controller.abort(reason);

        await expect(executor.execute({
          prompt: 'Return {"ok": true}.',
          responseSchema: responseSchema(),
          signal: controller.signal,
        })).rejects.toBe(reason);
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects an in-flight structured request when its signal aborts', async () => {
      try {
        const executor = await harness.createExecutor('pending');
        const controller = new AbortController();
        const reason = new Error('structured request cancelled in flight');
        const result = executor.execute({
          prompt: 'Return {"ok": true}.',
          responseSchema: responseSchema(),
          signal: controller.signal,
        });

        controller.abort(reason);
        await expect(result).rejects.toBe(reason);
      } finally {
        await harness.dispose?.();
      }
    });

    it('keeps a non-aborted structured request capable of succeeding', async () => {
      try {
        const executor = await harness.createExecutor('success');

        await expect(executor.execute({
          prompt: 'Return {"ok": true}.',
          responseSchema: responseSchema(),
        })).resolves.toBeDefined();
      } finally {
        await harness.dispose?.();
      }
    });

    it('returns availability as a boolean without exposing probe failures', async () => {
      try {
        const executor = await harness.createExecutor('availability');
        const controller = new AbortController();

        expect(typeof await executor.isAvailable(controller.signal)).toBe('boolean');
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects unsupported agentic execution before producing a fabricated result', async () => {
      try {
        const executor = await harness.createExecutor('agentic');

        await expect(executor.executeAgentic({
          instructionPrompt: 'Complete sign-in.',
          controller: createFakeAiActionController(),
        })).rejects.toThrow(/agentic|browser|unavailable/i);
      } finally {
        await harness.dispose?.();
      }
    });

    it('gives an already-aborted agentic request precedence over capability rejection', async () => {
      try {
        const executor = await harness.createExecutor('agentic');
        const controller = new AbortController();
        const reason = new Error('agentic request cancelled');
        controller.abort(reason);

        await expect(executor.executeAgentic({
          instructionPrompt: 'Complete sign-in.',
          controller: createFakeAiActionController(),
          signal: controller.signal,
        })).rejects.toBe(reason);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
