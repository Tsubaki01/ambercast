import { describe, expect, it } from 'vitest';
import type {
  AiActionController,
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
} from '../../src/ports/ai.js';
import type { TraceAction } from '../../src/core/ir/schema.js';
import type { AssertCheck, PageSnapshot } from '../../src/ports/browser.js';

export type AiExecutorContractAgenticScript = AiAgenticResult | (
  (request: AiAgenticRequest) => AiAgenticResult | Promise<AiAgenticResult>
);

export interface AiExecutorContractScript {
  readonly execute: AiExecuteResult<unknown>;
  readonly executeAgentic: AiExecutorContractAgenticScript;
  /** When present, the implementation must reject `execute` with this error. */
  readonly executeError?: Error;
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
const AGENTIC_RESULT: AiAgenticResult = { outcome: 'success' };
const EMPTY_SNAPSHOT: PageSnapshot = { accessibilityTree: {}, screenshot: new Uint8Array() };
const ACTION_A: TraceAction = { type: 'click', target: { strategy: 'accessibility', role: 'button', name: 'Submit' } };
const ACTION_B: TraceAction = { type: 'navigate', url: 'https://example.test/second-action' };
const CHECK: AssertCheck = { check: 'element-visible', target: ACTION_A.target };
const SECRET_FILL_ACTION: TraceAction = {
  type: 'fill-secret',
  target: ACTION_A.target,
  secretRef: '{{secrets.LOGIN_PASSWORD}}',
};

interface RecordingController {
  readonly controller: AiActionController;
  readonly performed: TraceAction[];
  readonly evaluated: AssertCheck[];
  readonly snapshotCalls: { count: number };
}

function createRecordingController(harness: AiExecutorContractHarness): RecordingController {
  const performed: TraceAction[] = [];
  const evaluated: AssertCheck[] = [];
  const snapshotCalls = { count: 0 };

  return {
    controller: harness.createActionController({
      perform: async (action) => {
        performed.push(action);
      },
      evaluateAssert: async (check) => {
        evaluated.push(check);
        return { passed: true };
      },
      snapshotForResolution: async () => {
        snapshotCalls.count += 1;
        return EMPTY_SNAPSHOT;
      },
    }),
    performed,
    evaluated,
    snapshotCalls,
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
          context: { step: 'generate' },
        };

        const result = await executor.execute<unknown>(request);

        expect(result.data).toEqual(EXECUTE_RESULT.data);
        expect(result.raw).toEqual(EXECUTE_RESULT.raw);
        expect(result.usage).toEqual(EXECUTE_RESULT.usage);
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects execute with the scripted error', async () => {
      try {
        const executeError = new Error('The scripted execute request failed.');
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: AGENTIC_RESULT,
          executeError,
        });

        await expect(executor.execute<unknown>({
          prompt: 'Return a JSON status.',
          responseSchema: RESPONSE_SCHEMA,
        })).rejects.toBe(executeError);
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
            return { outcome: 'success' };
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          priorTrace: [ACTION_B],
        });

        expect(recording.performed).toEqual([ACTION_A]);
        expect(recording.evaluated).toEqual([CHECK]);
        expect(recording.snapshotCalls.count).toBe(1);
        expect(result.outcome).toBe('success');
      } finally {
        await harness.dispose?.();
      }
    });

    it('forwards the full prior trace to agentic execution', async () => {
      try {
        const recording = createRecordingController(harness);
        let receivedPriorTrace: readonly TraceAction[] | undefined;
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: (request) => {
            receivedPriorTrace = request.priorTrace;
            return AGENTIC_RESULT;
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          priorTrace: [ACTION_B, SECRET_FILL_ACTION],
        });

        expect(receivedPriorTrace).toEqual([ACTION_B, SECRET_FILL_ACTION]);
        expect(result.outcome).toBe('success');
      } finally {
        await harness.dispose?.();
      }
    });

    it('keeps the controller\'s recorded actions limited to those performed before an agentic failure', async () => {
      try {
        const recording = createRecordingController(harness);
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            await request.controller.perform(ACTION_A);
            return { outcome: 'failure' };
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          priorTrace: [ACTION_B],
        });

        expect(recording.performed).toEqual([ACTION_A]);
        expect(recording.performed).not.toContainEqual(ACTION_B);
        expect(result.outcome).toBe('failure');
      } finally {
        await harness.dispose?.();
      }
    });

    it('keeps a secret fill reference unresolved at the controller boundary', async () => {
      try {
        const recording = createRecordingController(harness);
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            await request.controller.perform(SECRET_FILL_ACTION);
            return { outcome: 'success' };
          },
        });

        const result = await executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
        });

        // This proves a valid unresolved fill-secret action crosses unchanged; it does not show this port strips or rejects `value`, a parse-time schema guarantee covered by schema.test.ts.
        expect(recording.performed).toEqual([SECRET_FILL_ACTION]);
        expect(result.outcome).toBe('success');
      } finally {
        await harness.dispose?.();
      }
    });

    it('propagates a controller perform rejection from agentic execution', async () => {
      try {
        const controllerError = new Error('The secret reference could not be resolved.');
        const controller = harness.createActionController({
          perform: async () => {
            throw controllerError;
          },
        });
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            await request.controller.perform(ACTION_A);
            return AGENTIC_RESULT;
          },
        });

        await expect(executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller,
        })).rejects.toBe(controllerError);
      } finally {
        await harness.dispose?.();
      }
    });

    // This proves the signal reaches the implementation and its rejection is not converted into an outcome; it does not cover a mid-execution abort, which this logic-free port cannot interrupt.
    it('rejects an already-aborted agentic request', async () => {
      try {
        const recording = createRecordingController(harness);
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async (request) => {
            if (request.signal?.aborted) {
              throw new Error('The scripted agentic request was already aborted.');
            }

            return AGENTIC_RESULT;
          },
        });
        const abortController = new AbortController();
        abortController.abort();

        await expect(executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          signal: abortController.signal,
        })).rejects.toThrow('already aborted');
        expect(recording.performed).toEqual([]);
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
