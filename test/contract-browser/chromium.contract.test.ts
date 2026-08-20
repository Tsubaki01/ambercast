import { createServer, type Server } from 'node:http';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';
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
type PlaywrightPhysicalHandle = Awaited<ReturnType<PlaywrightLocator['elementHandle']>>;

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

const DUPLICATE_TEXT_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main aria-label="Application">
      <p>Repeated status</p>
      <p>Repeated status</p>
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
const SECRET_INPUT: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Secret input' };
const MATERIALIZED_SECRET = 'contract-only-materialized-secret';

let chromiumAvailable = false;

beforeAll(async () => {
  chromiumAvailable = await resolveChromiumAvailability(() => chromium.launch());
});

// Both contract groups launch real Chromium. This file-scoped hook applies the
// same opt-in availability decision to every registered and local test.
beforeEach((context) => {
  if (!chromiumAvailable) {
    context.skip('Chromium is unavailable for this opt-in contract lane; run `npx playwright install chromium` once.');
  }
});

type MutableOperationObservation = {
  ariaSnapshotCalls: number;
  roleLocatorCalls: number;
  finalOperationCalls: number;
  strictAcquisitionCalls: number;
  physicalFillCalls: number;
  physicalDisposeCalls: number;
};

const operationObservations = new WeakMap<BrowserSession, MutableOperationObservation>();

type CleanupTask = () => Promise<void> | void;

// Cleanup must not erase the operation outcome that explains why a browser
// contract failed. Run every cleanup task and retain both causes when they fail.
async function runWithCleanup<T>(
  operation: () => Promise<T>,
  cleanupTasks: readonly CleanupTask[],
): Promise<T> {
  const operationOutcome = await Promise.resolve().then(operation).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason: unknown) => ({ status: 'rejected', reason }) as const,
  );
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanupTasks) {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (operationOutcome.status === 'rejected') {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [operationOutcome.reason, ...cleanupFailures],
        'The browser contract operation and its cleanup both failed.',
      );
    }
    throw operationOutcome.reason;
  }
  if (cleanupFailures.length === 1) {
    throw cleanupFailures[0];
  }
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Multiple browser contract cleanup tasks failed.');
  }

  return operationOutcome.value;
}

