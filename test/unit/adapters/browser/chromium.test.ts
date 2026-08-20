import { describe, expect, it, vi } from 'vitest';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { parseAriaSnapshot } from '#core/ir/aria-snapshot.js';
import { computeAccessibilityFingerprint } from '#core/ir/fingerprint.js';
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';
import type {
  ElementRef,
  Fingerprint,
  JsonValueT,
  TargetDefinition,
} from '#core/ir/schema.js';
import type {
  AssertCheck,
  BoundElement,
  BrowserSession,
  GroundingQuery,
} from '../../../../src/ports/browser.js';
import {
  createChromiumBrowserDriver,
  type PlaywrightBrowserHandle,
  type PlaywrightContextHandle,
  type PlaywrightLauncher,
  type PlaywrightLocatorHandle,
  type PlaywrightPageHandle,
} from '../../../../src/adapters/browser/chromium.js';
import { captureRejection } from '../../../doubles/capture-rejection.js';
import { expectSecretSinkOriginViolation } from '../../../doubles/expect-secret-sink-origin-violation.js';
import { registerBrowserDriverContract } from '../../../contracts/browser-driver.contract.js';
import {
  registerBrowserSessionContract,
  type BrowserSessionContractSetup,
} from '../../../contracts/browser-session.contract.js';

const TARGET = {
  baseUrl: 'https://example.test',
  browser: 'chromium',
} as const satisfies TargetDefinition;

const SUBMIT_BUTTON: ElementRef = {
  strategy: 'accessibility',
  role: 'button',
  name: 'Submit',
};

const ALLOWED_POLICY: SecretSinkPolicy = {
  secretRef: '{{secrets.password}}',
  allowedOrigins: [new URL(TARGET.baseUrl).origin],
  source: 'base-url-default',
};

const FIXTURE_ARIA_SNAPSHOT = [
  '- main "Application":',
  '  - form "Sign in":',
  '    - textbox "Email"',
  '    - button "Submit"',
].join('\n');

const FIXTURE_WITHOUT_SUBMIT = [
  '- main "Application":',
  '  - form "Sign in":',
  '    - textbox "Email"',
].join('\n');

const AMBIGUOUS_SUBMIT_FIXTURE = [
  '- main "Application":',
  '  - form "Primary form":',
  '    - textbox "Email"',
  '    - button "Submit"',
  '  - region "Secondary controls":',
  '    - textbox "Search"',
  '    - button "Submit"',
].join('\n');

const FIRST_AMBIGUOUS_SUBMIT_CANDIDATE_FIXTURE = [
  '- main "Application":',
  '  - form "Primary form":',
  '    - textbox "Email"',
  '    - button "Submit"',
].join('\n');

const FIXTURE_ACCESSIBILITY_TREE: JsonValueT = {
  role: 'root',
  name: '',
  children: [{
    role: 'main',
    name: 'Application',
    children: [{
      role: 'form',
      name: 'Sign in',
      children: [
        { role: 'textbox', name: 'Email', children: [] },
        { role: 'button', name: 'Submit', children: [] },
      ],
    }],
  }],
};

const FIXTURE_SCREENSHOT = new Uint8Array([80, 78, 71]);
const MATERIALIZED_SECRET = 'correct-horse-battery-staple';

const CHANGED_SUBMIT_FIXTURE = [
  '- main "Application":',
  '  - form "Sign in":',
  '    - textbox "Email"',
  '    - button "Submit"',
  '    - text: Changed',
].join('\n');

const DISCARDED_SCALAR_FIXTURE = '- textbox: "#quoted\\\\backslash"';

const SAME_DESCRIPTOR_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en"><body><button type="button">Submit</button></body></html>`)}`;

interface FakeLocatorOptions {
  readonly visible?: boolean;
  readonly text?: string;
  readonly value?: string;
  readonly count?: number;
  readonly ariaSnapshot?: string;
}

class FakePlaywrightElementHandle {
  fillFailure: Error | undefined;
  fillOverride: (() => Promise<void>) | undefined;
  disposeFailure: Error | undefined;
  readonly fillValues: string[] = [];
  readonly disposeCalls: undefined[] = [];

  constructor(
    readonly identity: string,
    private readonly operationLog: string[],
  ) {}

  async fill(value: string): Promise<void> {
    this.operationLog.push(`element:${this.identity}.fill`);
    this.fillValues.push(value);
    if (this.fillFailure !== undefined) {
      throw this.fillFailure;
    }
    if (this.fillOverride !== undefined) {
      await this.fillOverride();
    }
  }

  async dispose(): Promise<void> {
    this.operationLog.push(`element:${this.identity}.dispose`);
    this.disposeCalls.push(undefined);
    if (this.disposeFailure !== undefined) {
      throw this.disposeFailure;
    }
  }
}

class FakePlaywrightLocator implements PlaywrightLocatorHandle {
  visible: boolean;
  text: string;
  value: string;
  resultCount: number;
  ariaSnapshotText: string;
  clickFailure: Error | undefined;
  fillFailure: Error | undefined;
  pressFailure: Error | undefined;
  readonly clickCalls: undefined[] = [];
  readonly fillValues: string[] = [];
  readonly firstCalls: undefined[] = [];
  readonly innerTextCalls: undefined[] = [];
  readonly isVisibleCalls: undefined[] = [];
  readonly inputValueCalls: undefined[] = [];
  readonly countCalls: undefined[] = [];
  readonly ariaSnapshotCalls: undefined[] = [];
  readonly elementHandleCalls: undefined[] = [];
  readonly acquiredElementHandles: FakePlaywrightElementHandle[] = [];
  readonly pressedKeys: string[] = [];
  ariaSnapshotOverride: (() => Promise<string>) | undefined;
  elementHandleOverride: (() => Promise<FakePlaywrightElementHandle>) | undefined;
  operationLabel = 'locator';
  operationLog: string[] = [];
  private nextElementIdentity = 1;

  constructor(options: FakeLocatorOptions = {}) {
    this.visible = options.visible ?? true;
    this.text = options.text ?? 'Submit';
    this.value = options.value ?? 'submit-value';
    this.resultCount = options.count ?? 1;
    this.ariaSnapshotText = options.ariaSnapshot ?? '';
  }

  first(): PlaywrightLocatorHandle {
    this.firstCalls.push(undefined);
    return this;
  }

  async click(): Promise<void> {
    this.clickCalls.push(undefined);
    if (this.clickFailure !== undefined) {
      throw this.clickFailure;
    }
  }

  async fill(value: string): Promise<void> {
    this.operationLog.push(`${this.operationLabel}.fill`);
    this.fillValues.push(value);
    if (this.fillFailure !== undefined) {
      throw this.fillFailure;
    }
  }

  async press(key: string): Promise<void> {
    this.pressedKeys.push(key);
    if (this.pressFailure !== undefined) {
      throw this.pressFailure;
    }
  }

