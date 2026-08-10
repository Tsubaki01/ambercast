/*
 * Adapts Chromium through the browser ports while keeping Playwright an
 * implementation detail. No Playwright type crosses this module's public
 * surface or the `src/ports/browser.ts` boundary; callers receive only the
 * serializable values and port contracts they need to orchestrate a run.
 *
 * A structural `PlaywrightLauncher` seam spans the browser, context, and page
 * lifecycle. This follows the whole-lifecycle injection pattern of
 * `CommandRunner` in the AI adapters: a page-methods-only fake would leave
 * launch options, context creation, and cleanup unexercised. The complete seam
 * lets unit tests drive that sequence without starting a browser.
 */

import type {
  AssertCheck,
  AssertOutcome,
  BrowserDriver,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  PageSnapshot,
  PerformableAction,
} from '#ports/browser.js';
import {
  computeAccessibilityFingerprint,
  parseAriaSnapshot,
} from '#core/ir/fingerprint.js';
import type { ElementRef, Fingerprint, JsonValueT, TargetDefinition } from '#core/ir/schema.js';

type PlaywrightBrowser = import('playwright-core').Browser;
type PlaywrightContext = import('playwright-core').BrowserContext;
type PlaywrightLocator = import('playwright-core').Locator;
type PlaywrightPage = import('playwright-core').Page;
type PlaywrightRole = Parameters<PlaywrightPage['getByRole']>[0];

/**
 * The locator operations Chromium replay needs from Playwright.
 *
 * @remarks
 * This is deliberately a structural subset rather than a re-export of a
 * Playwright type. A real Playwright locator and a plain hermetic test fake
 * can both supply it, while adapter callers remain independent of Playwright.
 */
export interface PlaywrightLocatorHandle {
  first(): PlaywrightLocatorHandle;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
  inputValue(): Promise<string>;
  count(): Promise<number>;
  ariaSnapshot(): Promise<string>;
}

/**
 * The page operations Chromium replay drives through Playwright.
 *
 * @remarks
 * Role lookup retains a string role because the IR's validated accessibility
 * reference is intentionally independent of Playwright's role-type export.
 * The exact-name options preserve the recorded role-and-name identity.
 */
export interface PlaywrightPageHandle {
  goto(url: string): Promise<unknown>;
  getByRole(
    role: string,
    options: { readonly name: string; readonly exact: true },
  ): PlaywrightLocatorHandle;
  getByText(text: string): PlaywrightLocatorHandle;
  locator(selector: string): PlaywrightLocatorHandle;
  url(): string;
  screenshot(): Promise<Uint8Array>;
}

/**
 * The context lifecycle Chromium replay needs from a launched browser.
 */
export interface PlaywrightContextHandle {
  newPage(): Promise<PlaywrightPageHandle>;
  close(): Promise<void>;
}

/**
 * The browser operation Chromium replay needs after launch.
 */
export interface PlaywrightBrowserHandle {
  newContext(options: { readonly baseURL: string }): Promise<PlaywrightContextHandle>;
  close(): Promise<void>;
}

/**
 * The narrow launcher seam used to create Chromium browser sessions.
 *
 * @remarks
 * It spans the browser-to-context-to-page lifecycle rather than exposing only
 * page methods, so tests can verify launch policy, base-URL setup, page
 * creation, and context cleanup without starting a browser. No Playwright
 * type crosses this seam; it is satisfied structurally by both the production
 * launcher and a hermetic fake.
 */
export interface PlaywrightLauncher {
  launch(options: { readonly headless: boolean }): Promise<PlaywrightBrowserHandle>;
}

/**
 * Construction choices for the Chromium driver.
 *
 * @remarks
 * This strict superset of the registry's `BrowserLaunchOptions` preserves the
 * registry factory's `(options?: BrowserLaunchOptions) => BrowserDriver`
 * assignability while keeping the adapter-only launcher seam out of registry
 * and port types.
 */
export interface CreateChromiumBrowserDriverOptions {
  /** Requests a visible browser rather than Playwright headless mode. */
  readonly headed?: boolean;

