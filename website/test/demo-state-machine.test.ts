import { describe, expect, it } from 'vitest';
import { dispatch, litExhibit, type DemoEvent, type DemoPhase, type DemoSnapshot } from '../src/scripts/demo-state-machine.ts';

const EVENTS: readonly DemoEvent[] = ['generate', 'generationComplete', 'run', 'runComplete', 'reset'];

const SNAPSHOTS: Record<DemoPhase, DemoSnapshot> = {
  idle: { phase: 'idle', aiCalls: 0, runs: 0 },
  gen: { phase: 'gen', aiCalls: 1, runs: 0 },
  cast: { phase: 'cast', aiCalls: 1, runs: 0 },
  run: { phase: 'run', aiCalls: 1, runs: 1 },
  done: { phase: 'done', aiCalls: 1, runs: 1 },
};

const LEGAL_TRANSITIONS: readonly {
  readonly label: string;
  readonly snapshot: DemoSnapshot;
  readonly event: DemoEvent;
  readonly expected: DemoSnapshot;
}[] = [
  {
    label: 'starts generation from idle',
    snapshot: SNAPSHOTS.idle,
    event: 'generate',
    expected: { phase: 'gen', aiCalls: 1, runs: 0 },
  },
  {
    label: 'completes generation from gen',
    snapshot: SNAPSHOTS.gen,
    event: 'generationComplete',
    expected: { phase: 'cast', aiCalls: 1, runs: 0 },
  },
  {
    label: 'starts a run from cast',
    snapshot: SNAPSHOTS.cast,
    event: 'run',
    expected: { phase: 'run', aiCalls: 1, runs: 1 },
  },
  {
    label: 'completes a run from run',
    snapshot: SNAPSHOTS.run,
    event: 'runComplete',
    expected: { phase: 'done', aiCalls: 1, runs: 1 },
  },
  {
    label: 'starts another run from done',
    snapshot: SNAPSHOTS.done,
    event: 'run',
    expected: { phase: 'run', aiCalls: 1, runs: 2 },
  },
];

const VALID_EVENTS: Record<DemoPhase, readonly DemoEvent[]> = {
  idle: ['generate', 'reset'],
  gen: ['generationComplete', 'reset'],
  cast: ['run', 'reset'],
  run: ['runComplete', 'reset'],
  done: ['run', 'reset'],
};

const INVALID_TRANSITIONS = (Object.entries(SNAPSHOTS) as [DemoPhase, DemoSnapshot][]).flatMap(
  ([phase, snapshot]) => EVENTS
    .filter((event) => !VALID_EVENTS[phase].includes(event))
    .map((event) => ({ phase, snapshot, event })),
);

describe('dispatch', () => {
  it.each(LEGAL_TRANSITIONS)('$label', ({ snapshot, event, expected }) => {
    expect(dispatch(snapshot, event)).toEqual(expected);
  });

  it.each(INVALID_TRANSITIONS)('leaves $phase unchanged for invalid $event', ({ snapshot, event }) => {
    expect(() => dispatch(snapshot, event)).not.toThrow();
    expect(dispatch(snapshot, event)).toEqual(snapshot);
  });

  it('increments AI calls once for the accepted generate event only', () => {
    const generated = dispatch(SNAPSHOTS.idle, 'generate');

    expect(generated).toEqual({ phase: 'gen', aiCalls: 1, runs: 0 });
    expect(dispatch(generated, 'generate')).toEqual(generated);
  });

  it.each(['cast', 'done'] as const)('increments runs once when run starts from %s', (phase) => {
    const snapshot = SNAPSHOTS[phase];
    const running = dispatch(snapshot, 'run');

    expect(running.runs).toBe(snapshot.runs + 1);
    expect(dispatch(running, 'run')).toEqual(running);
  });

  it.each(Object.entries(SNAPSHOTS) as [DemoPhase, DemoSnapshot][])('resets %s to the idle counters', (_phase, snapshot) => {
    expect(dispatch(snapshot, 'reset')).toEqual({ phase: 'idle', aiCalls: 0, runs: 0 });
  });

  it('keeps reset idempotent', () => {
    const reset = dispatch(SNAPSHOTS.done, 'reset');

    expect(dispatch(reset, 'reset')).toEqual(reset);
  });
});

describe('litExhibit', () => {
  it.each([
    ['idle', 'prompt'], ['gen', 'plan'], ['cast', 'plan'], ['run', 'browser'], ['done', 'browser'],
  ] as const)('maps %s to %s', (phase, exhibit) => {
    expect(litExhibit(phase)).toBe(exhibit);
  });

  it('follows the legal path rather than the last clicked control', () => {
    let snapshot = SNAPSHOTS.idle;
    const events: DemoEvent[] = ['generate', 'generationComplete', 'run', 'runComplete', 'run', 'reset'];
    const expected = ['plan', 'plan', 'browser', 'browser', 'browser', 'prompt'];
    for (const [index, event] of events.entries()) {
      snapshot = dispatch(snapshot, event);
      expect(litExhibit(snapshot.phase)).toBe(expected[index]);
    }
  });
});
