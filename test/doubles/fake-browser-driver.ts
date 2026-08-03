import type { BrowserDriver, BrowserSession } from '../../src/ports/browser.js';

export function createFakeBrowserDriver(_sessionFactory: () => BrowserSession): BrowserDriver {
  return {
    engine: 'chromium',
    async launch(_target): Promise<BrowserSession> {
      throw new Error('not implemented');
    },
  };
}