  /** Optional lifecycle seam used by hermetic browser-adapter tests. */
  readonly launcher?: PlaywrightLauncher;
}

/**
 * Converts a real Playwright locator into the small structural seam used by
 * this adapter.
 *
 * Keeping this conversion at the integration edge prevents Playwright types
 * and its broader API from leaking into the port-facing session. The wrapper
 * intentionally forwards only operations the replay contract needs.
 */
function adaptLocator(locator: PlaywrightLocator): PlaywrightLocatorHandle {
  return {
    first: () => adaptLocator(locator.first()),
    click: () => locator.click(),
    fill: (value) => locator.fill(value),
    press: (key) => locator.press(key),
    innerText: () => locator.innerText(),
    isVisible: () => locator.isVisible(),
    inputValue: () => locator.inputValue(),
    count: () => locator.count(),
    ariaSnapshot: () => locator.ariaSnapshot(),
  };
}

/**
 * Adapts a Playwright page while retaining the exact-role lookup policy at
 * the seam boundary.
 *
 * The IR validates accessibility roles independently of Playwright's closed
 * role union. The cast is therefore contained here, where the real API is
 * invoked, rather than widening the adapter's public structural interface.
 */
function adaptPage(page: PlaywrightPage): PlaywrightPageHandle {
  return {
    goto: (url) => page.goto(url),
    getByRole: (role, options) => adaptLocator(page.getByRole(role as PlaywrightRole, options)),
    getByText: (text) => adaptLocator(page.getByText(text)),
    locator: (selector) => adaptLocator(page.locator(selector)),
    url: () => page.url(),
    screenshot: () => page.screenshot(),
  };
}

/**
 * Adapts Playwright's context lifecycle to the structural launcher seam.
 */
function adaptContext(context: PlaywrightContext): PlaywrightContextHandle {
  return {
    newPage: async () => adaptPage(await context.newPage()),
    close: () => context.close(),
  };
}

/**
 * Adapts a dedicated Playwright browser and each context it creates.
 */
function adaptBrowser(browser: PlaywrightBrowser): PlaywrightBrowserHandle {
  return {
    newContext: async (options) => adaptContext(await browser.newContext(options)),
    close: () => browser.close(),
  };
}

/**
 * Creates the production launcher without making Playwright a load-time
 * requirement for hermetic callers.
 *
 * Dynamic import keeps the test seam fully isolated and defers browser-module
 * resolution until a production driver actually launches. The result is
 * immediately wrapped into the same narrow lifecycle interface injected by
 * unit tests.
 */
function createDefaultPlaywrightLauncher(): PlaywrightLauncher {
  return {
    async launch(options): Promise<PlaywrightBrowserHandle> {
      const { chromium } = await import('playwright-core');
      return adaptBrowser(await chromium.launch(options));
    },
  };
}

/**
 * Owns the port view of one Chromium page session.
 *
 * Materialized `fill-secret` values may reach the browser only to perform the
 * requested action. No session method logs a resolved secret or returns one
 * to its caller.
 */
class ChromiumBrowserSession implements BrowserSession {
  private closed = false;

  constructor(
    private readonly page: PlaywrightPageHandle,
    private readonly context: PlaywrightContextHandle,
    private readonly browser: PlaywrightBrowserHandle,
  ) {}

  /**
   * Narrows an accessibility reference to the first exact role-and-name
   * match for operations that require one element.
   */
  private firstRoleLocator(target: ElementRef): PlaywrightLocatorHandle {
    return this.page.getByRole(target.role, { name: target.name, exact: true }).first();
  }

  /**
   * Executes a materialized replay action through its Playwright equivalent.
   *
   * @remarks
   * Element-targeted actions use the first exact role-and-name match because a
   * replay action operates on one recorded identity even if the page contains
   * duplicates. Navigation leaves relative-URL resolution to the context base
   * URL, avoiding a second URL-resolution rule in this adapter. In `run.ts`,
   * the replay boundary validates a navigation origin before constructing its
   * `navigate` `PerformableAction`. A materialized
   * secret is used only to fulfill its action and is never logged or returned.
   */
  async perform(action: PerformableAction): Promise<void> {
    switch (action.type) {
      case 'click':
        await this.firstRoleLocator(action.target).click();
        return;
      case 'navigate':
        await this.page.goto(action.url);
        return;
      case 'press':
        await this.firstRoleLocator(action.target).press(action.key);
        return;
      case 'fill':
      case 'fill-secret':
        await this.firstRoleLocator(action.target).fill(action.value);
        return;
    }
  }

