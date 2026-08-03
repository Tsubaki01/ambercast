import type { EventSink, RunEvent } from '../../src/ports/system.js';

/**
 * Couples an event sink to a read-only inspection view for assertions.
 *
 * `emitted()` returns fresh event objects in a fresh array so test code cannot
 * alter the sink's internal delivery history while still observing exact event
 * order and duplicates.
 */
export interface RecordingEventSink {
  readonly sink: EventSink;
  emitted(): readonly RunEvent[];
}

/**
 * Records every emitted event synchronously in scenario-local order.
 *
 * The double intentionally neither deduplicates nor filters events; it makes
 * the EventSink contract observable without letting reporting affect a test's
 * control flow.
 *
 * @returns A sink and its isolated event-history inspection method.
 */
export function createRecordingEventSink(): RecordingEventSink {
  const events: RunEvent[] = [];

  return {
    sink: {
      emit(event: RunEvent): void {
        events.push({ ...event });
      },
    },
    emitted(): readonly RunEvent[] {
      return events.map((event) => ({ ...event }));
    },
  };
}
