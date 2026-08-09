import type { AiActionController } from '../../src/ports/ai.js';
import type { TraceAction, TraceAssert } from '../../src/core/ir/schema.js';
import type { AssertOutcome, PageSnapshot } from '../../src/ports/browser.js';

/**
 * The controller contract plus immutable-by-convention operation histories.
 */
export interface FakeAiActionController extends AiActionController {
  readonly performed: readonly TraceAction[];
  readonly evaluated: readonly TraceAssert[];
  readonly snapshots: number;
}

/**
 * Produces only the narrow controller surface available to agentic AI calls.
 *
 * Each operation requires an explicit scenario override. A loud failure is
 * preferable to a plausible default because an agentic test must reveal an
 * action it forgot to arrange.
 *
 * @param overrides - Per-operation behavior needed by the calling scenario.
 * @returns A controller that forwards configured operations unchanged.
 */
export function createFakeAiActionController(overrides: Partial<AiActionController> = {}): FakeAiActionController {
  const performed: TraceAction[] = [];
  const evaluated: TraceAssert[] = [];
  let snapshots = 0;

  return {
    async perform(action): Promise<void> {
      performed.push(action);
      if (overrides.perform === undefined) {
        throw new Error('No override configured for perform');
      }

      await overrides.perform(action);
    },
    async evaluateAssert(check: TraceAssert): Promise<AssertOutcome> {
      evaluated.push(check);
      if (overrides.evaluateAssert === undefined) {
        throw new Error('No override configured for evaluateAssert');
      }

      return overrides.evaluateAssert(check);
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      snapshots += 1;
      if (overrides.snapshotForResolution === undefined) {
        throw new Error('No override configured for snapshotForResolution');
      }

      return overrides.snapshotForResolution();
    },
    performed,
    evaluated,
    get snapshots(): number {
      return snapshots;
    },
  };
}
