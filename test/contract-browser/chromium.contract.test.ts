import { beforeAll, beforeEach, describe } from 'vitest';
import { chromium } from 'playwright-core';
import { createChromiumBrowserDriver } from '#adapters/browser/chromium.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import type { Fingerprint, TargetDefinition } from '#core/ir/schema.js';
import type { BrowserSession } from '#ports/browser.js';
import { registerBrowserDriverContract } from '../contracts/browser-driver.contract.js';
import {
  registerBrowserSessionContract,
  type BrowserSessionContractSetup,
} from '../contracts/browser-session.contract.js';

const TARGET = {
  baseUrl: 'https://example.test',
  browser: 'chromium',
} as const satisfies TargetDefinition;

const FIXTURE_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <form aria-label="Sign in">
        <label>Email <input aria-label="Email" /></label>
        <button type="button">Submit</button>
      </form>
    </main>
  </body>
</html>`)}`;

const MISSING_ELEMENT_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <form aria-label="Sign in">
        <label>Email <input aria-label="Email" /></label>
      </form>
    </main>
  </body>
</html>`)}`;

let chromiumAvailable = false;
let activeSession: BrowserSession | undefined;

function fixtureFor(setup: BrowserSessionContractSetup): string {
  return setup.exists ? FIXTURE_PAGE : MISSING_ELEMENT_PAGE;
}

async function createFixtureSession(setup: BrowserSessionContractSetup): Promise<BrowserSession> {
  const session = await createChromiumBrowserDriver().launch(TARGET);
  activeSession = session;
  await session.perform({ type: 'navigate', url: fixtureFor(setup) });
  return session;
}

async function actualFingerprintFor(setup: BrowserSessionContractSetup): Promise<Fingerprint> {
  if (activeSession === undefined) {
    throw new Error('The real-browser contract did not create a session before requesting its fingerprint.');
  }

  const snapshot = await activeSession.snapshotForResolution();
  const fingerprint = computeAccessibilityFingerprint(snapshot.accessibilityTree, setup.ref);
  if (fingerprint === undefined) {
    throw new Error(`The fixture page does not contain ${setup.ref.role} "${setup.ref.name}".`);
  }

  return fingerprint;
}

describe('Chromium real-browser contract', () => {
  beforeAll(async () => {
    try {
      const browser = await chromium.launch();
      await browser.close();
      chromiumAvailable = true;
    } catch {
      chromiumAvailable = false;
    }
  });

  // Shared contract registration owns the individual `it` callbacks. This
  // hook therefore applies the same opt-in skip to every registered test.
  beforeEach((context) => {
    if (!chromiumAvailable) {
      context.skip('Chromium is unavailable for this opt-in contract lane; run `npx playwright install chromium` once.');
    }
  });

  registerBrowserDriverContract({
    createDriver: () => createChromiumBrowserDriver(),
  });

  registerBrowserSessionContract({
    createSession: createFixtureSession,
    actualFingerprintFor,
    dispose: () => {
      activeSession = undefined;
    },
  });
});