  async innerText(): Promise<string> {
    this.innerTextCalls.push(undefined);
    return this.text;
  }

  async isVisible(): Promise<boolean> {
    this.isVisibleCalls.push(undefined);
    return this.visible;
  }

  async inputValue(): Promise<string> {
    this.inputValueCalls.push(undefined);
    return this.value;
  }

  async count(): Promise<number> {
    this.countCalls.push(undefined);
    return this.resultCount;
  }

  async ariaSnapshot(): Promise<string> {
    this.operationLog.push(`${this.operationLabel}.ariaSnapshot`);
    this.ariaSnapshotCalls.push(undefined);
    if (this.ariaSnapshotOverride !== undefined) {
      return this.ariaSnapshotOverride();
    }
    return this.ariaSnapshotText;
  }

  async elementHandle(): Promise<FakePlaywrightElementHandle> {
    this.operationLog.push(`${this.operationLabel}.elementHandle`);
    this.elementHandleCalls.push(undefined);
    const element = this.elementHandleOverride === undefined
      ? new FakePlaywrightElementHandle(String(this.nextElementIdentity++), this.operationLog)
      : await this.elementHandleOverride();
    this.acquiredElementHandles.push(element);
    return element;
  }
}

interface FakePlaywrightOptions {
  readonly ariaSnapshot?: string;
  readonly currentUrl?: string;
  readonly screenshot?: Uint8Array;
  readonly roleLocator?: FakePlaywrightLocator;
  readonly textLocator?: FakePlaywrightLocator;
}

class FakePlaywrightPage implements PlaywrightPageHandle {
  currentUrl: string;
  private generation = 0;
  gotoFailure: Error | undefined;
  readonly gotoUrls: string[] = [];
  readonly roleCalls: {
    readonly role: string;
    readonly options: { readonly name: string; readonly exact: true };
  }[] = [];
  readonly textCalls: {
    readonly text: string;
    readonly options: { readonly exact: true } | undefined;
  }[] = [];
  readonly locatorCalls: string[] = [];
  readonly urlCalls: undefined[] = [];
  readonly screenshotCalls: undefined[] = [];
  readonly operationLog: string[] = [];
  readonly roleLocator: FakePlaywrightLocator;
  readonly textLocator: FakePlaywrightLocator;
  readonly bodyLocator: FakePlaywrightLocator;
  readonly screenshotBytes: Uint8Array;

  constructor(options: FakePlaywrightOptions) {
    this.currentUrl = options.currentUrl ?? TARGET.baseUrl;
    this.roleLocator = options.roleLocator ?? new FakePlaywrightLocator();
    this.textLocator = options.textLocator ?? new FakePlaywrightLocator();
    this.bodyLocator = new FakePlaywrightLocator({ ariaSnapshot: options.ariaSnapshot ?? FIXTURE_ARIA_SNAPSHOT });
    this.roleLocator.operationLabel = 'roleLocator';
    this.roleLocator.operationLog = this.operationLog;
    this.textLocator.operationLabel = 'textLocator';
    this.textLocator.operationLog = this.operationLog;
    this.bodyLocator.operationLabel = 'bodyLocator';
    this.bodyLocator.operationLog = this.operationLog;
    this.screenshotBytes = options.screenshot ?? FIXTURE_SCREENSHOT;
  }

  async goto(url: string): Promise<unknown> {
    this.gotoUrls.push(url);
    if (this.gotoFailure !== undefined) {
      throw this.gotoFailure;
    }

    this.generation += 1;
    this.currentUrl = new URL(url, TARGET.baseUrl).toString();
    return undefined;
  }

  navigationGeneration(): number {
    this.operationLog.push('page.navigationGeneration');
    return this.generation;
  }

  simulateMainFrameNavigation(): void {
    this.generation += 1;
  }

  simulateSubframeNavigation(): void {
    // Subframe navigation intentionally does not alter the main-frame
    // generation surfaced through the adapter seam.
  }

  simulateSameDocumentNavigation(): void {
    this.generation += 1;
  }

  getByRole(
    role: string,
    options: { readonly name: string; readonly exact: true },
  ): PlaywrightLocatorHandle {
    this.operationLog.push('page.getByRole');
    this.roleCalls.push({ role, options });
    return this.roleLocator;
  }

  getByText(
    text: string,
    options?: { readonly exact: true },
  ): PlaywrightLocatorHandle {
    this.textCalls.push({ text, options });
    return this.textLocator;
  }

  locator(selector: string): PlaywrightLocatorHandle {
    this.operationLog.push(`page.locator:${selector}`);
    this.locatorCalls.push(selector);
    return selector === 'body' ? this.bodyLocator : this.textLocator;
  }

  url(): string {
    this.operationLog.push('page.url');
    this.urlCalls.push(undefined);
    return this.currentUrl;
  }

  async screenshot(): Promise<Uint8Array> {
    this.screenshotCalls.push(undefined);
    return this.screenshotBytes;
  }
}

class FakePlaywrightContext implements PlaywrightContextHandle {
  closeFailure: Error | undefined;
  readonly newPageCalls: undefined[] = [];
  readonly closeCalls: undefined[] = [];

  constructor(readonly page: FakePlaywrightPage) {}

  async newPage(): Promise<PlaywrightPageHandle> {
    this.newPageCalls.push(undefined);
    return this.page;
  }

  async close(): Promise<void> {
    this.closeCalls.push(undefined);
    if (this.closeFailure !== undefined) {
      throw this.closeFailure;
    }
  }
}

class FakePlaywrightBrowser implements PlaywrightBrowserHandle {
  closeFailure: Error | undefined;
  readonly newContextOptions: { readonly baseURL: string }[] = [];
  readonly closeCalls: undefined[] = [];

  constructor(readonly context: FakePlaywrightContext) {}

  async newContext(options: { readonly baseURL: string }): Promise<PlaywrightContextHandle> {
    this.newContextOptions.push(options);
    return this.context;
  }

  async close(): Promise<void> {
    this.closeCalls.push(undefined);
    if (this.closeFailure !== undefined) {
      throw this.closeFailure;
    }
  }
}

class FakePlaywrightLauncher implements PlaywrightLauncher {
  launchFailure: Error | undefined;
  readonly launchOptions: { readonly headless: boolean }[] = [];
  readonly page: FakePlaywrightPage;
  readonly context: FakePlaywrightContext;
  readonly browser: FakePlaywrightBrowser;

  constructor(options: FakePlaywrightOptions = {}) {
    this.page = new FakePlaywrightPage(options);
    this.context = new FakePlaywrightContext(this.page);
    this.browser = new FakePlaywrightBrowser(this.context);
  }

  async launch(options: { readonly headless: boolean }): Promise<PlaywrightBrowserHandle> {
    this.launchOptions.push(options);
    if (this.launchFailure !== undefined) {
      throw this.launchFailure;
    }

    return this.browser;
  }
}

