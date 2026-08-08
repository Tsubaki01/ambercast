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
import { typedJsonSchema } from '../../src/core/ai/typed-json-schema.js';
import { z } from 'zod';

export type AiExecutorContractAgenticScript = AiAgenticResult | (
  (request: AiAgenticRequest) => AiAgenticResult | Promise<AiAgenticResult>
);

export type AiExecutorContractExecuteScript = AiExecuteResult<unknown> | (
  (request: AiExecuteRequest<unknown>) => AiExecuteResult<unknown> | Promise<AiExecuteResult<unknown>>
);

export interface AiExecutorContractScript {
  readonly execute: AiExecutorContractExecuteScript;
  readonly executeAgentic: AiExecutorContractAgenticScript;
  /** When present, the implementation must reject `execute` with this error. */
  readonly executeError?: Error;
}

export interface AiExecutorContractHarness {
  createExecutor(scripted: AiExecutorContractScript): AiExecutor | Promise<AiExecutor>;
  createActionController(overrides: Partial<AiActionController>): AiActionController;
  dispose?(): void | Promise<void>;
}

function responseSchema() {
  return typedJsonSchema(z.object({ ok: z.boolean() }));
}
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
          responseSchema: responseSchema(),
          context: { step: 'generate' },
        };

        const result = await executor.execute(request);

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

        await expect(executor.execute({
          prompt: 'Return a JSON status.',
          responseSchema: responseSchema(),
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

    it('rejects an already-aborted structured request without invoking a signal-insensitive handler', async () => {
      try {
        const abortController = new AbortController();
        const abortReason = new Error('The structured request was aborted.');
        abortController.abort(abortReason);
        let handlerCalls = 0;
        const executor = await harness.createExecutor({
          execute: () => {
            handlerCalls += 1;
            return EXECUTE_RESULT;
          },
          executeAgentic: AGENTIC_RESULT,
        });

        await expect(executor.execute({
          prompt: 'Return a JSON status.',
          responseSchema: responseSchema(),
          signal: abortController.signal,
        })).rejects.toBe(abortReason);
        expect(handlerCalls).toBe(0);
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects a structured request aborted while a signal-insensitive handler remains pending', async () => {
      try {
        let resolveHandler: ((value: AiExecuteResult<unknown>) => void) | undefined;
        let handlerStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          handlerStarted = resolve;
        });
        const executor = await harness.createExecutor({
          execute: () => new Promise<AiExecuteResult<unknown>>((resolve) => {
            resolveHandler = resolve;
            handlerStarted?.();
          }),
          executeAgentic: AGENTIC_RESULT,
        });
        const abortController = new AbortController();
        const abortReason = new Error('The structured request was aborted in flight.');
        const result = executor.execute({
          prompt: 'Return a JSON status.',
          responseSchema: responseSchema(),
          signal: abortController.signal,
        });

        await started;
        abortController.abort(abortReason);
        await expect(result).rejects.toBe(abortReason);
        resolveHandler?.(EXECUTE_RESULT);
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects an already-aborted agentic request without invoking a signal-insensitive handler', async () => {
      try {
        const recording = createRecordingController(harness);
        let handlerCalls = 0;
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: async () => {
            handlerCalls += 1;
            return AGENTIC_RESULT;
          },
        });
        const abortController = new AbortController();
        const abortReason = new Error('The agentic request was aborted.');
        abortController.abort(abortReason);

        await expect(executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          signal: abortController.signal,
        })).rejects.toBe(abortReason);
        expect(recording.performed).toEqual([]);
        expect(handlerCalls).toBe(0);
      } finally {
        await harness.dispose?.();
      }
    });

    it('rejects an agentic request aborted while a signal-insensitive handler remains pending', async () => {
      try {
        const recording = createRecordingController(harness);
        let resolveHandler: ((value: AiAgenticResult) => void) | undefined;
        let handlerStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          handlerStarted = resolve;
        });
        const executor = await harness.createExecutor({
          execute: EXECUTE_RESULT,
          executeAgentic: () => new Promise<AiAgenticResult>((resolve) => {
            resolveHandler = resolve;
            handlerStarted?.();
          }),
        });
        const abortController = new AbortController();
        const abortReason = new Error('The agentic request was aborted in flight.');
        const result = executor.executeAgentic({
          instructionPrompt: 'Complete the sign-in.',
          controller: recording.controller,
          signal: abortController.signal,
        });

        await started;
        abortController.abort(abortReason);
        await expect(result).rejects.toBe(abortReason);
        resolveHandler?.(AGENTIC_RESULT);
      } finally {
        await harness.dispose?.();
      }
    });

    it('reports availability as a boolean', async () => {
      try {
        const executor = await harness.createExecutor({ execute: EXECUTE_RESULT, executeAgentic: AGENTIC_RESULT });
        const controller = new AbortController();

        expect(typeof await executor.isAvailable(controller.signal)).toBe('boolean');
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
