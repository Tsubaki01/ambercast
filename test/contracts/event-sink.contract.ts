import { describe, expect, it } from 'vitest';
import type { EventSink, RunEvent } from '../../src/ports/system.js';

export interface EventSinkContractHarness {
  createSink(): { readonly sink: EventSink; emitted(): readonly RunEvent[] } | Promise<{
    readonly sink: EventSink;
    emitted(): readonly RunEvent[];
  }>;
  dispose?(): void | Promise<void>;
}

const START_EVENT: RunEvent = { type: 'step-start', stepId: 'open-page' };
const RESULT_EVENT: RunEvent = { type: 'step-result', stepId: 'open-page', via: 'grounding' };

export function registerEventSinkContract(harness: EventSinkContractHarness): void {
  describe('EventSink contract', () => {
    it('records events in emission order', async () => {
      try {
        const recording = await harness.createSink();
        recording.sink.emit(START_EVENT);
        recording.sink.emit(RESULT_EVENT);

        expect(recording.emitted()).toEqual([START_EVENT, RESULT_EVENT]);
      } finally {
        await harness.dispose?.();
      }
    });

    it('records duplicate events as separate deliveries', async () => {
      try {
        const recording = await harness.createSink();
        recording.sink.emit(START_EVENT);
        recording.sink.emit(START_EVENT);

        expect(recording.emitted()).toEqual([START_EVENT, START_EVENT]);
      } finally {
        await harness.dispose?.();
      }
    });

    it('does not throw while emitting a well-formed event', async () => {
      try {
        const recording = await harness.createSink();

        expect(() => recording.sink.emit(START_EVENT)).not.toThrow();
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
