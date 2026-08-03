import type { BrowserDriver, BrowserSession } from '../../src/ports/browser.js';

/**
 * Builds the thin driver double used when a test needs launch composition but
 * not browser-engine behavior. The factory stays lazy so each launch can own
 * an independently arranged session.
 *
 * @param sessionFactory - Creates the session returned from each launch.
 * @returns A Chromium driver, the only engine the IR defines.
 */
export function createFakeBrowserDriver(sessionFactory: () => BrowserSession): BrowserDriver {
  return {
    engine: 'chromium',
    async launch(): Promise<BrowserSession> {
      return sessionFactory();
    },
  };
}
