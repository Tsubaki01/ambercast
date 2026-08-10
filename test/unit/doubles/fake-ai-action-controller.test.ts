import { describe, expect, it } from 'vitest';
import type { ElementRef, TraceAction, TraceAssert } from '../../../src/core/ir/schema.js';
import type { AssertOutcome, PageSnapshot } from '../../../src/ports/browser.js';
import { createFakeAiActionController } from '../../doubles/fake-ai-action-controller.js';

const REF: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const ACTION: TraceAction = { type: 'click', target: REF };
const CHECK: TraceAssert = { type: 'assert', check: 'element-visible', target: REF };
const OUTCOME: AssertOutcome = { passed: true, message: 'Visible' };
const SNAPSHOT: PageSnapshot = {
  accessibilityTree: { role: 'document' },
  screenshot: new Uint8Array([1, 2, 3]),
};

describe('createFakeAiActionController', () => {
  it('forwards every operation to its supplied override and returns its result', async () => {
    const performed: TraceAction[] = [];
    const evaluated: TraceAssert[] = [];
    const snapshotArguments: [][] = [];
    const controller = createFakeAiActionController({
      perform: async (action) => {
        performed.push(action);
      },
      evaluateAssert: async (check) => {
        evaluated.push(check);
        return OUTCOME;
      },
      snapshotForResolution: async (...argumentsReceived: []) => {
        snapshotArguments.push(argumentsReceived);
        return SNAPSHOT;
      },
    });

    await expect(controller.perform(ACTION)).resolves.toBeUndefined();
    await expect(controller.evaluateAssert(CHECK)).resolves.toBe(OUTCOME);
    await expect(controller.snapshotForResolution()).resolves.toBe(SNAPSHOT);

    expect(performed).toHaveLength(1);
    expect(performed[0]).toBe(ACTION);
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toBe(CHECK);
    expect(snapshotArguments).toEqual([[]]);
    expect(controller.performed).toEqual([ACTION]);
    expect(controller.evaluated).toEqual([CHECK]);
    expect(controller.snapshots).toBe(1);
  });

  it('rejects an operation without an override with a descriptive error', async () => {
    const controller = createFakeAiActionController();

    await expect(controller.perform(ACTION)).rejects.toThrow(/override|configured|unscripted/i);
    await expect(controller.evaluateAssert(CHECK)).rejects.toThrow(/override|configured|unscripted/i);
    await expect(controller.snapshotForResolution()).rejects.toThrow(/override|configured|unscripted/i);
  });

  it('keeps overrides from separately created controllers isolated', async () => {
    const firstActions: TraceAction[] = [];
    const secondActions: TraceAction[] = [];
    const first = createFakeAiActionController({
      perform: async (action) => {
        firstActions.push(action);
      },
    });
    const second = createFakeAiActionController({
      perform: async (action) => {
        secondActions.push(action);
      },
    });
    const secondAction: TraceAction = { type: 'navigate', url: 'https://example.test' };

    await Promise.all([first.perform(ACTION), second.perform(secondAction)]);

    expect(firstActions).toEqual([ACTION]);
    expect(secondActions).toEqual([secondAction]);
  });
});
