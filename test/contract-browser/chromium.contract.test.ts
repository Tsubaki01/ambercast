import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import {
  createChromiumBrowserDriver,
  type PlaywrightBrowserHandle,
  type PlaywrightContextHandle,
  type PlaywrightLauncher,
  type PlaywrightLocatorHandle,
  type PlaywrightPageHandle,
} from '#adapters/browser/chromium.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import type { ElementRef, Fingerprint, JsonValueT, TargetDefinition } from '#core/ir/schema.js';
import type { BoundElement, BrowserSession } from '#ports/browser.js';
import { registerBrowserDriverContract } from '../contracts/browser-driver.contract.js';
import { resolveChromiumAvailability } from './support/chromium-availability.js';
import {
  registerBrowserSessionContract,
  type BrowserSessionOperationObservation,
  type BrowserSessionContractSetup,
} from '../contracts/browser-session.contract.js';

type PlaywrightBrowser = import('playwright-core').Browser;
type PlaywrightContext = import('playwright-core').BrowserContext;
type PlaywrightLocator = import('playwright-core').Locator;
type PlaywrightPage = import('playwright-core').Page;
type PlaywrightRole = Parameters<PlaywrightPage['getByRole']>[0];

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

const FIRST_AMBIGUOUS_SUBMIT_CANDIDATE_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <form aria-label="Primary form">
        <label>Email <input aria-label="Email" /></label>
        <button type="button">Submit</button>
      </form>
    </main>
  </body>
</html>`)}`;

const AMBIGUOUS_SUBMIT_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <form aria-label="Primary form">
        <label>Email <input aria-label="Email" /></label>
        <button type="button">Submit</button>
      </form>
      <section aria-label="Secondary controls">
        <label>Search <input aria-label="Search" /></label>
        <button type="button">Submit</button>
      </section>
    </main>
  </body>
</html>`)}`;

const MUTABLE_DESCRIPTOR_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <form aria-label="Sign in">
        <button type="button">Submit</button>
        <span id="descriptor">Alpha</span>
      </form>
      <button id="mutate" type="button">Mutate</button>
    </main>
    <script>
      document.querySelector('#mutate').addEventListener('click', () => {
        document.querySelector('#descriptor').textContent = 'Beta';
      });
    </script>
  </body>
</html>`)}`;

const SUBMIT: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const MUTATE: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Mutate' };
const UNIQUE_TARGET: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Unique target' };

let chromiumAvailable = false;
const operationObservations = new WeakMap<BrowserSession, BrowserSessionOperationObservation>();

type MutableOperationObservation = {
  ariaSnapshotCalls: number;
  roleLocatorCalls: number;
  finalOperationCalls: number;
};

function observeLocator(
  locator: PlaywrightLocator,
  observation: MutableOperationObservation,
): PlaywrightLocatorHandle {
  return {
    async click(): Promise<void> {
      observation.finalOperationCalls += 1;
      await locator.click();
    },
    async fill(value: string): Promise<void> {
      observation.finalOperationCalls += 1;
      await locator.fill(value);
    },
    async press(key: string): Promise<void> {
      observation.finalOperationCalls += 1;
      await locator.press(key);
    },
    async innerText(): Promise<string> {
      observation.finalOperationCalls += 1;
      return locator.innerText();
    },
    async isVisible(): Promise<boolean> {
      observation.finalOperationCalls += 1;
      return locator.isVisible();
    },
    async inputValue(): Promise<string> {
      observation.finalOperationCalls += 1;
      return locator.inputValue();
    },
    count: () => locator.count(),
    async ariaSnapshot(): Promise<string> {
      observation.ariaSnapshotCalls += 1;
      return locator.ariaSnapshot();
    },
  };
}

function observePage(
  page: PlaywrightPage,
  observation: MutableOperationObservation,
): PlaywrightPageHandle {
  let generation = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      generation += 1;
    }
  });

  return {
    goto: (url) => page.goto(url),
    getByRole: (role, options) => {
      observation.roleLocatorCalls += 1;
      return observeLocator(page.getByRole(role as PlaywrightRole, options), observation);
    },
    getByText: (text) => observeLocator(page.getByText(text), observation),
    locator: (selector) => observeLocator(page.locator(selector), observation),
    navigationGeneration: () => generation,
    url: () => page.url(),
    screenshot: () => page.screenshot(),
  };
}

