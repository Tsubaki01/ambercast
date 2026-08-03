import { describe, expect, it } from 'vitest';
import type { BrowserDriver } from '../../src/ports/browser.js';

export interface BrowserDriverContractHarness {
  createDriver(): BrowserDriver | Promise<BrowserDriver>;
  dispose?(): void | Promise<void>;
}

const TARGET = { baseUrl: 'https://example.test', browser: 'chromium' } as const;

export function registerBrowserDriverContract(harness: BrowserDriverContractHarness): void {
  describe('BrowserDriver contract', () => {
    it('declares the browser engine it launches', async () => {
      try {
        expect(await harness.createDriver()).toMatchObject({ engine: 'chromium' });
      } finally {
        await harness.dispose?.();
      }
    });

    it('launches a working browser session', async () => {
      try {
        const driver = await harness.createDriver();
        const session = await driver.launch(TARGET);

        expect(session).toMatchObject({
          perform: expect.any(Function),
          evaluateAssert: expect.any(Function),
          resolveGrounded: expect.any(Function),
          close: expect.any(Function),
        });
        await session.close();
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