  /**
   * Evaluates an assertion using page-visible browser evidence.
   *
   * @remarks
   * Targeted assertions preserve the exact role-and-name lookup policy used
   * for actions; checks that require one element narrow duplicate matches to
   * the first, while a count deliberately retains the full match set. Visible
   * text uses Playwright's structured text locator so supplied text is data
   * rather than selector syntax.
   *
   * A malformed URL pattern remains a `RegExp` construction error. The run
   * usecase folds that rejection into its unified case-abort stopgap instead of
   * assigning the adapter a classification it cannot justify.
   */
  async evaluateAssert(check: AssertCheck): Promise<AssertOutcome> {
    switch (check.check) {
      case 'text-visible': {
        const passed = await this.page.getByText(check.text).isVisible();
        return passed
          ? { passed: true }
          : { passed: false, message: `Text is not visible: ${check.text}` };
      }
      case 'element-visible': {
        const passed = await this.firstRoleLocator(check.target).isVisible();
        return passed
          ? { passed: true }
          : { passed: false, message: `Element is not visible: ${check.target.name}` };
      }
      case 'text-equals': {
        const actualText = await this.firstRoleLocator(check.target).innerText();
        const passed = actualText === check.text;
        return passed
          ? { passed: true }
          : { passed: false, message: `Element text does not equal: ${check.target.name}; expected "${check.text}", received "${actualText}".` };
      }
      case 'url-matches': {
        const expression = new RegExp(check.pattern);
        const passed = expression.test(this.page.url());
        return passed
          ? { passed: true }
          : { passed: false, message: `Current URL does not match: ${check.pattern}` };
      }
      case 'element-count': {
        const actualCount = await this.page.getByRole(
          check.target.role,
          { name: check.target.name, exact: true },
        ).count();
        const passed = actualCount === check.count;
        return passed
          ? { passed: true }
          : { passed: false, message: `Element count does not equal: ${check.target.name}; expected ${check.count}, received ${actualCount}.` };
      }
    }
  }

  /**
   * Captures an element value using the requested port mode.
   *
   * @remarks
   * The port distinguishes rendered text from a control value so callers can
   * preserve the meaning of later interpolation instead of treating every
   * element as one generic string source.
   */
  async captureValue(target: ElementRef, mode: CaptureMode): Promise<string> {
    const locator = this.firstRoleLocator(target);

    return mode === 'text' ? locator.innerText() : locator.inputValue();
  }

  /**
   * Verifies recorded grounding before an element may be used.
   *
   * A missing element is always an `element-not-found` miss, and an existing
   * element with a different current fingerprint is always a
   * `fingerprint-mismatch` miss. Neither condition is a diagnostic-only
   * pass-through: accepting it would let stale grounding direct a step to an
   * unintended element. This method independently captures its own current
   * body ARIA snapshot, parses it with `parseAriaSnapshot()`, and computes the
   * live fingerprint with `computeAccessibilityFingerprint()` before comparing
   * it with `fp`. That capture is distinct from `snapshotForResolution()`:
   * callers may request that paired diagnostic evidence separately, but it is
   * never reused as this method's comparison input.
   */
  async resolveGrounded(ref: ElementRef, fp: Fingerprint): Promise<GroundedResolution> {
    const currentFingerprint = computeAccessibilityFingerprint(
      await this.accessibilitySnapshot(),
      ref,
    );

    if (currentFingerprint === undefined) {
      return { kind: 'miss', reason: 'element-not-found' };
    }

    if (
      currentFingerprint.algorithm !== fp.algorithm
      || currentFingerprint.hash !== fp.hash
    ) {
      return { kind: 'miss', reason: 'fingerprint-mismatch' };
    }

    return { kind: 'hit', ref };
  }

