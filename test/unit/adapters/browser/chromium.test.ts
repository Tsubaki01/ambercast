import { describe, expect, it, vi } from 'vitest';
import {
  computeAccessibilityFingerprint,
  parseAriaSnapshot,
} from '#core/ir/fingerprint.js';
import type {
  ElementRef,
  Fingerprint,
  JsonValueT,
  TargetDefinition,
} from '#core/ir/schema.js';
import type { AssertCheck, BrowserSession } from '../../../../src/ports/browser.js';
import {
  createChromiumBrowserDriver,
  type PlaywrightBrowserHandle,
  type PlaywrightContextHandle,
  type PlaywrightLauncher,
  type PlaywrightLocatorHandle,
  type PlaywrightPageHandle,
} from '../../../../src/adapters/browser/chromium.js';
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

interface FakeLocatorOptions {
  readonly visible?: boolean;
  readonly text?: string;
  readonly value?: string;
  readonly count?: number;
  readonly ariaSnapshot?: string;
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
  readonly pressedKeys: string[] = [];

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
    this.ariaSnapshotCalls.push(undefined);
    return this.ariaSnapshotText;
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
  readonly roleLocator: FakePlaywrightLocator;
  readonly textLocator: FakePlaywrightLocator;
  readonly bodyLocator: FakePlaywrightLocator;
  readonly screenshotBytes: Uint8Array;

  constructor(options: FakePlaywrightOptions) {
    this.currentUrl = options.currentUrl ?? TARGET.baseUrl;
    this.roleLocator = options.roleLocator ?? new FakePlaywrightLocator();
    this.textLocator = options.textLocator ?? new FakePlaywrightLocator();
    this.bodyLocator = new FakePlaywrightLocator({ ariaSnapshot: options.ariaSnapshot ?? FIXTURE_ARIA_SNAPSHOT });
    this.screenshotBytes = options.screenshot ?? FIXTURE_SCREENSHOT;
  }

  async goto(url: string): Promise<unknown> {
    this.gotoUrls.push(url);
    if (this.gotoFailure !== undefined) {
      throw this.gotoFailure;
    }

    return undefined;
  }

  getByRole(
    role: string,
    options: { readonly name: string; readonly exact: true },
  ): PlaywrightLocatorHandle {
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
    this.locatorCalls.push(selector);
    return selector === 'body' ? this.bodyLocator : this.textLocator;
  }

