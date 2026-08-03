import { describe, expect, it } from 'vitest';
import type { AiAgenticResult, AiExecuteRequest, AiExecuteResult } from '../../../src/ports/ai.js';
import { createFakeAiActionController } from '../../doubles/fake-ai-action-controller.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';

const RESPONSE_SCHEMA = { type: 'object' };
const FIRST_RESULT: AiExecuteResult<unknown> = { data: { answer: 'first' }, raw: '{"answer":"first"}' };
const SECOND_RESULT: AiExecuteResult<unknown> = { data: { answer: 'second' }, raw: '{"answer":"second"}' };
const AGENTIC_RESULT: AiAgenticResult = { trace: [], outcome: 'success' };

function request(context: string): AiExecuteRequest {
  return { prompt: `respond to ${context}`, responseSchema: RESPONSE_SCHEMA, context };
}

describe('createFakeAiExecutor', () => {
  it('looks up a canned response by the caller-provided structural context key', async () => {
    const executor = createFakeAiExecutor({ cannedResponses: new Map([['step-one', FIRST_RESULT]]) });

    await expect(executor.execute(request('step-one'))).resolves.toBe(FIRST_RESULT);
  });

  it('rejects an unscripted request instead of silently returning undefined', async () => {
    const executor = createFakeAiExecutor({ cannedResponses: new Map([['step-one', FIRST_RESULT]]) });

    await expect(executor.execute(request('unknown-step'))).rejects.toThrow(/unscripted|unhandled/i);
  });

  it('rejects a request whose context is not a canned-response key string', async () => {
    const executor = createFakeAiExecutor({ cannedResponses: new Map([['step-one', FIRST_RESULT]]) });

    await expect(executor.execute({
      prompt: 'respond',
      responseSchema: RESPONSE_SCHEMA,
      context: { step: 'one' },
    })).rejects.toThrow('Unscripted AI execute request: context must be a string canned-response key');
  });

  it('supports an execute handler and passes it the original request', async () => {
    let received: AiExecuteRequest | undefined;
    const executor = createFakeAiExecutor({
      execute: (nextRequest) => {
        received = nextRequest;
        return FIRST_RESULT;
      },
    });
    const nextRequest = request('handler');

    await expect(executor.execute(nextRequest)).resolves.toBe(FIRST_RESULT);
    expect(received).toBe(nextRequest);
  });

  it('keys multiple distinct canned requests independently', async () => {
    const executor = createFakeAiExecutor({
      cannedResponses: new Map([
        ['step-one', FIRST_RESULT],
        ['step-two', SECOND_RESULT],
      ]),
    });

    await expect(Promise.all([executor.execute(request('step-one')), executor.execute(request('step-two'))]))
      .resolves.toEqual([FIRST_RESULT, SECOND_RESULT]);
  });

  it('passes the supplied narrow controller to its agentic handler', async () => {
    let receivedController: unknown;
    const executor = createFakeAiExecutor({
      executeAgentic: (agenticRequest) => {
        receivedController = agenticRequest.controller;
        return AGENTIC_RESULT;
      },
    });
    const controller = createFakeAiActionController();

    await expect(executor.executeAgentic({ instructionPrompt: 'Complete sign-in.', controller })).resolves.toBe(AGENTIC_RESULT);
    expect(receivedController).toBe(controller);
  });

  it('rejects an unscripted agentic request instead of silently returning a result', async () => {
    const controller = createFakeAiActionController();
    const executor = createFakeAiExecutor();

    await expect(executor.executeAgentic({ instructionPrompt: 'Complete sign-in.', controller }))
      .rejects.toThrow(/override|configured|unscripted/i);
  });

  it('reports each configured availability value', async () => {
    await expect(createFakeAiExecutor({ available: true }).isAvailable()).resolves.toBe(true);
    await expect(createFakeAiExecutor({ available: false }).isAvailable()).resolves.toBe(false);
  });

  it('keeps canned responses isolated between executor instances', async () => {
    const first = createFakeAiExecutor({ cannedResponses: new Map([['shared-step', FIRST_RESULT]]) });
    const second = createFakeAiExecutor({ cannedResponses: new Map([['shared-step', SECOND_RESULT]]) });

    await expect(first.execute(request('shared-step'))).resolves.toBe(FIRST_RESULT);
    await expect(second.execute(request('shared-step'))).resolves.toBe(SECOND_RESULT);
  });
});