function observeContext(
  context: PlaywrightContext,
  observation: MutableOperationObservation,
): PlaywrightContextHandle {
  return {
    newPage: async () => observePage(await context.newPage(), observation),
    close: () => context.close(),
  };
}

function observeBrowser(
  browser: PlaywrightBrowser,
  observation: MutableOperationObservation,
): PlaywrightBrowserHandle {
  return {
    newContext: async (options) => observeContext(await browser.newContext(options), observation),
    close: () => browser.close(),
  };
}

function createObservedLauncher(observation: MutableOperationObservation): PlaywrightLauncher {
  return {
    async launch(options): Promise<PlaywrightBrowserHandle> {
      return observeBrowser(await chromium.launch(options), observation);
    },
  };
}

function adjacentTextPage(text: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application"><button aria-label="Unique target">Act</button>${text}</main>
  </body>
</html>`)}`;
}

function fingerprintFor(tree: JsonValueT, ref: ElementRef): Fingerprint {
  const result = computeAccessibilityFingerprint(tree, ref, []);
  if (result.kind !== 'ok') {
    throw new Error(`The fixture page does not contain exactly one ${ref.role} "${ref.name}" (${result.kind}).`);
  }

  return result.fingerprint;
}

function treeContainingFirstCandidate(tree: JsonValueT, target: ElementRef): JsonValueT | undefined {
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) {
    return undefined;
  }

  const { children } = tree;
  if (!Array.isArray(children)) {
    return undefined;
  }

  for (const child of children) {
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      continue;
    }

    if (child.role === target.role && child.name === target.name) {
      return { role: 'root', name: '', children: [tree] };
    }

    const candidateTree = treeContainingFirstCandidate(child, target);
    if (candidateTree !== undefined) {
      return candidateTree;
    }
  }

  return undefined;
}

function fixtureFor(setup: BrowserSessionContractSetup): string {
  if (setup.scenario === 'ambiguous') {
    return AMBIGUOUS_SUBMIT_PAGE;
  }
  if (setup.scenario === 'descriptor-mutable') {
    return MUTABLE_DESCRIPTOR_PAGE;
  }

  return setup.exists ? FIXTURE_PAGE : MISSING_ELEMENT_PAGE;
}

async function createFixtureSession(setup: BrowserSessionContractSetup): Promise<BrowserSession> {
  const observation: MutableOperationObservation = {
    ariaSnapshotCalls: 0,
    roleLocatorCalls: 0,
    finalOperationCalls: 0,
  };
  const session = await createChromiumBrowserDriver({
    launcher: createObservedLauncher(observation),
  }).launch(TARGET);
  operationObservations.set(session, observation);
  await session.perform({ type: 'navigate', url: fixtureFor(setup) });
  return session;
}

async function actualFingerprintFor(
  session: BrowserSession,
  setup: BrowserSessionContractSetup,
): Promise<Fingerprint> {
  if (!setup.exists || setup.scenario === 'ambiguous') {
    return setup.currentFingerprint;
  }

  const snapshot = await session.snapshotForResolution();
  return fingerprintFor(snapshot.accessibilityTree, setup.ref);
}

async function bind(session: BrowserSession, ref: ElementRef, fingerprint: Fingerprint): Promise<BoundElement> {
  const result = await session.resolveGrounded(ref, { mode: 'verify', fingerprint });
  if (result.kind === 'miss') {
    throw new Error(`The real-browser fixture unexpectedly failed to bind ${ref.name}: ${result.reason}`);
  }

  return result.element;
}