  url(): string {
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

function fixtureFingerprint(): Fingerprint {
  // Deliberately derive the contract value through the production parser and
  // fingerprint algorithm from the same snapshot scripted into fake
  // Playwright. resolveGrounded() independently performs that work, so a hit
  // proves both paths agree; this fixture intentionally is not independent of
  // the core algorithm.
  const fingerprint = computeAccessibilityFingerprint(
    parseAriaSnapshot(FIXTURE_ARIA_SNAPSHOT),
    SUBMIT_BUTTON,
  );

  if (fingerprint === undefined) {
    throw new Error('The fixture ARIA snapshot does not contain the submit button.');
  }

  return fingerprint;
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
  expect(launcher.page.roleLocator.firstCalls).toHaveLength(1);
}

registerBrowserDriverContract({
  createDriver: () => createChromiumBrowserDriver({ launcher: new FakePlaywrightLauncher() }),
});

registerBrowserSessionContract({
  createSession: (setup) => launchSession(new FakePlaywrightLauncher({
    ariaSnapshot: setup.exists ? FIXTURE_ARIA_SNAPSHOT : FIXTURE_WITHOUT_SUBMIT,
  })),
  actualFingerprintFor: (_setup: BrowserSessionContractSetup) => fixtureFingerprint(),
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
  it('maps click to the first exact accessibility role match', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.perform({ type: 'click', target: SUBMIT_BUTTON })).resolves.toBeUndefined();

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

  it('maps press to the first exact accessibility role match', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.perform({ type: 'press', target: SUBMIT_BUTTON, key: 'Enter' })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.pressedKeys).toEqual(['Enter']);
    });
  });

  it('maps fill to the first exact accessibility role match', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.perform({ type: 'fill', target: SUBMIT_BUTTON, value: 'visible text' })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.fillValues).toEqual(['visible text']);
    });
  });

  it('maps fill-secret to the first exact accessibility role match', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.perform({
        type: 'fill-secret',
        target: SUBMIT_BUTTON,
        value: MATERIALIZED_SECRET,
      })).resolves.toBeUndefined();

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.fillValues).toEqual([MATERIALIZED_SECRET]);
    });
  });

  it('does not log a resolved secret when a fill-secret action succeeds', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    try {
      await withLaunchedSession({}, async (session) => {
        await expect(session.perform({
          type: 'fill-secret',
          target: SUBMIT_BUTTON,
          value: MATERIALIZED_SECRET,
        })).resolves.toBeUndefined();

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

  it('propagates a Playwright action failure without reclassifying it', async () => {
    const failure = new Error('navigation failed');

    await withLaunchedSession({}, async (session, launcher) => {
      launcher.page.gotoFailure = failure;

      await expect(session.perform({ type: 'navigate', url: '/unreachable' })).rejects.toBe(failure);
    });
  });

  it('does not log or expose a resolved secret when Playwright rejects a fill-secret action', async () => {
    const failure = new Error('input is detached');
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    try {
      await withLaunchedSession({}, async (session, launcher) => {
        launcher.page.roleLocator.fillFailure = failure;

        let thrown: unknown;
        try {
          await session.perform({
            type: 'fill-secret',
            target: SUBMIT_BUTTON,
            value: MATERIALIZED_SECRET,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBe(failure);
        expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain(MATERIALIZED_SECRET);
        expect(consoleSpies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      });
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });
});

interface AssertionScenario {
  readonly description: string;
  readonly check: AssertCheck;
  readonly failureMessage?: string;
  configure(launcher: FakePlaywrightLauncher, expectedPassed: boolean): void;
  assertPlaywright(launcher: FakePlaywrightLauncher): void;
}

const ASSERTION_SCENARIOS: readonly AssertionScenario[] = [
  {
    description: 'text-visible',
    check: { check: 'text-visible', text: 'Welcome' },
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
    check: { check: 'element-visible', target: SUBMIT_BUTTON },
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
    check: { check: 'text-equals', target: SUBMIT_BUTTON, text: 'Send form' },
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
    check: { check: 'element-count', target: SUBMIT_BUTTON, count: 2 },
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
    check: { check: 'url-matches', pattern: '^https://example\\.test/account$' },
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

          const outcome = await session.evaluateAssert(scenario.check);

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
      await expect(session.captureValue(SUBMIT_BUTTON, mode)).resolves.toBe(expectedValue);

      expectExactSubmitLookup(launcher);
      expect(launcher.page.roleLocator.innerTextCalls).toHaveLength(mode === 'text' ? 1 : 0);
      expect(launcher.page.roleLocator.inputValueCalls).toHaveLength(mode === 'value' ? 1 : 0);
    });
  });
});

describe('ChromiumBrowserSession.resolveGrounded()', () => {
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

      await expect(session.resolveGrounded(SUBMIT_BUTTON, fixtureFingerprint())).resolves.toEqual({
        kind: 'miss',
        reason: 'element-not-found',
      });
      expect(launcher.page.bodyLocator.ariaSnapshotCalls).toHaveLength(2);
      expect(launcher.page.screenshotCalls).toHaveLength(1);
    } finally {
      await session?.close();
    }
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

  it('maps accessibilitySnapshot to a parsed body ARIA snapshot', async () => {
    await withLaunchedSession({}, async (session, launcher) => {
      await expect(session.accessibilitySnapshot()).resolves.toEqual(FIXTURE_ACCESSIBILITY_TREE);

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
