import type { AiActionController } from '../../src/ports/ai.js';
import type { AssertOutcome, PageSnapshot } from '../../src/ports/browser.js';

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
export function createFakeAiActionController(overrides: Partial<AiActionController> = {}): AiActionController {
  return {
    async perform(action): Promise<void> {
      if (overrides.perform === undefined) {
        throw new Error('No override configured for perform');
      }

      await overrides.perform(action);
    },
    async evaluateAssert(check): Promise<AssertOutcome> {
      if (overrides.evaluateAssert === undefined) {
        throw new Error('No override configured for evaluateAssert');
      }

      return overrides.evaluateAssert(check);
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      if (overrides.snapshotForResolution === undefined) {
        throw new Error('No override configured for snapshotForResolution');
      }

      return overrides.snapshotForResolution();
    },
  };
}
