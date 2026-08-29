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
const AI_RESOLVED_EVENT: RunEvent = { type: 'step-result', stepId: 'resolve-form', via: 'ai-resolve' };
const TRACE_REPLAYED_EVENT: RunEvent = { type: 'step-result', stepId: 'replay-trace', via: 'trace-replay' };
const AI_CALL_EVENT: RunEvent = { type: 'ai-call', stepId: 'resolve-form' };
const UNSCOPED_AI_CALL_EVENT: RunEvent = { type: 'ai-call' };
const STAGE_TWO_REJECTED_EVENTS: readonly RunEvent[] = [
  'provider-error', 'response-shape', 'id-mismatch', 'secret-attribution',
  'coverage-invalid', 'obligation-mismatch', 'literal-secret', 'no-advance',
].map((reason) => ({ type: 'heal-stage2-rejected', stepId: 'resolve-form', reason } as RunEvent));
const STAGE_TWO_REJECTED_EVENT = STAGE_TWO_REJECTED_EVENTS[7]!;

export function registerEventSinkContract(harness: EventSinkContractHarness): void {
  describe('EventSink contract', () => {
    it('records events in emission order', async () => {
      try {
        const recording = await harness.createSink();

        expect(recording.emitted()).toEqual([]);

        recording.sink.emit(START_EVENT);

        expect(recording.emitted()).toEqual([START_EVENT]);

        recording.sink.emit(RESULT_EVENT);
        recording.sink.emit(STAGE_TWO_REJECTED_EVENT);

        expect(recording.emitted()).toEqual([START_EVENT, RESULT_EVENT, STAGE_TWO_REJECTED_EVENT]);
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

    it('does not throw while emitting every well-formed event variant', async () => {
      try {
        const recording = await harness.createSink();

        expect(() => recording.sink.emit(START_EVENT)).not.toThrow();
        expect(() => recording.sink.emit(RESULT_EVENT)).not.toThrow();
        expect(() => recording.sink.emit(AI_RESOLVED_EVENT)).not.toThrow();
        expect(() => recording.sink.emit(TRACE_REPLAYED_EVENT)).not.toThrow();
        expect(() => recording.sink.emit(AI_CALL_EVENT)).not.toThrow();
        expect(() => recording.sink.emit(UNSCOPED_AI_CALL_EVENT)).not.toThrow();
        for (const event of STAGE_TWO_REJECTED_EVENTS) {
          expect(() => recording.sink.emit(event)).not.toThrow();
        }

        expect(recording.emitted()).toEqual([
          START_EVENT,
          RESULT_EVENT,
          AI_RESOLVED_EVENT,
          TRACE_REPLAYED_EVENT,
          AI_CALL_EVENT,
          UNSCOPED_AI_CALL_EVENT,
          ...STAGE_TWO_REJECTED_EVENTS,
        ]);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
