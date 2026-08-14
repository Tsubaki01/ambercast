import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { createChromiumBrowserDriver } from '#adapters/browser/chromium.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import type { ElementRef, Fingerprint, JsonValueT, TargetDefinition } from '#core/ir/schema.js';
import type { BrowserSession } from '#ports/browser.js';
import { registerBrowserDriverContract } from '../contracts/browser-driver.contract.js';
import { resolveChromiumAvailability } from './support/chromium-availability.js';
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

const SUBMIT: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const UNIQUE_TARGET: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Unique target' };

let chromiumAvailable = false;
let activeSession: BrowserSession | undefined;

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
  return setup.exists ? FIXTURE_PAGE : MISSING_ELEMENT_PAGE;
}

async function createFixtureSession(setup: BrowserSessionContractSetup): Promise<BrowserSession> {
  const session = await createChromiumBrowserDriver().launch(TARGET);
  activeSession = session;
  await session.perform({ type: 'navigate', url: fixtureFor(setup) });
  return session;
}

async function actualFingerprintFor(setup: BrowserSessionContractSetup): Promise<Fingerprint> {
  // This fixed fixture needs only its placeholder: `resolveGrounded` returns
  // `element-not-found` when its own live fingerprint capture is undefined,
  // strictly before it reads the supplied fingerprint. The short circuit does
  // not imply that missing elements bypass snapshot capture in general.
  if (!setup.exists) {
    return setup.currentFingerprint;
  }

  if (activeSession === undefined) {
    throw new Error('The real-browser contract did not create a session before requesting its fingerprint.');
  }

  const snapshot = await activeSession.snapshotForResolution();
  return fingerprintFor(snapshot.accessibilityTree, setup.ref);
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
    actualFingerprintFor,
    dispose: () => {
      activeSession = undefined;
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

      await expect(session.resolveGrounded(SUBMIT, firstCandidateFingerprint)).resolves.toEqual({
        kind: 'miss',
        reason: 'ambiguous-match',
      });
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
