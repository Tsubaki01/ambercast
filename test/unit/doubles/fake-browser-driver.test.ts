import { describe, expect, it } from 'vitest';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';

const TARGET = { baseUrl: 'https://example.test', browser: 'chromium' } as const;

describe('createFakeBrowserDriver', () => {
  it('declares chromium as the only currently supported engine', () => {
    const driver = createFakeBrowserDriver(() => createFakeBrowserSession(new Map()));

    expect(driver.engine).toBe('chromium');
  });

  it('creates and returns a session from its factory when launched', async () => {
    const session = createFakeBrowserSession(new Map());
    let factoryCalls = 0;
    const driver = createFakeBrowserDriver(() => {
      factoryCalls += 1;
      return session;
    });

    await expect(driver.launch(TARGET)).resolves.toBe(session);
    expect(factoryCalls).toBe(1);
  });
});
