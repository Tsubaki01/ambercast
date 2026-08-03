import { describe, expect, it } from 'vitest';
import type {
  AiActionController,
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
} from '../../src/ports/ai.js';
import type { AssertCheck, PageSnapshot, PerformableAction } from '../../src/ports/browser.js';

export type AiExecutorContractAgenticScript = AiAgenticResult | (
  (request: AiAgenticRequest) => AiAgenticResult | Promise<AiAgenticResult>
);

export interface AiExecutorContractScript {
  readonly execute: AiExecuteResult<unknown>;
  readonly executeAgentic: AiExecutorContractAgenticScript;
}

export interface AiExecutorContractHarness {
  createExecutor(scripted: AiExecutorContractScript): AiExecutor | Promise<AiExecutor>;
  createActionController(overrides: Partial<AiActionController>): AiActionController;
  dispose?(): void | Promise<void>;
}

const RESPONSE_SCHEMA = { type: 'object', required: ['ok'] };
const EXECUTE_RESULT: AiExecuteResult<unknown> = {
  data: { ok: true },
  raw: '{"ok":true}',
  usage: { inputTokens: 13, outputTokens: 8 },
};
const AGENTIC_RESULT: AiAgenticResult = { trace: [], outcome: 'success' };
const EMPTY_SNAPSHOT: PageSnapshot = { accessibilityTree: {}, screenshot: new Uint8Array() };
const ACTION_A: PerformableAction = { type: 'click', target: { strategy: 'accessibility', role: 'button', name: 'Submit' } };
const ACTION_B: PerformableAction = { type: 'navigate', url: 'https://example.test/second-action' };
const CHECK: AssertCheck = { check: 'element-visible', target: ACTION_A.target };

interface RecordingController {
  readonly controller: AiActionController;
  readonly performed: PerformableAction[];
  readonly evaluated: AssertCheck[];
  readonly snapshots: [][];
}

function createRecordingController(harness: AiExecutorContractHarness): RecordingController {
  const performed: PerformableAction[] = [];
  const evaluated: AssertCheck[] = [];
  const snapshots: [][] = [];

  return {
    controller: harness.createActionController({
      perform: async (action) => {
        performed.push(action);
      },
      evaluateAssert: async (check) => {
        evaluated.push(check);
        return { passed: true };
      },
      snapshotForResolution: async (...argumentsReceived: []) => {
        snapshots.push(argumentsReceived);
        return EMPTY_SNAPSHOT;
      },
    }),
    performed,
    evaluated,
    snapshots,
  };
}

export function registerAiExecutorContract(harness: AiExecutorContractHarness): void {
  describe('AiExecutor contract', () => {
    it('returns the scripted structured result by value', async () => {
      try {
        const executor = await harness.createExecutor({ execute: EXECUTE_RESULT, executeAgentic: AGENTIC_RESULT });
        const request: AiExecuteRequest = {
          prompt: 'Return a JSON status.',
          responseSchema: RESPONSE_SCHEMA,
          context: { step: 'compile' },
        };

        const result = await executor.execute<unknown>(request);

        expect(result.data).toEqual(EXECUTE_RESULT.data);
        expect(result.raw).toEqual(EXECUTE_RESULT.raw);
        expect(result.usage).toEqual(EXECUTE_RESULT.usage);
      } finally {
        await harness.dispose?.();
      }
    });

    it('forwards the agentic controller behavior without requiring reference identity', async () => {
      try {
        const recording = createRecordingController(harness);
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            await request.controller.perform(ACTION_A);
            await request.controller.evaluateAssert(CHECK);
            await request.controller.snapshotForResolution();
            return { trace: [ACTION_A], outcome: 'success' };
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          priorTrace: [ACTION_B],
        });

        expect(recording.performed).toEqual([ACTION_A]);
        expect(recording.evaluated).toEqual([CHECK]);
        expect(recording.snapshots).toEqual([[]]);
        expect(result.trace).toEqual(recording.performed);
        expect(result.outcome).toBe('success');
      } finally {
        await harness.dispose?.();
      }
    });

    it('returns only the action performed before an agentic failure', async () => {
      try {
        const recording = createRecordingController(harness);
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            await request.controller.perform(ACTION_A);
            return { trace: [ACTION_A], outcome: 'failure' };
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          priorTrace: [ACTION_B],
        });

        expect(recording.performed).toEqual([ACTION_A]);
        expect(result.trace).toEqual(recording.performed);
        expect(result.trace).not.toContainEqual(ACTION_B);
        expect(result.outcome).toBe('failure');
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