describe('Chromium real-browser contract', () => {
  beforeAll(async () => {
    chromiumAvailable = await resolveChromiumAvailability(() => chromium.launch());
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
    navigationUrl: () => FIXTURE_PAGE,
    actualFingerprintFor,
    supportedGroundingMissReasons: [
      'fingerprint-mismatch',
      'element-not-found',
      'ambiguous-match',
      'secret-contaminated',
    ],
    invalidateDescriptor: async (session) => {
      const result = await session.resolveGrounded(MUTATE, { mode: 'compute', resolvedSecrets: [] });
      if (result.kind === 'miss') {
        throw new Error(`The mutation fixture cannot bind its control: ${result.reason}`);
      }
      await session.perform({ type: 'click', target: result.element });
    },
    operationObservation: (session) => {
      const observation = operationObservations.get(session);
      if (observation === undefined) {
        throw new Error('The observed real-browser contract session lost its operation counters.');
      }
      return { ...observation };
    },
  });

  it('reports ambiguous-match for a separate duplicate fixture even when one candidate has the stored hash', async () => {
    const session = await createChromiumBrowserDriver().launch(TARGET);

    try {
      await session.perform({ type: 'navigate', url: FIRST_AMBIGUOUS_SUBMIT_CANDIDATE_PAGE });
      const firstCandidateSnapshot = await session.snapshotForResolution();
      const firstCandidateFingerprint = fingerprintFor(firstCandidateSnapshot.accessibilityTree, SUBMIT);

      await session.perform({ type: 'navigate', url: AMBIGUOUS_SUBMIT_PAGE });
      const ambiguousSnapshot = await session.snapshotForResolution();
      const firstCandidateTree = treeContainingFirstCandidate(ambiguousSnapshot.accessibilityTree, SUBMIT);
      if (firstCandidateTree === undefined) {
        throw new Error('The ambiguous fixture must retain its first Submit candidate.');
      }

      expect(fingerprintFor(firstCandidateTree, SUBMIT)).toEqual(firstCandidateFingerprint);

      await expect(session.resolveGrounded(SUBMIT, {
        mode: 'verify',
        fingerprint: firstCandidateFingerprint,
      })).resolves.toEqual({
        kind: 'miss',
        reason: 'ambiguous-match',
      });
    } finally {
      await session.close();
    }
  });

  it('rejects a bound element after navigation to identical role/name and fingerprint evidence', async () => {
    const session = await createChromiumBrowserDriver().launch(TARGET);

    try {
      await session.perform({ type: 'navigate', url: adjacentTextPage('Alpha') });
      const firstFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, UNIQUE_TARGET);
      const target = await bind(session, UNIQUE_TARGET, firstFingerprint);

      await session.perform({ type: 'navigate', url: adjacentTextPage('Alpha') });
      const destinationFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, UNIQUE_TARGET);
      expect(destinationFingerprint).toEqual(firstFingerprint);

      await expect(session.perform({ type: 'click', target })).rejects.toThrow('navigation');
    } finally {
      await session.close();
    }
  });

  it.each([
    ['perform', async (session: BrowserSession, target: BoundElement) => session.perform({ type: 'click', target })],
    ['evaluateAssert', async (session: BrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'element-visible', target })],
    ['captureValue', async (session: BrowserSession, target: BoundElement) => session.captureValue(target, 'text')],
  ] as const)('rejects %s after the Mutate control changes the descriptor without navigation', async (_operation, invoke) => {
    const session = await createChromiumBrowserDriver().launch(TARGET);

    try {
      await session.perform({ type: 'navigate', url: MUTABLE_DESCRIPTOR_PAGE });
      const targetFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, SUBMIT);
      const target = await bind(session, SUBMIT, targetFingerprint);
      const mutatorFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, MUTATE);
      const mutator = await bind(session, MUTATE, mutatorFingerprint);

      await session.perform({ type: 'click', target: mutator });
      await expect(session.evaluateAssert({ check: 'url-matches', pattern: '^data:text/html,' })).resolves.toEqual({ passed: true });
      await expect(invoke(session, target)).rejects.toThrow('fingerprint');
    } finally {
      await session.close();
    }
  });

  it('changes the fingerprint when a direct adjacent text sibling changes from Alpha to Beta', async () => {
    const session = await createChromiumBrowserDriver().launch(TARGET);

    try {
      await session.perform({ type: 'navigate', url: adjacentTextPage('Alpha') });
      const alphaFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, UNIQUE_TARGET);

      await session.perform({ type: 'navigate', url: adjacentTextPage('Beta') });
      const betaFingerprint = fingerprintFor((await session.snapshotForResolution()).accessibilityTree, UNIQUE_TARGET);

      expect(betaFingerprint).not.toEqual(alphaFingerprint);
    } finally {
      await session.close();
    }
  });
});
