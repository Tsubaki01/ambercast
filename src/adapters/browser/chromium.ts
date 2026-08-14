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
 *
 * Element operations never positionally narrow a role/name locator. Binding
 * establishes exactly one current candidate, and each use rechecks the
 * session-private bind record, navigation generation, and accessibility
 * fingerprint before constructing that candidate's locator. A navigation or
 * in-place mutation can still land after that check but before Playwright
 * receives the call; the ARIA snapshot API cannot expose a DOM handle that
 * would close that interval. Rejecting stale evidence immediately before the
 * call is the deliberately conservative mitigation.
 */

import type {
  AssertCheck,
  AssertOutcome,
  BoundElement,
  BrowserDriver,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  GroundingQuery,
  PageSnapshot,
  PerformableAction,
} from '#ports/browser.js';
import { parseAriaSnapshot } from '#core/ir/aria-snapshot.js';
import {
  computeAccessibilityFingerprint,
  resolveAccessibilityFingerprint,
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

  /**
   * Returns the generation associated with main-frame navigation.
   *
   * @remarks
   * The production page adapter advances this value from Playwright's
   * `framenavigated` event for the main frame. That event also covers
   * same-document navigation such as `history.pushState`, so generation
   * invalidation intentionally over-approximates DOM replacement: an SPA
   * route change can reject an otherwise usable binding, but it can never
   * permit a stale binding to act on the wrong page.
   */
  navigationGeneration(): number;

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
  let generation = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      generation += 1;
    }
  });

  return {
    goto: (url) => page.goto(url),
    getByRole: (role, options) => adaptLocator(page.getByRole(role as PlaywrightRole, options)),
    getByText: (text) => adaptLocator(page.getByText(text)),
    locator: (selector) => adaptLocator(page.locator(selector)),
    navigationGeneration: () => generation,
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
 * The adapter-owned facts that make one bound-element object meaningful to
 * exactly one browser session and one observed navigation generation.
 */
type PrivateBindRecord = {
  readonly generation: number;
  readonly ref: ElementRef;
  readonly fingerprint: Fingerprint;
};

type ReverifiedBinding = {
  readonly locator: PlaywrightLocatorHandle;
  readonly ref: ElementRef;
};

function copyElementRef(ref: ElementRef): ElementRef {
  return { ...ref };
}

function copyFingerprint(fingerprint: Fingerprint): Fingerprint {
  return { ...fingerprint };
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

  /**
   * Records bind provenance by handle identity rather than trusting the
   * serializable fields a caller can mutate or fabricate.
   */
  readonly #bindings = new WeakMap<BoundElement, PrivateBindRecord>();

  constructor(
    private readonly page: PlaywrightPageHandle,
    private readonly context: PlaywrightContextHandle,
    private readonly browser: PlaywrightBrowserHandle,
  ) {}

  /**
   * Executes a materialized replay action through its Playwright equivalent.
   *
   * @remarks
   * Navigation leaves relative-URL resolution to the context base URL,
   * avoiding a second URL-resolution rule in this adapter. A materialized
   * secret is used only to fulfill its action and is never logged or returned.
   *
   * Before a targeted call, the adapter treats its private bind record as the
   * authority: the handle must have been minted by this session, its recorded
   * navigation generation must still bracket one fresh accessibility capture,
   * and that capture must still resolve the recorded fingerprint. Only then
   * may the adapter build a locator from the recorded reference. The public
   * `BoundElement` fields never make these decisions. Each failed check throws
   * a plain reason-bearing `Error`, leaving the run usecase to classify the
   * browser rejection consistently with other adapter failures.
   */
  async perform(action: PerformableAction): Promise<void> {
    switch (action.type) {
      case 'click': {
        const { locator } = await this.reverifyBinding(action.target);
        await locator.click();
        return;
      }
      case 'press': {
        const { locator } = await this.reverifyBinding(action.target);
        await locator.press(action.key);
        return;
      }
      case 'fill':
      case 'fill-secret': {
        const { locator } = await this.reverifyBinding(action.target);
        await locator.fill(action.value);
        return;
      }
      case 'navigate':
        await this.page.goto(action.url);
        return;
    }
  }

  /**
   * Evaluates an assertion using page-visible browser evidence.
   *
   * @remarks
   * Targeted assertions use the same bound-element guarantee as actions,
   * while `element-count` deliberately retains the full role/name match set.
   * Visible text uses Playwright's structured text locator so supplied text is
   * data rather than selector syntax.
   *
   * A malformed URL pattern remains a `RegExp` construction error. The run
   * usecase folds that rejection into its unified case-abort stopgap instead of
   * assigning the adapter a classification it cannot justify.
   *
   * `element-visible` and `text-equals` apply the same three-stage
   * operation-immediate gate as `perform`: private provenance, navigation
   * generation bracketing a fresh accessibility capture, then fingerprint
   * re-verification against that capture. Its failures intentionally remain
   * plain `Error`s, because this adapter cannot assign a core error category
   * more accurately than the run usecase's existing browser-rejection path.
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
        const { locator, ref } = await this.reverifyBinding(check.target);
        const passed = await locator.isVisible();
        return passed
          ? { passed: true }
          : { passed: false, message: `Element is not visible: ${ref.name}` };
      }
      case 'text-equals': {
        const { locator, ref } = await this.reverifyBinding(check.target);
        const actual = await locator.innerText();
        const passed = actual === check.text;
        return passed
          ? { passed: true }
          : {
            passed: false,
            message: `Element text does not equal: ${ref.name}; expected "${check.text}", received "${actual}".`,
          };
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
   *
   * A capture applies the same operation-immediate private-provenance,
   * navigation-generation, and fingerprint checks as targeted actions and
   * assertions. Those checks reject with plain `Error`s so the adapter stays
   * independent of core error classification while the run usecase preserves
   * one browser-failure boundary.
   */
  async captureValue(target: BoundElement, mode: CaptureMode): Promise<string> {
    const { locator } = await this.reverifyBinding(target);
    return mode === 'text' ? locator.innerText() : locator.inputValue();
  }

  /**
   * Binds one accessibility reference before an element may be used.
   *
   * @remarks
   * Every binding captures its own current body ARIA snapshot. Verify mode
   * compares its one unique candidate against the supplied fingerprint;
   * compute mode derives a fingerprint from the same capture while applying
   * the secret-taint gate. Duplicate candidates remain unusable in both modes
   * because a role/name locator cannot carry physical-node identity through a
   * later browser operation.
   *
   * That capture is distinct from `snapshotForResolution()`: callers may
   * request paired diagnostic evidence separately, but it is never reused as
   * this method's binding input.
   *
   * The capture is bracketed by navigation-generation reads. A generation that
   * changes during capture is an ordinary failed bind attempt, retried at most
   * three times because no operation is pending yet; exhausting that bound
   * reports the ordinary element-not-found miss rather than minting a handle
   * from an observation that straddled navigation. In compute mode, the
   * generation comparison succeeds before the method consumes
   * `resolvedSecrets` to classify the capture. That iterable may be single
   * use, so a capture retried because its generation changed leaves it
   * untouched for the later stable capture.
   */
  async resolveGrounded(ref: ElementRef, query: GroundingQuery): Promise<GroundedResolution> {
    const recordedRef = copyElementRef(ref);
    const expectedFingerprint = query.mode === 'verify'
      ? copyFingerprint(query.fingerprint)
      : undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.page.navigationGeneration();
      const tree = await this.accessibilitySnapshot();
      const after = this.page.navigationGeneration();

      if (before !== after) {
        continue;
      }

      if (query.mode === 'verify') {
        if (expectedFingerprint === undefined) {
          throw new Error('A verify grounding query requires a fingerprint.');
        }

        const result = resolveAccessibilityFingerprint(tree, recordedRef, expectedFingerprint);
        return result === 'hit'
          ? { kind: 'hit', element: this.mintBoundElement(recordedRef, expectedFingerprint, after) }
          : { kind: 'miss', reason: result };
      }

      const result = computeAccessibilityFingerprint(tree, recordedRef, query.resolvedSecrets);
      if (result.kind === 'ok') {
        return {
          kind: 'hit',
          element: this.mintBoundElement(recordedRef, result.fingerprint, after),
        };
      }

      return {
        kind: 'miss',
        reason: result.kind === 'no-match' ? 'element-not-found' : result.kind,
      };
    }

    return { kind: 'miss', reason: 'element-not-found' };
  }

  /**
   * Re-establishes a target's binding immediately before its browser call.
   *
   * Provenance is checked before capture so foreign or fabricated handles
   * cannot observe this page. A valid private record must then retain its
   * generation across one fresh capture and still resolve its own recorded
   * fingerprint. The returned locator is built only after those checks from
   * the private reference, preserving the handle's session-local identity.
   */
  private async reverifyBinding(target: BoundElement): Promise<ReverifiedBinding> {
    const record = this.#bindings.get(target);
    if (record === undefined) {
      throw new Error('Bound element provenance is not valid for this browser session.');
    }

    const before = this.page.navigationGeneration();
    const tree = await this.accessibilitySnapshot();
    const after = this.page.navigationGeneration();
    if (before !== record.generation || after !== record.generation) {
      throw new Error('Bound element navigation generation is stale.');
    }

    const result = resolveAccessibilityFingerprint(tree, record.ref, record.fingerprint);
    if (result !== 'hit') {
      throw new Error(`Bound element fingerprint verification failed: ${result}.`);
    }

    return {
      locator: this.page.getByRole(record.ref.role, {
        name: record.ref.name,
        exact: true,
      }),
      ref: record.ref,
    };
  }

  /**
   * Creates the public handle and the independent private facts its later
   * operation-immediate re-verification must trust.
   */
  private mintBoundElement(
    ref: ElementRef,
    fingerprint: Fingerprint,
    generation: number,
  ): BoundElement {
    const element: BoundElement = {
      ref: copyElementRef(ref),
      fingerprint: copyFingerprint(fingerprint),
    };
    this.#bindings.set(element, {
      generation,
      ref: copyElementRef(ref),
      fingerprint: copyFingerprint(fingerprint),
    });
    return element;
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
