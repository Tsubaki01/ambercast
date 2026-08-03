import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../../src/ports/system.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';

const START: RunEvent = { type: 'step-start', stepId: 'open-page' };
const RESULT: RunEvent = { type: 'step-result', stepId: 'open-page', via: 'grounding' };
const AI_CALL: RunEvent = { type: 'ai-call', stepId: 'resolve-form' };

describe('createRecordingEventSink', () => {
  it('starts with no recorded events', () => {
    expect(createRecordingEventSink().emitted()).toEqual([]);
  });

  it('records one event and many events in their exact call order', () => {
    const recording = createRecordingEventSink();
    recording.sink.emit(START);
    recording.sink.emit(RESULT);
    recording.sink.emit(AI_CALL);

    expect(recording.emitted()).toEqual([START, RESULT, AI_CALL]);
  });

  it('does not deduplicate repeated event objects', () => {
    const recording = createRecordingEventSink();
    recording.sink.emit(START);
    recording.sink.emit(START);

    expect(recording.emitted()).toEqual([START, START]);
  });

  it('keeps recordings isolated between instances', () => {
    const first = createRecordingEventSink();
    const second = createRecordingEventSink();
    first.sink.emit(START);

    expect(first.emitted()).toEqual([START]);
    expect(second.emitted()).toEqual([]);
  });
});
