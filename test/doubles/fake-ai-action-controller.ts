import type { AiActionController } from '../../src/ports/ai.js';
import type { AssertOutcome, PageSnapshot } from '../../src/ports/browser.js';

export function createFakeAiActionController(_overrides: Partial<AiActionController> = {}): AiActionController {
  return {
    async perform(_action): Promise<void> {
      throw new Error('not implemented');
    },
    async evaluateAssert(_check): Promise<AssertOutcome> {
      throw new Error('not implemented');
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      throw new Error('not implemented');
    },
  };
}
