import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserDriver, BrowserEngine } from '../../../../src/ports/browser.js';
import { BrowserLaunchFailedError } from '../../../../src/core/errors/browser-launch-failed-error.js';

const mocks = vi.hoisted(() => ({
  createChromiumBrowserDriver: vi.fn(),
}));

vi.mock('../../../../src/adapters/browser/chromium.js', () => ({
  createChromiumBrowserDriver: mocks.createChromiumBrowserDriver,
}));

import { createBrowserDriverResolver } from '../../../../src/adapters/browser/registry.js';

afterEach(() => {
  vi.resetAllMocks();
});

function chromiumDriver(): BrowserDriver {
  return { engine: 'chromium', launch: vi.fn() };
}

describe('createBrowserDriverResolver()', () => {
  it('resolves chromium through the registered driver factory', () => {
    const driver = chromiumDriver();
    mocks.createChromiumBrowserDriver.mockReturnValue(driver);

    const resolved = createBrowserDriverResolver()('chromium');

    expect(resolved).toBe(driver);
  });

  it('passes headed browser construction policy through to the Chromium factory', () => {
    const driver = chromiumDriver();
    mocks.createChromiumBrowserDriver.mockReturnValue(driver);

    const resolved = createBrowserDriverResolver({ headed: true })('chromium');

    expect(resolved).toBe(driver);
    expect(mocks.createChromiumBrowserDriver).toHaveBeenCalledWith({ headed: true });
  });

  it('throws BrowserLaunchFailedError for an unregistered engine', () => {
    const resolver = createBrowserDriverResolver();
    // BrowserEngine is a single-member literal type, so this is defensive forward-compatible coverage with no reachable production value.
    const unregisteredEngine = 'firefox' as unknown as BrowserEngine;

    expect(() => resolver(unregisteredEngine)).toThrow(BrowserLaunchFailedError);
  });
});
