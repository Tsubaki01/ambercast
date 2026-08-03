import type { EventSink, RunEvent } from '../../src/ports/system.js';

export interface RecordingEventSink {
  readonly sink: EventSink;
  emitted(): readonly RunEvent[];
}

export function createRecordingEventSink(): RecordingEventSink {
  return {
    sink: {
      emit(_event: RunEvent): void {
        throw new Error('not implemented');
      },
    },
    emitted(): readonly RunEvent[] {
      throw new Error('not implemented');
    },
  };
}