function fingerprintForSnapshot(snapshot: string): Fingerprint {
  // Deliberately derive the contract value through the production parser and
  // fingerprint algorithm from the same snapshot scripted into fake
  // Playwright. resolveGrounded() independently performs that work, so a hit
  // proves both paths agree; this fixture intentionally is not independent of
  // the core algorithm.
  const fingerprint = computeAccessibilityFingerprint(
    parseAriaSnapshot(snapshot),
    SUBMIT_BUTTON,
    [],
  );

  if (fingerprint.kind !== 'ok') {
    throw new Error('The fixture ARIA snapshot does not contain the submit button.');
  }

  return fingerprint.fingerprint;
}

function fixtureFingerprint(): Fingerprint {
  return fingerprintForSnapshot(FIXTURE_ARIA_SNAPSHOT);
}

function firstAmbiguousCandidateFingerprint(): Fingerprint {
  const fingerprint = computeAccessibilityFingerprint(
    parseAriaSnapshot(FIRST_AMBIGUOUS_SUBMIT_CANDIDATE_FIXTURE),
    SUBMIT_BUTTON,
    [],
  );

  if (fingerprint.kind !== 'ok') {
    throw new Error('The separate ambiguous fixture does not contain its first submit candidate.');
  }

  return fingerprint.fingerprint;
}

async function launchSession(
  launcher: FakePlaywrightLauncher,
  headed?: boolean,
): Promise<BrowserSession> {
  const options = headed === undefined ? { launcher } : { launcher, headed };
  return createChromiumBrowserDriver(options).launch(TARGET);
}

async function withLaunchedSession(
  launcherOptions: FakePlaywrightOptions,
  assertion: (session: BrowserSession, launcher: FakePlaywrightLauncher) => Promise<void>,
): Promise<void> {
  const launcher = new FakePlaywrightLauncher(launcherOptions);
  let session: BrowserSession | undefined;

  try {
    session = await launchSession(launcher);
    await assertion(session, launcher);
  } finally {
    await session?.close();
  }
}

function expectExactSubmitLookup(launcher: FakePlaywrightLauncher): void {
  expect(launcher.page.roleCalls).toEqual([{
    role: 'button',
    options: { name: 'Submit', exact: true },
  }]);
  expect(launcher.page.roleLocator.firstCalls).toHaveLength(0);
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve(value): void {
      if (resolve === undefined) {
        throw new Error('The deferred promise resolver was not initialized.');
      }
      resolve(value);
    },
  };
}

function captureConsoleOutput() {
  const spies = [
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ];

  return {
    expectSecretFree(error: unknown, additionalForbidden: readonly string[] = []): void {
      const errorText = `${String(error)} ${JSON.stringify(error)}`;
      for (const forbidden of [MATERIALIZED_SECRET, ...additionalForbidden]) {
        expect(errorText).not.toContain(forbidden);
        expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(forbidden);
      }
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
    },
    restore(): void {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

const VERIFY_SUBMIT: GroundingQuery = { mode: 'verify', fingerprint: fixtureFingerprint() };

async function bindSubmit(session: BrowserSession, query: GroundingQuery = VERIFY_SUBMIT): Promise<BoundElement> {
  const result = await session.resolveGrounded(SUBMIT_BUTTON, query);
  if (result.kind === 'miss') {
    throw new Error(`The submit fixture unexpectedly failed to bind: ${result.reason}`);
  }

  return result.element;
}

registerBrowserDriverContract({
  createDriver: () => createChromiumBrowserDriver({ launcher: new FakePlaywrightLauncher() }),
});

const chromiumContractLaunchers = new WeakMap<BrowserSession, FakePlaywrightLauncher>();

registerBrowserSessionContract({
  createSession: async (setup) => {
    const launcher = new FakePlaywrightLauncher({
      ariaSnapshot: setup.scenario === 'snapshot-invalid'
        ? 'not an ARIA outline'
        : setup.scenario === 'ambiguous'
          ? AMBIGUOUS_SUBMIT_FIXTURE
          : setup.exists ? FIXTURE_ARIA_SNAPSHOT : FIXTURE_WITHOUT_SUBMIT,
    });
    const session = await launchSession(launcher);
    chromiumContractLaunchers.set(session, launcher);
    return session;
  },
  navigationUrl: () => SAME_DESCRIPTOR_PAGE,
  actualFingerprintFor: (_session: BrowserSession, _setup: BrowserSessionContractSetup) => fixtureFingerprint(),
  supportedGroundingMissReasons: [
    'fingerprint-mismatch',
    'element-not-found',
    'ambiguous-match',
    'snapshot-invalid',
    'secret-contaminated',
  ],
  operationObservation: (session) => {
    const launcher = chromiumContractLaunchers.get(session);
    if (launcher === undefined) {
      throw new Error('The Chromium contract session must retain its launcher observations.');
    }

    const locator = launcher.page.roleLocator;
    return {
      ariaSnapshotCalls: launcher.page.bodyLocator.ariaSnapshotCalls.length,
      roleLocatorCalls: launcher.page.roleCalls.length,
      finalOperationCalls: locator.clickCalls.length
        + locator.fillValues.length
        + locator.pressedKeys.length
        + locator.innerTextCalls.length
        + locator.isVisibleCalls.length
        + locator.inputValueCalls.length,
    };
  },
});

describe('createChromiumBrowserDriver()', () => {
  it('declares Chromium as its browser engine', () => {
    const driver = createChromiumBrowserDriver({ launcher: new FakePlaywrightLauncher() });

    expect(driver.engine).toBe('chromium');
  });

  it.each([
    ['when headed is true', true, false],
    ['when headed is false', false, true],
    ['when headed is omitted', undefined, true],
  ] as const)('passes headless %s', async (_description, headed, expectedHeadless) => {
    const launcher = new FakePlaywrightLauncher();
    let session: BrowserSession | undefined;

    try {
      session = await launchSession(launcher, headed);

      expect(launcher.launchOptions).toEqual([{ headless: expectedHeadless }]);
    } finally {
      await session?.close();
    }
  });

  it('passes the target base URL to the context creation call', async () => {
    await withLaunchedSession({}, async (_session, launcher) => {
      expect(launcher.browser.newContextOptions).toEqual([{ baseURL: TARGET.baseUrl }]);
      expect(launcher.context.newPageCalls).toHaveLength(1);
    });
  });

  it('does not navigate while launching a session', async () => {
    await withLaunchedSession({}, async (_session, launcher) => {
      expect(launcher.page.gotoUrls).toEqual([]);
    });
  });

  it('propagates a launcher startup rejection unchanged', async () => {
    const launcher = new FakePlaywrightLauncher();
    const failure = new Error('Chromium could not start');
    launcher.launchFailure = failure;

    await expect(createChromiumBrowserDriver({ launcher }).launch(TARGET)).rejects.toBe(failure);
    expect(launcher.launchOptions).toEqual([{ headless: true }]);
  });
});

describe('ChromiumBrowserSession.perform()', () => {
  it('maps click to a direct exact accessibility role locator without positional narrowing', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      await expect(session.perform({ type: 'click', target })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.clickCalls).toHaveLength(1);
    });
  });

  it.each([
    ['a relative URL', '/sign-in'],
    ['an absolute URL', 'https://other.example.test/sign-in'],
  ] as const)('passes %s through to Playwright goto without joining it', async (_description, url) => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.perform({ type: 'navigate', url })).resolves.toBeUndefined();

      expect(launcher.page.gotoUrls).toEqual([url]);
    });
  });

  it('maps press to a direct exact accessibility role locator without positional narrowing', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      await expect(session.perform({ type: 'press', target, key: 'Enter' })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.pressedKeys).toEqual(['Enter']);
    });
  });

  it('maps fill to a direct exact accessibility role locator without positional narrowing', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      await expect(session.perform({ type: 'fill', target, value: 'visible text' })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.fillValues).toEqual(['visible text']);
    });
  });

  it('propagates a Playwright action failure without reclassifying it', async () => {
    const failure = new Error('navigation failed');

    await withLaunchedSession({}, async (session, launcher) => {
      launcher.page.gotoFailure = failure;

      await expect(session.perform({ type: 'navigate', url: '/unreachable' })).rejects.toBe(failure);
    });
  });

});