  /**
   * Captures paired accessibility-tree and screenshot evidence for diagnostics
   * and AI-assisted element re-resolution when grounding alone cannot identify
   * an element.
   *
   * @remarks
   * The returned `PageSnapshot` pairs the accessibility tree produced from
   * the page's `ariaSnapshot()` through `parseAriaSnapshot()` with a screenshot
   * from that page's screenshot capture. This method does not compute a fingerprint:
   * `resolveGrounded()` makes its own independent capture and delegates that
   * fingerprint computation to the core algorithm.
   */
  async snapshotForResolution(): Promise<PageSnapshot> {
    const [accessibilityTree, screenshot] = await Promise.all([
      this.accessibilitySnapshot(),
      this.screenshot(),
    ]);

    return { accessibilityTree, screenshot };
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot();
  }

  /**
   * Produces the same parsed ARIA-tree representation used for grounding and
   * resolution evidence, rather than exposing Playwright's raw result.
   */
  async accessibilitySnapshot(): Promise<JsonValueT> {
    return parseAriaSnapshot(await this.page.locator('body').ariaSnapshot());
  }

  /**
   * Releases the session context and the browser launched for this session.
   *
   * @remarks
   * Each `driver.launch()` call creates one dedicated browser instance for its
   * session. Closing only the context would leave that browser process alive,
   * so closure releases both resources.
   *
   * Closing is idempotent: after a session has closed, a second call is a
   * no-op rather than an error, matching the browser port's lifecycle
   * contract and making caller `finally` cleanup safe to repeat.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      await this.context.close();
    } finally {
      await this.browser.close();
    }
  }
}

/**
 * Launches Chromium sessions for targets that select the Chromium engine.
 */
class ChromiumBrowserDriver implements BrowserDriver {
  readonly engine = 'chromium' as const;

  constructor(
    private readonly launcher: PlaywrightLauncher,
    private readonly headed: boolean,
  ) {}

  /**
   * Creates a context and initial page configured with the target base URL,
   * but deliberately performs no navigation.
   *
   * A newly launched session therefore makes no network request on its own;
   * only a later `navigate` action changes page location. This keeps session
   * creation independent of fixture availability and leaves navigation under
   * the run step that requested it.
   *
   * @throws If Chromium cannot start a browser session for the target.
   */
  async launch(target: TargetDefinition): Promise<BrowserSession> {
    const browser = await this.launcher.launch({ headless: !this.headed });
    let context: PlaywrightContextHandle | undefined;

    try {
      context = await browser.newContext({ baseURL: target.baseUrl });
      const page = await context.newPage();
      return new ChromiumBrowserSession(page, context, browser);
    } catch (error) {
      try {
        await context?.close();
      } catch {
        // The original launch failure identifies the operation that failed.
      }

      try {
        await browser.close();
      } catch {
        // Best-effort cleanup must not hide the failed launch operation.
      }

      throw error;
    }
  }
}

/**
 * Creates the Chromium implementation of `BrowserDriver`.
 *
 * @param options - Launch policy and, for tests, an optional structural
 *   Playwright lifecycle seam.
 * @returns A driver whose sessions satisfy the browser port without exposing
 * Playwright implementation objects.
 *
 * @remarks
 * When supplied, `launcher` is the sole browser lifecycle dependency the
 * factory uses. Otherwise a thin launcher dynamically imports
 * `playwright-core` at first launch and wraps its browser/context/page objects
 * into this module's structural handles. The factory retains one options bag
 * so its signature stays assignable to the registry's existing browser-launch
 * factory type; callers that know only `headed` need not know this adapter-
 * local seam. Browser-start failures reject the returned driver's `launch()`
 * call, not this construction function.
 */
export function createChromiumBrowserDriver(
  options: CreateChromiumBrowserDriverOptions = {},
): BrowserDriver {
  return new ChromiumBrowserDriver(
    options.launcher ?? createDefaultPlaywrightLauncher(),
    options.headed ?? false,
  );
}