function observeLocator(
  locator: PlaywrightLocator,
  observation: MutableOperationObservation,
): PlaywrightLocatorHandle {
  const observedLocator = {
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
    async elementHandle() {
      observation.strictAcquisitionCalls += 1;
      const handle = await locator.elementHandle();
      return {
        async fill(value: string): Promise<void> {
          observation.physicalFillCalls += 1;
          await handle.fill(value);
        },
        async dispose(): Promise<void> {
          observation.physicalDisposeCalls += 1;
          await handle.dispose();
        },
      };
    },
  };

  return observedLocator;
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

type ProductionOperationObservation = {
  active: boolean;
  duplicateBeforeAcquisition: boolean;
  strictAcquisitionCalls: number;
  physicalFillCalls: number;
  physicalFillArgumentWasExpected: boolean;
  physicalDisposeCalls: number;
  firstCalls: number;
  lastCalls: number;
  nthCalls: number;
};

type MutableLocatorPrototype = Pick<PlaywrightLocator, 'elementHandle' | 'first' | 'last' | 'nth'>;
type MutablePhysicalHandlePrototype = Pick<PlaywrightPhysicalHandle, 'dispose' | 'fill'>;

async function installProductionOperationObservation(
  fixtureUrl: string,
  observation: ProductionOperationObservation,
): Promise<() => void> {
  const probeBrowser = await chromium.launch();
  let probeHandle: PlaywrightPhysicalHandle | undefined;
  const [locatorPrototype, physicalHandlePrototype] = await runWithCleanup(async () => {
    const probeContext = await probeBrowser.newContext();
    const probePage = await probeContext.newPage();
    await probePage.goto(fixtureUrl);
    const probeLocator = probePage.getByRole('textbox', {
      name: SECRET_INPUT.name,
      exact: true,
    });
    probeHandle = await probeLocator.elementHandle();
    return [
      Object.getPrototypeOf(probeLocator) as MutableLocatorPrototype,
      Object.getPrototypeOf(probeHandle) as MutablePhysicalHandlePrototype,
    ] as const;
  }, [
    () => probeHandle?.dispose(),
    () => probeBrowser.close(),
  ]);

  const originalElementHandle = locatorPrototype.elementHandle;
  const originalFirst = locatorPrototype.first;
  const originalLast = locatorPrototype.last;
  const originalNth = locatorPrototype.nth;
  const originalFill = physicalHandlePrototype.fill;
  const originalDispose = physicalHandlePrototype.dispose;

  locatorPrototype.elementHandle = async function (
    this: PlaywrightLocator,
    ...args: Parameters<PlaywrightLocator['elementHandle']>
  ): ReturnType<PlaywrightLocator['elementHandle']> {
    if (observation.active) {
      observation.strictAcquisitionCalls += 1;
      if (observation.duplicateBeforeAcquisition) {
        observation.duplicateBeforeAcquisition = false;
        await this.page().evaluate(() => {
          const pageDocument = (globalThis as unknown as {
            document: {
              body: { append(node: unknown): void };
              createElement(tag: 'input'): { setAttribute(name: string, value: string): void };
            };
          }).document;
          const duplicate = pageDocument.createElement('input');
          duplicate.setAttribute('aria-label', 'Secret input');
          pageDocument.body.append(duplicate);
        });
      }
    }
    return originalElementHandle.apply(this, args);
  };
  locatorPrototype.first = function (this: PlaywrightLocator): PlaywrightLocator {
    if (observation.active) {
      observation.firstCalls += 1;
    }
    return originalFirst.call(this);
  };
  locatorPrototype.last = function (this: PlaywrightLocator): PlaywrightLocator {
    if (observation.active) {
      observation.lastCalls += 1;
    }
    return originalLast.call(this);
  };
  locatorPrototype.nth = function (this: PlaywrightLocator, index: number): PlaywrightLocator {
    if (observation.active) {
      observation.nthCalls += 1;
    }
    return originalNth.call(this, index);
  };
  physicalHandlePrototype.fill = async function (
    this: PlaywrightPhysicalHandle,
    ...args: Parameters<PlaywrightPhysicalHandle['fill']>
  ): ReturnType<PlaywrightPhysicalHandle['fill']> {
    if (observation.active) {
      observation.physicalFillCalls += 1;
      observation.physicalFillArgumentWasExpected = args[0] === MATERIALIZED_SECRET;
    }
    return originalFill.apply(this, args);
  };
  physicalHandlePrototype.dispose = async function (
    this: PlaywrightPhysicalHandle,
  ): ReturnType<PlaywrightPhysicalHandle['dispose']> {
    if (observation.active) {
      observation.physicalDisposeCalls += 1;
    }
    return originalDispose.call(this);
  };

  return () => {
    locatorPrototype.elementHandle = originalElementHandle;
    locatorPrototype.first = originalFirst;
    locatorPrototype.last = originalLast;
    locatorPrototype.nth = originalNth;
    physicalHandlePrototype.fill = originalFill;
    physicalHandlePrototype.dispose = originalDispose;
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
    strictAcquisitionCalls: 0,
    physicalFillCalls: 0,
    physicalDisposeCalls: 0,
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

type SecretRaceFixture = {
  readonly allowedUrl: string;
  readonly disallowedUrl: string;
  readonly successUrl: string;
  armNavigation(pageCount: number): Promise<void>;
  awaitFillTriggered(pageCount: number): Promise<void>;
  awaitDestinationCommit(pageCount: number): Promise<void>;
  close(): Promise<void>;
};

function safelySerializeErrorSurface(error: unknown): string {
  const ownProperties: Record<string, unknown> = {};
  if (typeof error === 'object' && error !== null) {
    for (const property of Object.getOwnPropertyNames(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, property);
      ownProperties[property] = descriptor !== undefined && 'value' in descriptor
        ? descriptor.value
        : '[Accessor property]';
    }
  } else {
    ownProperties.value = error;
  }

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(ownProperties, (_key, value: unknown) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (typeof value !== 'object' || value === null) {
        return value;
      }
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
      if (!(value instanceof Error)) {
        return value;
      }

      const nestedError: Record<string, unknown> = {
        message: value.message,
        name: value.name,
      };
      for (const property of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        nestedError[property] = descriptor !== undefined && 'value' in descriptor
          ? descriptor.value
          : '[Accessor property]';
      }
      return nestedError;
    });
  } catch {
    return '[Unserializable error surface]';
  }
}

function observeHostConsoleSilence() {
  const spies = [
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];

  return {
    expectNoCalls(): void {
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    },
    restore(): void {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The secret-race fixture server did not expose a TCP address.');
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeLoopbackServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function createSecretRaceFixture(): Promise<SecretRaceFixture> {
  const destinationPage = `<!doctype html>
<html lang="en">
  <body>
    <main>
      <label>Secret input <input aria-label="Secret input" /></label>
      <p id="destination-status">Destination empty</p>
    </main>
    <script>
      const input = document.querySelector('input');
      const status = document.querySelector('#destination-status');
      input.addEventListener('input', () => {
        status.textContent = input.value.length === 0 ? 'Destination empty' : 'Destination filled';
      });
    </script>
  </body>
</html>`;
  let destinationRequestCount = 0;
  let destinationCommitCount = 0;
  const destinationRequestWaiters = new Map<number, () => void>();
  const destinationCommitWaiters = new Map<number, () => void>();
  const disallowedServer = createServer((request, response) => {
    if (request.url === '/committed') {
      destinationCommitCount += 1;
      destinationCommitWaiters.get(destinationCommitCount)?.();
      destinationCommitWaiters.delete(destinationCommitCount);
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (request.url === '/destination') {
      destinationRequestCount += 1;
      destinationRequestWaiters.get(destinationRequestCount)?.();
      destinationRequestWaiters.delete(destinationRequestCount);
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(destinationPage.replace(
      '</body>',
      `<script>void fetch('/committed', { cache: 'no-store', method: 'POST' });</script></body>`,
    ));
  });
  const disallowedOrigin = await listenOnLoopback(disallowedServer);
  const disallowedUrl = `${disallowedOrigin}/destination`;

  let armRequestCount = 0;
  let fillTriggeredCount = 0;
  const armRequestWaiters = new Map<number, () => void>();
  const fillTriggeredWaiters = new Map<number, () => void>();
  const allowedServer = createServer((request, response) => {
    if (request.url === '/arm') {
      armRequestCount += 1;
      const pageCount = armRequestCount;
      armRequestWaiters.get(pageCount)?.();
      armRequestWaiters.delete(pageCount);
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (request.url === '/focused') {
      fillTriggeredCount += 1;
      fillTriggeredWaiters.get(fillTriggeredCount)?.();
      fillTriggeredWaiters.delete(fillTriggeredCount);
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    if (request.url === '/success') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(`<!doctype html>
<html lang="en">
  <body>
    <main><label>Secret input <input aria-label="Secret input" /></label></main>
  </body>
</html>`);
      return;
    }

    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(`<!doctype html>
<html lang="en">
  <body>
    <main>
      <label>Secret input <input aria-label="Secret input" disabled /></label>
    </main>
    <script>
      const input = document.querySelector('input');
      // This marker makes navigation a consequence of Playwright selecting the in-flight action target.
      // It is an undocumented internal marker verified against Playwright 1.62.1; upgrades must revalidate it.
      input.addEventListener('__playwright_mark_target__', () => {
        input.disabled = false;
        input.focus();
        input.remove();
        navigator.sendBeacon('/focused');
        window.location.assign(${JSON.stringify(disallowedUrl)});
      }, { once: true });
      void fetch('/arm', { cache: 'no-store' });
    </script>
  </body>
</html>`);
  });

  try {
    const allowedOrigin = await listenOnLoopback(allowedServer);
    return {
      allowedUrl: `${allowedOrigin}/allowed`,
      disallowedUrl,
      successUrl: `${allowedOrigin}/success`,
      async armNavigation(pageCount): Promise<void> {
        if (armRequestCount < pageCount) {
          await new Promise<void>((resolve) => {
            armRequestWaiters.set(pageCount, resolve);
          });
        }
      },
      async awaitFillTriggered(pageCount): Promise<void> {
        if (fillTriggeredCount < pageCount) {
          await new Promise<void>((resolve) => {
            fillTriggeredWaiters.set(pageCount, resolve);
          });
        }
      },
      async awaitDestinationCommit(pageCount): Promise<void> {
        if (destinationRequestCount < pageCount) {
          await new Promise<void>((resolve) => {
            destinationRequestWaiters.set(pageCount, resolve);
          });
        }
        if (destinationCommitCount < pageCount) {
          await new Promise<void>((resolve) => {
            destinationCommitWaiters.set(pageCount, resolve);
          });
        }
      },
      async close(): Promise<void> {
        const results = await Promise.allSettled([
          closeLoopbackServer(allowedServer),
          closeLoopbackServer(disallowedServer),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          throw failure.reason;
        }
      },
    };
  } catch (error) {
    await closeLoopbackServer(disallowedServer);
    throw error;
  }
}

describe('Chromium real-browser contract', () => {
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
      return {
        ariaSnapshotCalls: observation.ariaSnapshotCalls,
        roleLocatorCalls: observation.roleLocatorCalls,
        finalOperationCalls: observation.finalOperationCalls,
      } satisfies BrowserSessionOperationObservation;
    },
  });

  it('evaluates text-visible against repeated visible text without a strict-mode violation', async () => {
    const session = await createChromiumBrowserDriver().launch(TARGET);

    try {
      await session.perform({ type: 'navigate', url: DUPLICATE_TEXT_PAGE });

      await expect(session.evaluateAssert({
        check: 'text-visible',
        text: 'Repeated status',
      })).resolves.toEqual({ passed: true });
    } finally {
      await session.close();
    }
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

describe('Chromium secret-fill target pinning', () => {
  it('uses the default production adapter for strict acquisition and the physical-handle lifecycle', async () => {
    const fixture = await createSecretRaceFixture();
    const observation: ProductionOperationObservation = {
      active: false,
      duplicateBeforeAcquisition: false,
      strictAcquisitionCalls: 0,
      physicalFillCalls: 0,
      physicalFillArgumentWasExpected: false,
      physicalDisposeCalls: 0,
      firstCalls: 0,
      lastCalls: 0,
      nthCalls: 0,
    };
    let restoreObservation: (() => void) | undefined;
    let session: BrowserSession | undefined;

    await runWithCleanup(async () => {
      restoreObservation = await installProductionOperationObservation(
        fixture.successUrl,
        observation,
      );
      const target: TargetDefinition = {
        baseUrl: fixture.successUrl,
        browser: 'chromium',
      };
      const policy: SecretSinkPolicy = {
        secretRef: 'secrets.contractPassword',
        allowedOrigins: [new URL(fixture.successUrl).origin],
        source: 'base-url-default',
      };
      session = await createChromiumBrowserDriver().launch(target);
      await session.perform({ type: 'navigate', url: fixture.successUrl });
      const firstFingerprint = fingerprintFor(
        (await session.snapshotForResolution()).accessibilityTree,
        SECRET_INPUT,
      );
      const firstBoundInput = await bind(session, SECRET_INPUT, firstFingerprint);

      observation.active = true;
      const hostConsole = observeHostConsoleSilence();
      try {
        await session.fillSecret(firstBoundInput, MATERIALIZED_SECRET, policy);
      } finally {
        observation.active = false;
        try {
          hostConsole.expectNoCalls();
        } finally {
          hostConsole.restore();
        }
      }

      expect({
        firstCalls: observation.firstCalls,
        lastCalls: observation.lastCalls,
        nthCalls: observation.nthCalls,
        physicalDisposeCalls: observation.physicalDisposeCalls,
        physicalFillArgumentWasExpected: observation.physicalFillArgumentWasExpected,
        physicalFillCalls: observation.physicalFillCalls,
        strictAcquisitionCalls: observation.strictAcquisitionCalls,
      }).toEqual({
        firstCalls: 0,
        lastCalls: 0,
        nthCalls: 0,
        physicalDisposeCalls: 1,
        physicalFillArgumentWasExpected: true,
        physicalFillCalls: 1,
        strictAcquisitionCalls: 1,
      });

      await session.perform({ type: 'navigate', url: fixture.successUrl });
      const secondFingerprint = fingerprintFor(
        (await session.snapshotForResolution()).accessibilityTree,
        SECRET_INPUT,
      );
      const secondBoundInput = await bind(session, SECRET_INPUT, secondFingerprint);
      observation.duplicateBeforeAcquisition = true;
      observation.active = true;
      let strictAcquisitionError: unknown;
      try {
        strictAcquisitionError = await session.fillSecret(
          secondBoundInput,
          MATERIALIZED_SECRET,
          policy,
        ).then(() => undefined, (error: unknown) => error);
      } finally {
        observation.active = false;
      }

      expect(String(strictAcquisitionError)).toContain('strict mode violation');
      expect({
        duplicateWasInserted: !observation.duplicateBeforeAcquisition,
        errorIsSecretFree: !safelySerializeErrorSurface(strictAcquisitionError).includes(MATERIALIZED_SECRET),
        firstCalls: observation.firstCalls,
        lastCalls: observation.lastCalls,
        nthCalls: observation.nthCalls,
        physicalDisposeCalls: observation.physicalDisposeCalls,
        physicalFillCalls: observation.physicalFillCalls,
        productionRejected: strictAcquisitionError instanceof Error,
        strictAcquisitionCalls: observation.strictAcquisitionCalls,
      }).toEqual({
        duplicateWasInserted: true,
        errorIsSecretFree: true,
        firstCalls: 0,
        lastCalls: 0,
        nthCalls: 0,
        physicalDisposeCalls: 1,
        physicalFillCalls: 1,
        productionRejected: true,
        strictAcquisitionCalls: 2,
      });
    }, [
      () => {
        observation.active = false;
        restoreObservation?.();
      },
      () => session?.close(),
      () => fixture.close(),
    ]);
  });

  it('uses one production-edge acquisition, physical fill, and disposal on success', async () => {
    const fixture = await createSecretRaceFixture();
    const observation: MutableOperationObservation = {
      ariaSnapshotCalls: 0,
      roleLocatorCalls: 0,
      finalOperationCalls: 0,
      strictAcquisitionCalls: 0,
      physicalFillCalls: 0,
      physicalDisposeCalls: 0,
    };
    let session: BrowserSession | undefined;

    await runWithCleanup(async () => {
      const target: TargetDefinition = {
        baseUrl: fixture.successUrl,
        browser: 'chromium',
      };
      const policy: SecretSinkPolicy = {
        secretRef: 'secrets.contractPassword',
        allowedOrigins: [new URL(fixture.successUrl).origin],
        source: 'base-url-default',
      };
      session = await createChromiumBrowserDriver({
        launcher: createObservedLauncher(observation),
      }).launch(target);
      await session.perform({ type: 'navigate', url: fixture.successUrl });
      const fingerprint = fingerprintFor(
        (await session.snapshotForResolution()).accessibilityTree,
        SECRET_INPUT,
      );
      const boundInput = await bind(session, SECRET_INPUT, fingerprint);

      await session.fillSecret(boundInput, MATERIALIZED_SECRET, policy);

      expect({
        physicalDisposeCalls: observation.physicalDisposeCalls,
        physicalFillCalls: observation.physicalFillCalls,
        strictAcquisitionCalls: observation.strictAcquisitionCalls,
      }).toEqual({
        physicalDisposeCalls: 1,
        physicalFillCalls: 1,
        strictAcquisitionCalls: 1,
      });
    }, [
      () => session?.close(),
      () => fixture.close(),
    ]);
  });

  it('does not let a Locator navigation retry fill the same-named input on a disallowed origin', async () => {
    const fixture = await createSecretRaceFixture();
    let rawBrowser: PlaywrightBrowser | undefined;
    let session: BrowserSession | undefined;

    await runWithCleanup(async () => {
      rawBrowser = await chromium.launch();
      const rawContext = await rawBrowser.newContext();
      const rawPage = await rawContext.newPage();
      await rawPage.goto(fixture.allowedUrl);

      const vulnerableLocator = rawPage.getByRole('textbox', {
        name: SECRET_INPUT.name,
        exact: true,
      });
      await fixture.armNavigation(1);
      const vulnerableFill = vulnerableLocator.fill(MATERIALIZED_SECRET);
      await fixture.awaitFillTriggered(1);
      await vulnerableFill;
      await fixture.awaitDestinationCommit(1);
      await rawPage.waitForURL(fixture.disallowedUrl);
      expect(await vulnerableLocator.inputValue()).toBe(MATERIALIZED_SECRET);

      await rawBrowser.close();
      rawBrowser = undefined;

      const target: TargetDefinition = {
        baseUrl: fixture.allowedUrl,
        browser: 'chromium',
      };
      const policy: SecretSinkPolicy = {
        secretRef: 'secrets.contractPassword',
        allowedOrigins: [new URL(fixture.allowedUrl).origin],
        source: 'base-url-default',
      };
      session = await createChromiumBrowserDriver().launch(target);
      await session.perform({ type: 'navigate', url: fixture.allowedUrl });
      const fingerprint = fingerprintFor(
        (await session.snapshotForResolution()).accessibilityTree,
        SECRET_INPUT,
      );
      const boundInput = await bind(session, SECRET_INPUT, fingerprint);

      await fixture.armNavigation(2);
      const hostConsole = observeHostConsoleSilence();
      let productionError: unknown;
      try {
        const productionFill = session.fillSecret(boundInput, MATERIALIZED_SECRET, policy)
          .then(() => undefined, (error: unknown) => error);
        await fixture.awaitFillTriggered(2);
        productionError = await productionFill;
      } finally {
        try {
          hostConsole.expectNoCalls();
        } finally {
          hostConsole.restore();
        }
      }
      await fixture.awaitDestinationCommit(2);
      const destinationState = await session.evaluateAssert({
        check: 'text-visible',
        text: 'Destination empty',
      });
      expect({
        destinationEmpty: destinationState.passed,
        productionErrorOwnSurfaceIsSecretFree: !safelySerializeErrorSurface(productionError).includes(MATERIALIZED_SECRET),
        productionErrorStringIsSecretFree: !String(productionError).includes(MATERIALIZED_SECRET),
        productionRejected: productionError instanceof Error,
      }).toEqual({
        destinationEmpty: true,
        productionErrorOwnSurfaceIsSecretFree: true,
        productionErrorStringIsSecretFree: true,
        productionRejected: true,
      });
    }, [
      () => session?.close(),
      () => rawBrowser?.close(),
      () => fixture.close(),
    ]);
  });
});