describe('ChromiumBrowserSession.fillSecret()', () => {
  it('acquires one physical element and fills that exact object immediately after the final origin check', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const pinned = new FakePlaywrightElementHandle('pinned', launcher.page.operationLog);
      const laterReplacement = new FakePlaywrightElementHandle('replacement', launcher.page.operationLog);
      let acquisitionCount = 0;
      launcher.page.roleLocator.elementHandleOverride = async () => (
        acquisitionCount++ === 0 ? pinned : laterReplacement
      );
      launcher.page.operationLog.length = 0;

      await expect(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
      expect(pinned.fillValues).toEqual([MATERIALIZED_SECRET]);
      expect(laterReplacement.fillValues).toEqual([]);
      expect(pinned.disposeCalls).toHaveLength(1);
      expect(launcher.page.operationLog).toEqual([
        'page.url',
        'page.navigationGeneration',
        'page.locator:body',
        'bodyLocator.ariaSnapshot',
        'page.navigationGeneration',
        'page.getByRole',
        'roleLocator.elementHandle',
        'page.navigationGeneration',
        'page.url',
        'element:pinned.fill',
        'element:pinned.dispose',
      ]);
    });
  });

  it('disposes the physical element only after its pending fill settles', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const fillSettlement = deferred<void>();
      const pinned = new FakePlaywrightElementHandle('pending-fill', launcher.page.operationLog);
      pinned.fillOverride = () => fillSettlement.promise;
      launcher.page.roleLocator.elementHandleOverride = async () => pinned;

      const operation = session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY);

      await vi.waitFor(() => {
        expect(pinned.fillValues).toEqual([MATERIALIZED_SECRET]);
      });
      expect(pinned.disposeCalls).toHaveLength(0);

      fillSettlement.resolve(undefined);

      await expect(operation).resolves.toBeUndefined();
      expect(pinned.disposeCalls).toHaveLength(1);
    });
  });

  it('does not log a resolved secret when a permitted fill succeeds', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    try {
      await withLaunchedSession({}, async (session) => {
        const target = await bindSubmit(session);
        await expect(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)).resolves.toBeUndefined();

        for (const spy of consoleSpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });

  it('propagates a detached physical-element fill rejection without reacquiring or leaking the secret', async () => {
    const failure = new Error('input is detached');
    const cleanupSentinel = 'dispose browser sentinel';
    const consoleCapture = captureConsoleOutput();

    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const pinned = new FakePlaywrightElementHandle('detached', launcher.page.operationLog);
        pinned.fillFailure = failure;
        pinned.disposeFailure = new Error(cleanupSentinel);
        launcher.page.roleLocator.elementHandleOverride = async () => pinned;

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expect(thrown).toBe(failure);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(pinned.fillValues).toEqual([MATERIALIZED_SECRET]);
        expect(pinned.disposeCalls).toHaveLength(1);
        consoleCapture.expectSecretFree(thrown, [cleanupSentinel]);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('preserves a fixed-target fill rejection when its invocation changes the live origin', async () => {
    const failure = new Error('fixed target fill failed');
    const consoleCapture = captureConsoleOutput();

    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const pinned = new FakePlaywrightElementHandle('origin-changing-fill', launcher.page.operationLog);
        pinned.fillOverride = async () => {
          launcher.page.currentUrl = 'https://idp.example.test/login';
          launcher.page.operationLog.push('element:origin-changing-fill.rejected');
          throw failure;
        };
        launcher.page.roleLocator.elementHandleOverride = async () => pinned;

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expect(thrown).toBe(failure);
        expect(thrown).not.toBeInstanceOf(IntegrityViolationError);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.acquiredElementHandles).toEqual([pinned]);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(pinned.fillValues).toEqual([MATERIALIZED_SECRET]);
        expect(pinned.disposeCalls).toHaveLength(1);

        const fillInvocation = launcher.page.operationLog.indexOf('element:origin-changing-fill.fill');
        expect(fillInvocation).toBeGreaterThanOrEqual(0);
        expect(launcher.page.operationLog.slice(fillInvocation)).toEqual([
          'element:origin-changing-fill.fill',
          'element:origin-changing-fill.rejected',
          'element:origin-changing-fill.dispose',
        ]);
        consoleCapture.expectSecretFree(thrown);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it.each([
    ['zero matches', new Error('strict element acquisition found no matching element')],
    ['multiple matches', new Error('strict element acquisition found multiple matching elements')],
  ] as const)('propagates a %s acquisition rejection without filling or retrying', async (_scenario, failure) => {
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        launcher.page.roleLocator.elementHandleOverride = async () => {
          throw failure;
        };

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expect(thrown).toBe(failure);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.acquiredElementHandles).toEqual([]);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        consoleCapture.expectSecretFree(thrown);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('rejects a disallowed current origin before acquiring a physical element', async () => {
    await withLaunchedSession({ currentUrl: 'https://idp.example.test/login' }, async (session, launcher) => {
      const target = await bindSubmit(session);

      expectSecretSinkOriginViolation(
        await captureRejection(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)),
        ALLOWED_POLICY,
      );
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects a fabricated bound element before any locator work', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const fabricated: BoundElement = { ref: SUBMIT_BUTTON, fingerprint: fixtureFingerprint() };

      await expect(session.fillSecret(fabricated, MATERIALIZED_SECRET, ALLOWED_POLICY)).rejects.toThrow('provenance');
      expect(launcher.page.roleCalls).toEqual([]);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects a bound element after same-origin navigation', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      await session.perform({ type: 'navigate', url: '/still-example' });

      await expect(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)).rejects.toThrow('navigation');
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects a bound element whose descriptor changes without navigation', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      launcher.page.bodyLocator.ariaSnapshotText = CHANGED_SUBMIT_FIXTURE;

      let thrown: unknown;
      try {
        await session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY);
      } catch (error) {
        thrown = error;
      }

      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain('fingerprint');
      expect(thrown).not.toBeInstanceOf(IntegrityViolationError);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects a synthetic post-bind origin race before invoking fill', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      launcher.page.currentUrl = 'https://idp.example.test/login';

      expectSecretSinkOriginViolation(
        await captureRejection(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)),
        ALLOWED_POLICY,
      );
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('classifies a real cross-origin navigation race as an origin violation before stale-binding rejection', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      await session.perform({ type: 'navigate', url: 'https://idp.example.test/login' });

      expectSecretSinkOriginViolation(
        await captureRejection(session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY)),
        ALLOWED_POLICY,
      );
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects an origin change that lands during re-verification capture before invoking fill', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const snapshot = deferred<string>();
      const captureStarted = deferred<void>();
      launcher.page.bodyLocator.ariaSnapshotOverride = () => {
        captureStarted.resolve(undefined);
        return snapshot.promise;
      };
      const operation = session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY);
      await captureStarted.promise;
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      launcher.page.currentUrl = 'https://idp.example.test/login';
      snapshot.resolve(FIXTURE_ARIA_SNAPSHOT);

      expectSecretSinkOriginViolation(await captureRejection(operation), ALLOWED_POLICY);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
      const [acquired] = launcher.page.roleLocator.acquiredElementHandles;
      expect(acquired).toBeDefined();
      expect(acquired?.fillValues).toEqual([]);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
      expect(acquired?.disposeCalls).toHaveLength(1);
    });
  });

  it('reclassifies a continuity failure as an origin violation when the origin goes bad during capture', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const snapshot = deferred<string>();
      const captureStarted = deferred<void>();
      launcher.page.bodyLocator.ariaSnapshotOverride = () => {
        captureStarted.resolve(undefined);
        return snapshot.promise;
      };
      const operation = session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY);
      await captureStarted.promise;
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      launcher.page.currentUrl = 'https://idp.example.test/login';
      snapshot.resolve(CHANGED_SUBMIT_FIXTURE);

      expectSecretSinkOriginViolation(await captureRejection(operation), ALLOWED_POLICY);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(0);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
    });
  });

  it('rejects and disposes an acquired element when acquisition crosses an allowed-origin navigation', async () => {
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const acquired = new FakePlaywrightElementHandle('allowed-navigation', launcher.page.operationLog);
        launcher.page.roleLocator.elementHandleOverride = async () => {
          launcher.page.simulateMainFrameNavigation();
          launcher.page.currentUrl = 'https://example.test/replaced';
          return acquired;
        };

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(IntegrityViolationError);
        expect(thrown instanceof Error ? thrown.message : '').toContain('navigation');
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(acquired.fillValues).toEqual([]);
        expect(acquired.disposeCalls).toHaveLength(1);
        consoleCapture.expectSecretFree(thrown);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('reclassifies a rejecting acquisition after disallowed-origin navigation without retrying', async () => {
    const acquisitionFailure = new Error('strict acquisition was interrupted by navigation');
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        launcher.page.roleLocator.elementHandleOverride = async () => {
          launcher.page.simulateMainFrameNavigation();
          launcher.page.currentUrl = 'https://idp.example.test/login';
          throw acquisitionFailure;
        };

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expectSecretSinkOriginViolation(thrown, ALLOWED_POLICY);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.acquiredElementHandles).toEqual([]);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        consoleCapture.expectSecretFree(thrown);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('preserves integrity precedence and suppresses cleanup text after a disallowed generation swap', async () => {
    const cleanupSentinel = 'classified cleanup browser sentinel';
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const acquired = new FakePlaywrightElementHandle('disallowed-navigation', launcher.page.operationLog);
        acquired.disposeFailure = new Error(cleanupSentinel);
        launcher.page.roleLocator.elementHandleOverride = async () => {
          launcher.page.simulateMainFrameNavigation();
          launcher.page.currentUrl = 'https://idp.example.test/login';
          return acquired;
        };

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expectSecretSinkOriginViolation(thrown, ALLOWED_POLICY);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(acquired.fillValues).toEqual([]);
        expect(acquired.disposeCalls).toHaveLength(1);
        consoleCapture.expectSecretFree(thrown, [cleanupSentinel]);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('rejects the final live origin after acquisition and disposes the unfilled element', async () => {
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const acquired = new FakePlaywrightElementHandle('final-origin', launcher.page.operationLog);
        launcher.page.roleLocator.elementHandleOverride = async () => {
          launcher.page.currentUrl = 'https://idp.example.test/login';
          return acquired;
        };

        const thrown = await captureRejection(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        );

        expectSecretSinkOriginViolation(thrown, ALLOWED_POLICY);
        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(acquired.fillValues).toEqual([]);
        expect(acquired.disposeCalls).toHaveLength(1);
        consoleCapture.expectSecretFree(thrown);
      });
    } finally {
      consoleCapture.restore();
    }
  });

  it('acquires and disposes a fresh physical element for every call on one binding', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const first = new FakePlaywrightElementHandle('first-call', launcher.page.operationLog);
      const second = new FakePlaywrightElementHandle('second-call', launcher.page.operationLog);
      const handles = [first, second];
      launcher.page.roleLocator.elementHandleOverride = async () => {
        const next = handles.shift();
        if (next === undefined) {
          throw new Error('The test supplied too few physical elements.');
        }
        return next;
      };

      await expect(session.fillSecret(target, 'first secret', ALLOWED_POLICY)).resolves.toBeUndefined();
      await expect(session.fillSecret(target, 'second secret', ALLOWED_POLICY)).resolves.toBeUndefined();

      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(3);
      expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(2);
      expect(launcher.page.roleLocator.fillValues).toEqual([]);
      expect(first.fillValues).toEqual(['first secret']);
      expect(second.fillValues).toEqual(['second secret']);
      expect(first.disposeCalls).toHaveLength(1);
      expect(second.disposeCalls).toHaveLength(1);
    });
  });

  it('suppresses a disposal rejection after a successful fixed-target fill', async () => {
    const cleanupSentinel = 'successful cleanup browser sentinel';
    const consoleCapture = captureConsoleOutput();
    try {
      await withLaunchedSession({}, async (session, launcher) => {
        const target = await bindSubmit(session);
        const acquired = new FakePlaywrightElementHandle('cleanup-after-success', launcher.page.operationLog);
        acquired.disposeFailure = new Error(cleanupSentinel);
        launcher.page.roleLocator.elementHandleOverride = async () => acquired;

        await expect(
          session.fillSecret(target, MATERIALIZED_SECRET, ALLOWED_POLICY),
        ).resolves.toBeUndefined();

        expect(launcher.page.roleLocator.elementHandleCalls).toHaveLength(1);
        expect(launcher.page.roleLocator.fillValues).toEqual([]);
        expect(acquired.fillValues).toEqual([MATERIALIZED_SECRET]);
        expect(acquired.disposeCalls).toHaveLength(1);
        consoleCapture.expectSecretFree(undefined, [cleanupSentinel]);
      });
    } finally {
      consoleCapture.restore();
    }
  });
});

