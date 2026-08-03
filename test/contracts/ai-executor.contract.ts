import { describe, expect, it } from 'vitest';
import type {
  AiActionController,
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
} from '../../src/ports/ai.js';
import type { PageSnapshot } from '../../src/ports/browser.js';

export interface AiExecutorContractScript {
  readonly execute: AiExecuteResult<unknown>;
  readonly executeAgentic: AiAgenticResult;
}

export interface AiExecutorContractHarness {
  createExecutor(scripted: AiExecutorContractScript): AiExecutor | Promise<AiExecutor>;
  executeRequests(): readonly AiExecuteRequest[];
  agenticRequests(): readonly AiAgenticRequest[];
  dispose?(): void | Promise<void>;
}

const RESPONSE_SCHEMA = { type: 'object', required: ['ok'] };
const EXECUTE_RESULT: AiExecuteResult<unknown> = { data: { ok: true }, raw: '{"ok":true}' };
const AGENTIC_RESULT: AiAgenticResult = { trace: [], outcome: 'success' };
const EMPTY_SNAPSHOT: PageSnapshot = { accessibilityTree: {}, screenshot: new Uint8Array() };
const CONTROLLER: AiActionController = {
  async perform(): Promise<void> {},
  async evaluateAssert() {
    return { passed: true } as const;
  },
  async snapshotForResolution(): Promise<PageSnapshot> {
    return EMPTY_SNAPSHOT;
  },
};

export function registerAiExecutorContract(harness: AiExecutorContractHarness): void {
  describe('AiExecutor contract', () => {
    it('returns a scripted structured result and forwards the prompt and response schema unchanged', async () => {
      try {
        const executor = await harness.createExecutor({ execute: EXECUTE_RESULT, executeAgentic: AGENTIC_RESULT });
        const request: AiExecuteRequest = {
          prompt: 'Return a JSON status.',
          responseSchema: RESPONSE_SCHEMA,
          context: { step: 'compile' },
        };

        await expect(executor.execute<unknown>(request)).resolves.toBe(EXECUTE_RESULT);
        expect(harness.executeRequests().at(-1)).toBe(request);
      } finally {
        await harness.dispose?.();
      }
    });

    it('receives the complete narrow agentic controller surface', async () => {
      try {
        const executor = await harness.createExecutor({ execute: EXECUTE_RESULT, executeAgentic: AGENTIC_RESULT });
        const request: AiAgenticRequest = { instructionPrompt: 'Complete the sign-in.', controller: CONTROLLER };

        await expect(executor.executeAgentic(request)).resolves.toBe(AGENTIC_RESULT);
        const received = harness.agenticRequests().at(-1);

        expect(received).toBeDefined();
        expect(received?.controller).toBe(CONTROLLER);
        expect(typeof received?.controller.perform).toBe('function');
        expect(typeof received?.controller.evaluateAssert).toBe('function');
        expect(typeof received?.controller.snapshotForResolution).toBe('function');
      } finally {
        await harness.dispose?.();
      }
    });

    it('reports availability as a boolean', async () => {
      try {
        const executor = await harness.createExecutor({ execute: EXECUTE_RESULT, executeAgentic: AGENTIC_RESULT });

        expect(typeof await executor.isAvailable()).toBe('boolean');
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
