/** The visual phases exposed by the client-only Generate → Run demonstration. */
export type DemoPhase = 'idle' | 'gen' | 'cast' | 'run' | 'done';

/** The only inputs accepted by the synchronous demonstration state machine. */
export type DemoEvent = 'generate' | 'generationComplete' | 'run' | 'runComplete' | 'reset';

/** A complete renderable snapshot; the DOM adapter derives every displayed state from it. */
export interface DemoSnapshot {
  phase: DemoPhase;
  aiCalls: number;
  runs: number;
}

/**
 * Applies one event to a demo snapshot without scheduling work or consulting the DOM.
 *
 * Every non-matching event is a no-op that preserves the exact prior snapshot, so duplicate
 * clicks and stale callbacks cannot corrupt state. Timing and reduced-motion handling stay in
 * the DOM adapter, which dispatches completion events after verifying they are still current.
 *
 * @param snapshot - The complete state currently rendered by the demo.
 * @param event - A user action or adapter-owned completion signal.
 * @returns The next immutable snapshot, or an equal-value snapshot for an invalid event.
 */
export function dispatch(snapshot: DemoSnapshot, event: DemoEvent): DemoSnapshot {
  switch (event) {
    case 'generate':
      return snapshot.phase === 'idle'
        ? { ...snapshot, phase: 'gen', aiCalls: snapshot.aiCalls + 1 }
        : { ...snapshot };
    case 'generationComplete':
      return snapshot.phase === 'gen' ? { ...snapshot, phase: 'cast' } : { ...snapshot };
    case 'run':
      return snapshot.phase === 'cast' || snapshot.phase === 'done'
        ? { ...snapshot, phase: 'run', runs: snapshot.runs + 1 }
        : { ...snapshot };
    case 'runComplete':
      return snapshot.phase === 'run' ? { ...snapshot, phase: 'done' } : { ...snapshot };
    case 'reset':
      return { phase: 'idle', aiCalls: 0, runs: 0 };
  }
}