describe('ChromiumBrowserSession.currentUrl()', () => {
  it('returns the page current URL', async () => {
    await withLaunchedSession({ currentUrl: 'https://example.test/dashboard' }, async (session, launcher) => {
      await expect(session.currentUrl()).resolves.toBe(launcher.page.currentUrl);
      expect(launcher.page.urlCalls).toHaveLength(1);
    });
  });
});

interface AssertionScenarioBase {
  readonly description: string;
  readonly failureMessage?: string;
  configure(launcher: FakePlaywrightLauncher, expectedPassed: boolean): void;
  assertPlaywright(launcher: FakePlaywrightLauncher): void;
}

type BoundAssertCheck = Extract<AssertCheck, { readonly target: BoundElement }>;
type UnboundAssertCheck = Exclude<AssertCheck, BoundAssertCheck>;

interface BoundAssertionScenario extends AssertionScenarioBase {
  readonly binding: 'bound';
  check(target: BoundElement): BoundAssertCheck;
}

interface UnboundAssertionScenario extends AssertionScenarioBase {
  readonly binding: 'unbound';
  check(): UnboundAssertCheck;
}

type AssertionScenario = BoundAssertionScenario | UnboundAssertionScenario;

const ASSERTION_SCENARIOS: readonly AssertionScenario[] = [
  {
    description: 'text-visible',
    binding: 'unbound',
    check: () => ({ check: 'text-visible', text: 'Welcome' }),
    configure(launcher, expectedPassed): void {
      launcher.page.textLocator.visible = expectedPassed;
    },
    assertPlaywright(launcher): void {
      expect(launcher.page.textCalls).toEqual([{ text: 'Welcome', options: undefined }]);
      expect(launcher.page.locatorCalls).toEqual([]);
      expect(launcher.page.textLocator.isVisibleCalls).toHaveLength(1);
      expect(launcher.page.roleCalls).toEqual([]);
    },
  },
  {
    description: 'element-visible',
    binding: 'bound',
    check: (target) => ({ check: 'element-visible', target }),
    configure(launcher, expectedPassed): void {
      launcher.page.roleLocator.visible = expectedPassed;
    },
    assertPlaywright(launcher): void {
      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.isVisibleCalls).toHaveLength(1);
    },
  },
  {
    description: 'text-equals',
    binding: 'bound',
    check: (target) => ({ check: 'text-equals', target, text: 'Send form' }),
    failureMessage: 'Element text does not equal: Submit; expected "Send form", received "Send later".',
    configure(launcher, expectedPassed): void {
      launcher.page.roleLocator.text = expectedPassed ? 'Send form' : 'Send later';
    },
    assertPlaywright(launcher): void {
      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.innerTextCalls).toHaveLength(1);
    },
  },
  {
    description: 'element-count',
    binding: 'unbound',
    check: () => ({ check: 'element-count', target: SUBMIT_BUTTON, count: 2 }),
    failureMessage: 'Element count does not equal: Submit; expected 2, received 1.',
    configure(launcher, expectedPassed): void {
      launcher.page.roleLocator.resultCount = expectedPassed ? 2 : 1;
    },
    assertPlaywright(launcher): void {
      expect(launcher.page.roleCalls).toEqual([{
        role: 'button',
        options: { name: 'Submit', exact: true },
      }]);
      expect(launcher.page.roleLocator.firstCalls).toEqual([]);
      expect(launcher.page.roleLocator.countCalls).toHaveLength(1);
    },
  },
  {
    description: 'url-matches',
    binding: 'unbound',
    check: () => ({ check: 'url-matches', pattern: '^https://example\\.test/account$' }),
    configure(launcher, expectedPassed): void {
      launcher.page.currentUrl = expectedPassed
        ? 'https://example.test/account'
        : 'https://example.test/preferences';
    },
    assertPlaywright(launcher): void {
      expect(launcher.page.urlCalls).toHaveLength(1);
      expect(launcher.page.roleCalls).toEqual([]);
      expect(launcher.page.locatorCalls).toEqual([]);
    },
  },
];

