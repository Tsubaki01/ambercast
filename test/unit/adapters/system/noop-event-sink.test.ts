import { describe, expect, it } from 'vitest';
import type { EventSink, RunEvent } from '../../../../src/ports/system.js';
import { createNoopEventSink } from '../../../../src/adapters/system/noop-event-sink.js';
import { registerEventSinkContract } from '../../../contracts/event-sink.contract.js';

function createObservableNoopEventSink(): { readonly sink: EventSink; emitted(): readonly RunEvent[] } {
  const noop = createNoopEventSink();
  const events: RunEvent[] = [];

  return {
    sink: {
      emit(event: RunEvent): void {
        noop.emit(event);
        events.push({ ...event });
      },
    },
    emitted(): readonly RunEvent[] {
      return events.map((event) => ({ ...event }));
    },
  };
}

registerEventSinkContract({
  createSink: createObservableNoopEventSink,
});

const RUN_EVENT_CASES: readonly { readonly description: string; readonly event: RunEvent }[] = [
  { description: 'a step-start event', event: { type: 'step-start', stepId: 'open-page' } },
  { description: 'a grounded step-result event', event: { type: 'step-result', stepId: 'open-page', via: 'grounding' } },
  { description: 'an AI-resolved step-result event', event: { type: 'step-result', stepId: 'resolve-form', via: 'ai-resolve' } },
  { description: 'a trace-replayed step-result event', event: { type: 'step-result', stepId: 'replay-trace', via: 'trace-replay' } },
  { description: 'an ai-call event', event: { type: 'ai-call', stepId: 'resolve-form' } },
];

describe('createNoopEventSink()', () => {
  it.each(RUN_EVENT_CASES)('does not throw when emitting $description', ({ event }) => {
    const events = createNoopEventSink();

    expect(() => events.emit(event)).not.toThrow();
  });
});
