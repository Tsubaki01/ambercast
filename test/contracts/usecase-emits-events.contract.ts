import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/ports/system.js';

/**
 * Supplies one use case's observable event-emission scenario to the shared
 * conformance contract.
 *
 * The scenario returns the events it emitted so the contract can verify the
 * use case's cross-cutting lifecycle responsibility without prescribing its
 * internal dependencies or event variants.
 */
export interface EmittingUsecaseScenario {
  /** Human-readable name used to identify this scenario's contract case. */
  readonly name: string;

  /** Executes the scenario and returns the lifecycle events it emitted. */
  run(): Promise<{ readonly emitted: readonly RunEvent[] }>;
}

/**
 * Registers the shared contract that every use case emits at least one event.
 *
 * @param scenarios - Explicit scenarios for each event-emitting use case.
 *
 * @remarks
 * This anti-hollowing-out contract preserves the cross-cutting event boundary
 * by requiring each declared use case to demonstrate observable emission. It
 * deliberately uses a plain scenario list rather than a reflection-based
 * use-case registry so each use case's meaningful event behavior is explicit
 * when it joins the boundary.
 */
export function registerUsecaseEmitsEventsContract(
  scenarios: readonly EmittingUsecaseScenario[],
): void {
  // Each event-emitting use case joins this contract through this explicit scenario list.
  describe('use case event-emission contract', () => {
    it.each(scenarios)('$name emits at least one event', async (scenario) => {
      const { emitted } = await scenario.run();

      expect(emitted.length).toBeGreaterThan(0);
    });
  });
}