describe('ChromiumBrowserSession.evaluateAssert()', () => {
  for (const scenario of ASSERTION_SCENARIOS) {
    for (const expectedPassed of [true, false] as const) {
      it(`returns ${expectedPassed ? 'a pass' : 'a failure'} for ${scenario.description}`, async () => {
        await withLaunchedSession({}, async (session, launcher) => {
          scenario.configure(launcher, expectedPassed);
          const check = scenario.binding === 'bound'
            ? scenario.check(await bindSubmit(session))
            : scenario.check();
          const outcome = await session.evaluateAssert(check);

          expect(outcome.passed).toBe(expectedPassed);
          if (!outcome.passed) {
            expect(outcome.message).toBeTypeOf('string');
            if (scenario.failureMessage !== undefined) {
              expect(outcome.message).toBe(scenario.failureMessage);
            }
          }
          scenario.assertPlaywright(launcher);
        });
      });
    }
  }

  it('passes selector-syntax characters to a text locator as literal data', async () => {
    const text = 'Welcome >> "again"';

    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.evaluateAssert({ check: 'text-visible', text })).resolves.toEqual({ passed: true });

      expect(launcher.page.textCalls).toEqual([{ text, options: undefined }]);
      expect(launcher.page.locatorCalls).toEqual([]);
      expect(launcher.page.textLocator.isVisibleCalls).toHaveLength(1);
    });
  });

  it('surfaces malformed url-matches patterns as their original RegExp error', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.evaluateAssert({ check: 'url-matches', pattern: '[' })).rejects.toBeInstanceOf(SyntaxError);

      expect(launcher.page.urlCalls).toEqual([]);
    });
  });
});

describe('ChromiumBrowserSession.captureValue()', () => {
  it.each([
    ['text', 'rendered submit label'],
    ['value', 'submit-control-value'],
  ] as const)('uses the %s capture mapping', async (mode, expectedValue) => {
    await withLaunchedSession({
      roleLocator: new FakePlaywrightLocator({
        text: 'rendered submit label',
        value: 'submit-control-value',
      }),
    }, async (session, launcher) => {
      const target = await bindSubmit(session);
      await expect(session.captureValue(target, mode)).resolves.toBe(expectedValue);

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.innerTextCalls).toHaveLength(mode === 'text' ? 1 : 0);
      expect(launcher.page.roleLocator.inputValueCalls).toHaveLength(mode === 'value' ? 1 : 0);
    });
  });
});

describe('ChromiumBrowserSession.resolveGrounded()', () => {
  it.each([
    ['verify', VERIFY_SUBMIT, fixtureFingerprint()],
    ['compute', { mode: 'compute', resolvedSecrets: [] } as const, fixtureFingerprint()],
  ] as const)('captures exactly one ARIA snapshot for a %s bind and derives its fingerprint from that capture', async (_mode, query, expectedFingerprint) => {
    await withLaunchedSession({ ariaSnapshot: FIXTURE_ARIA_SNAPSHOT }, async (session, launcher) => {
      await expect(session.resolveGrounded(SUBMIT_BUTTON, query)).resolves.toEqual({
        kind: 'hit',
        element: expect.objectContaining({
          ref: SUBMIT_BUTTON,
          fingerprint: expectedFingerprint,
        }),
      });

      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(1);
      expect(launcher.page.screenshotCalls).toHaveLength(0);
    });
  });

  it('derives each successive computed fingerprint from that bind\'s one fresh scripted capture', async () => {
    const scriptedSnapshots = [FIXTURE_ARIA_SNAPSHOT, CHANGED_SUBMIT_FIXTURE];
    const expectedFingerprints = scriptedSnapshots.map(fingerprintForSnapshot);

    await withLaunchedSession({ ariaSnapshot: FIXTURE_ARIA_SNAPSHOT }, async (session, launcher) => {
      launcher.page.bodyLocator.ariaSnapshotOverride = async () => {
        const snapshot = scriptedSnapshots.shift();
        if (snapshot === undefined) {
          throw new Error('The scripted bind fixture ran out of distinct ARIA snapshots.');
        }
        return snapshot;
      };

      const first = await session.resolveGrounded(SUBMIT_BUTTON, { mode: 'compute', resolvedSecrets: [] });
      const second = await session.resolveGrounded(SUBMIT_BUTTON, { mode: 'compute', resolvedSecrets: [] });

      if (first.kind === 'miss' || second.kind === 'miss') {
        throw new Error('Both sequential computed binds must resolve their scripted submit tree.');
      }

      expect(expectedFingerprints[0]).not.toEqual(expectedFingerprints[1]);
      expect(first.element.fingerprint).toEqual(expectedFingerprints[0]);
      expect(second.element.fingerprint).toEqual(expectedFingerprints[1]);
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
    });
  });

  it('retries a bind when navigation changes generation during its capture, then consumes single-use secrets only for the stable attempt', async () => {
    let captures = 0;
    let secretIterations = 0;
    const resolvedSecrets: Iterable<ReadonlySet<string>> = {
      *[Symbol.iterator](): Iterator<ReadonlySet<string>> {
        secretIterations += 1;
        if (secretIterations > 1) {
          throw new Error('An unstable bind attempt consumed the single-use secret iterable.');
        }
        yield new Set(['unrelated-secret']);
      },
    };

    await withLaunchedSession({}, async (session, launcher) => {
      launcher.page.bodyLocator.ariaSnapshotOverride = async () => {
        captures += 1;
        if (captures === 1) {
          launcher.page.simulateMainFrameNavigation();
        }
        return FIXTURE_ARIA_SNAPSHOT;
      };

      await expect(session.resolveGrounded(SUBMIT_BUTTON, {
        mode: 'compute',
        resolvedSecrets,
      })).resolves.toEqual({
        kind: 'hit',
        element: expect.objectContaining({ fingerprint: fixtureFingerprint() }),
      });

      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      expect(secretIterations).toBe(1);
    });
  });

  it('returns element-not-found after all three bind attempts observe navigation during capture', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      launcher.page.bodyLocator.ariaSnapshotOverride = async () => {
        launcher.page.simulateMainFrameNavigation();
        return FIXTURE_ARIA_SNAPSHOT;
      };

      await expect(session.resolveGrounded(SUBMIT_BUTTON, VERIFY_SUBMIT)).resolves.toEqual({
        kind: 'miss',
        reason: 'element-not-found',
      });
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(3);
    });
  });

  it('maps parser-invalid evidence to the snapshot-invalid grounding miss reason', async () => {
    await withLaunchedSession({ ariaSnapshot: 'not an ARIA outline' }, async (session) => {
      await expect(session.resolveGrounded(SUBMIT_BUTTON, {
        mode: 'verify',
        fingerprint: {
          algorithm: 'a11y-neighborhood-v2',
          hash: 'a'.repeat(64),
        },
      })).resolves.toEqual({
        kind: 'miss',
        reason: 'snapshot-invalid',
      });
    });
  });

  it('captures fresh ARIA state instead of reusing snapshot-for-resolution evidence', async () => {
    const launcher = new FakePlaywrightLauncher({ ariaSnapshot: FIXTURE_ARIA_SNAPSHOT });
    let session: BrowserSession | undefined;

    try {
      session = await launchSession(launcher);

      await expect(session.snapshotForResolution()).resolves.toEqual({
        accessibilityTree: FIXTURE_ACCESSIBILITY_TREE,
        screenshot: FIXTURE_SCREENSHOT,
      });
      launcher.page.bodyLocator.ariaSnapshotText = FIXTURE_WITHOUT_SUBMIT;

      await expect(session.resolveGrounded(SUBMIT_BUTTON, VERIFY_SUBMIT)).resolves.toEqual({
        kind: 'miss',
        reason: 'element-not-found',
      });
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      expect(launcher.page.screenshotCalls).toHaveLength(1);
    } finally {
      await session?.close();
    }
  });

  it('reports ambiguous-match when two submit candidates exist even if one has the supplied hash', async () => {
    await withLaunchedSession({ ariaSnapshot: AMBIGUOUS_SUBMIT_FIXTURE }, async (session) => {
      await expect(session.resolveGrounded(SUBMIT_BUTTON, {
        mode: 'verify',
        fingerprint: firstAmbiguousCandidateFingerprint(),
      })).resolves.toEqual({
        kind: 'miss',
        reason: 'ambiguous-match',
      });
    });
  });

  it('rejects compute-mode binding when a resolved secret contaminates the candidate descriptor', async () => {
    await withLaunchedSession({}, async (session) => {
      await expect(session.resolveGrounded(SUBMIT_BUTTON, {
        mode: 'compute',
        resolvedSecrets: [new Set(['Submit'])],
      })).resolves.toEqual({
        kind: 'miss',
        reason: 'secret-contaminated',
      });
    });
  });
});

describe('ChromiumBrowserSession bound-element re-verification', () => {
  it('uses main-frame and same-document generation changes through the session while leaving subframe navigation valid', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const subframeTarget = await bindSubmit(session);
      launcher.page.simulateSubframeNavigation();
      await expect(session.perform({ type: 'click', target: subframeTarget })).resolves.toBeUndefined();

      const mainFrameTarget = await bindSubmit(session);
      await session.perform({ type: 'navigate', url: SAME_DESCRIPTOR_PAGE });
      await expect(session.perform({ type: 'click', target: mainFrameTarget })).rejects.toThrow('navigation');

      const sameDocumentTarget = await bindSubmit(session);
      launcher.page.simulateSameDocumentNavigation();
      await expect(session.perform({ type: 'click', target: sameDocumentTarget })).rejects.toThrow('navigation');

      expect(launcher.page.roleLocator.clickCalls).toHaveLength(1);
    });
  });

  it('rejects a handle after navigation even when the destination descriptor has the same fingerprint', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      launcher.page.simulateMainFrameNavigation();

      await expect(session.perform({ type: 'click', target })).rejects.toThrow('navigation');
      expect(launcher.page.roleLocator.clickCalls).toEqual([]);
    });
  });

  it('rejects a handle when main-frame navigation commits during its pending re-verification capture', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const snapshot = deferred<string>();
      const captureStarted = deferred<void>();
      launcher.page.bodyLocator.ariaSnapshotOverride = () => {
        captureStarted.resolve(undefined);
        return snapshot.promise;
      };
      const operation = session.perform({ type: 'click', target });
      await captureStarted.promise;
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      launcher.page.simulateMainFrameNavigation();
      snapshot.resolve(FIXTURE_ARIA_SNAPSHOT);

      await expect(operation).rejects.toThrow('navigation');
      expect(launcher.page.roleLocator.clickCalls).toEqual([]);
    });
  });

  it.each([
    ['perform', async (session: BrowserSession, target: BoundElement) => session.perform({ type: 'click', target })],
    ['element-visible', async (session: BrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'element-visible', target })],
    ['text-equals', async (session: BrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'text-equals', target, text: 'Submit' })],
    ['captureValue', async (session: BrowserSession, target: BoundElement) => session.captureValue(target, 'text')],
  ] as const)('rejects %s when the descriptor changes in place without navigation', async (_operation, invoke) => {
    await withLaunchedSession({}, async (session, launcher) => {
      const target = await bindSubmit(session);
      const generation = launcher.page.navigationGeneration();
      launcher.page.bodyLocator.ariaSnapshotText = CHANGED_SUBMIT_FIXTURE;

      await expect(invoke(session, target)).rejects.toThrow('fingerprint');
      expect(launcher.page.navigationGeneration()).toBe(generation);
      expect(launcher.page.roleLocator.clickCalls).toEqual([]);
      expect(launcher.page.roleLocator.isVisibleCalls).toEqual([]);
      expect(launcher.page.roleLocator.innerTextCalls).toEqual([]);
      expect(launcher.page.roleLocator.inputValueCalls).toEqual([]);
    });
  });

  it.each([
    ['perform', async (session: BrowserSession, target: BoundElement) => session.perform({ type: 'click', target })],
    ['element-visible', async (session: BrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'element-visible', target })],
    ['text-equals', async (session: BrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'text-equals', target, text: 'Submit' })],
    ['captureValue', async (session: BrowserSession, target: BoundElement) => session.captureValue(target, 'text')],
  ] as const)('keeps the private bind record authoritative for %s after public and original bind inputs are mutated', async (_operation, invoke) => {
    await withLaunchedSession({}, async (session, launcher) => {
      const ref: ElementRef = { ...SUBMIT_BUTTON };
      const fingerprint: Fingerprint = { ...fixtureFingerprint() };
      const result = await session.resolveGrounded(ref, { mode: 'verify', fingerprint });
      if (result.kind === 'miss') {
        throw new Error(`The mutable provenance fixture unexpectedly failed to bind: ${result.reason}`);
      }

      const element = result.element as { ref: ElementRef; fingerprint: Fingerprint };
      (element.ref as { name: string }).name = 'Attacker controlled name';
      (element.fingerprint as { hash: string }).hash = 'b'.repeat(64);
      (ref as { name: string }).name = 'Mutated original name';
      (fingerprint as { hash: string }).hash = 'c'.repeat(64);

      await invoke(session, result.element);
      expectExactSubmitLookup(launcher);
    });
  });
});

describe('ChromiumBrowserSession evidence capture', () => {
  it('pairs the parsed body ARIA snapshot with the current screenshot for resolution', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.snapshotForResolution()).resolves.toEqual({
        accessibilityTree: FIXTURE_ACCESSIBILITY_TREE,
        screenshot: FIXTURE_SCREENSHOT,
      });

      expect(launcher.page.locatorCalls).toEqual(['body']);
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(1);
      expect(launcher.page.screenshotCalls).toHaveLength(1);
    });
  });

  it('maps screenshot to the page screenshot operation', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.screenshot()).resolves.toEqual(FIXTURE_SCREENSHOT);

      expect(launcher.page.screenshotCalls).toHaveLength(1);
    });
  });

  it('derives the complete accessibility capture from one body ARIA snapshot', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.accessibilitySnapshot()).resolves.toEqual({
        rawYaml: FIXTURE_ARIA_SNAPSHOT,
        tree: FIXTURE_ACCESSIBILITY_TREE,
        scalarValues: [],
      });

      expect(launcher.page.locatorCalls).toEqual(['body']);
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(1);
    });
  });

  it('preserves raw YAML and extracts decoded discarded scalars from that same one capture', async () => {
    await withLaunchedSession({ ariaSnapshot: DISCARDED_SCALAR_FIXTURE }, async (session, launcher) => {
      await expect(session.accessibilitySnapshot()).resolves.toEqual({
        rawYaml: DISCARDED_SCALAR_FIXTURE,
        tree: parseAriaSnapshot(DISCARDED_SCALAR_FIXTURE),
        scalarValues: ['#quoted\\backslash'],
      });

      expect(launcher.page.locatorCalls).toEqual(['body']);
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(1);
    });
  });
});

describe('ChromiumBrowserSession.close()', () => {
  it('is idempotent and closes both the context and browser once', async () => {
    const launcher = new FakePlaywrightLauncher();
    const session = await launchSession(launcher);

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(launcher.context.closeCalls).toHaveLength(1);
    expect(launcher.browser.closeCalls).toHaveLength(1);
  });

  it('still closes the browser when closing the context rejects', async () => {
    const launcher = new FakePlaywrightLauncher();
    const contextFailure = new Error('context close failed');
    const session = await launchSession(launcher);
    launcher.context.closeFailure = contextFailure;

    await expect(session.close()).rejects.toBe(contextFailure);

    expect(launcher.context.closeCalls).toHaveLength(1);
    expect(launcher.browser.closeCalls).toHaveLength(1);
  });
});
