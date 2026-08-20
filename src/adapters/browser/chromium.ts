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
 * Ordinary element operations retain Locator semantics after binding has
 * rechecked the session-private record, navigation generation, and
 * accessibility fingerprint. Secret writes need a stronger boundary because
 * a late Locator resolution could otherwise select a same-named element in a
 * document reached after the sink-origin decision. The secret path strictly
 * acquires one adapter-private physical element after continuity, rejects a
 * navigation-generation change caused during acquisition, and makes
 * the final live-origin decision immediately before filling that same object.
 * Each call owns and releases its physical element independently. Reusing one
 * would bypass that later call's continuity, generation, and origin checks and
 * could retain an element from a document the session has already left.
 * Cleanup failures cannot replace either a primary rejection or a successful
 * fill. This closes cross-document retargeting while accepting only the
 * narrower renderer-internal interval after the pinned operation is accepted.
 */

import type {
  AssertCheck,
  AssertOutcome,
  AccessibilityCapture,
  BoundElement,
  BrowserDriver,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  GroundingQuery,
  PageSnapshot,
  PerformableAction,
} from '#ports/browser.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { extractDiscardedScalarValues, parseAriaSnapshot } from '#core/ir/aria-snapshot.js';
import {
  computeAccessibilityFingerprint,
  resolveAccessibilityFingerprint,
} from '#core/ir/fingerprint.js';
import type { ElementRef, Fingerprint, TargetDefinition } from '#core/ir/schema.js';
import { isAllowedSecretSinkOrigin } from '#core/secrets/sink-policy.js';
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';

type PlaywrightBrowser = import('playwright-core').Browser;
type PlaywrightContext = import('playwright-core').BrowserContext;
type PlaywrightLocator = import('playwright-core').Locator;
type PlaywrightPage = import('playwright-core').Page;
type PlaywrightRole = Parameters<PlaywrightPage['getByRole']>[0];

/**
 * The invocation-scoped physical operations required by secret writes.
 *
 * @remarks
 * Limiting this adapter-private seam to filling and deterministic disposal
 * keeps raw Playwright objects, DOM evaluation, and serializable element state
 * from crossing the secret boundary.
 */
interface PlaywrightElementHandle {
  fill(value: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The locator operations Chromium replay needs from Playwright.
 *
 * @remarks
 * This is deliberately a structural subset rather than a re-export of a
 * Playwright type. A real Playwright locator and a plain hermetic test fake
 * can both supply it, while adapter callers remain independent of Playwright.
 * Physical acquisition resolves the exact Locator under strictness once, and
 * only the secret path consumes that result, so pinning and disposal remain
 * adapter-private mechanics rather than browser-port capabilities.
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
  elementHandle(): Promise<PlaywrightElementHandle>;
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
    elementHandle: async () => {
      const element = await locator.elementHandle();
      if (element === null) {
        throw new Error('Strict element acquisition found no matching element.');
      }

      return {
        async fill(value): Promise<void> {
          try {
            await element.fill(value);
          } catch {
            /*
             * Playwright retains the supplied value in its physical-fill call
             * log. Collapse that integration diagnostic here without
             * inspecting it or attaching it as a cause. The session still
             * propagates this structural rejection unchanged; fake-identity
             * tests prove `fillSecret` adds no classification of its own.
             */
            throw new Error('The fixed browser target could not be filled.');
          }
        },
        dispose: () => element.dispose(),
      };
    },
  };
}

/**
 * Adapts a Playwright page while retaining the exact-role lookup policy at
 * the seam boundary.
 *
 * The IR validates accessibility roles independently of Playwright's closed
 * role union. The cast is therefore contained here, where the real API is
 * invoked, rather than widening the adapter's public structural interface.
 *
 * Page-scoped text visibility deliberately selects the first text match at
 * this production boundary. Unlike bound role/name targets, text assertions
 * may legitimately match repeated presentation text; Playwright requires an
 * explicit single candidate before `isVisible()` can inspect it. Keeping that
 * narrowing here preserves the smaller structural locator seam for all other
 * adapter users and still bases the assertion on visibility, not merely a
 * nonzero match count that could include hidden text.
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
    getByText: (text) => adaptLocator(page.getByText(text).first()),
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
  readonly generation: number;
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
   * avoiding a second URL-resolution rule in this adapter.
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
      case 'fill': {
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
   * Fills a bound element with a secret after policy and continuity checks.
   *
   * The path first validates the live origin before awaiting continuity or
   * acquisition. That fail-fast checkpoint preserves integrity classification
   * when an already-disallowed navigation has also made the binding stale,
   * rather than allowing the stale-binding error to win.
   *
   * Unlike ordinary Locator-backed actions, the secret path must not retain a
   * late-binding target after its last origin decision. The implementation
   * strictly acquires one physical element only after continuity succeeds,
   * then verifies that navigation generation still matches the generation
   * bracketed by the fresh accessibility capture. This extra comparison
   * rejects acquisition that retried into a new, otherwise allowed document.
   *
   * Continuity, acquisition, and the post-acquisition generation check share
   * one failure-classification region. If any rejects, a live origin check
   * replaces that rejection only when policy now denies the page; otherwise
   * the original rejection propagates unchanged. After successful acquisition,
   * the final live-origin check is followed immediately by `fill` on that
   * exact object, with no `await` or Locator resolution between them.
   *
   * The acquired object is adapter-private and scoped to one invocation. A
   * later call acquires afresh because reusing this object would let it bypass
   * that call's continuity, generation, and origin checks and could retain an
   * element from a document already left. The object is disposed after
   * success and after every post-acquisition failure, but only after the
   * primary outcome has been classified. Disposal failures are suppressed so
   * cleanup cannot mask a security decision, leak browser text into
   * diagnostics, or turn an accepted fill into a failure. Origin diagnostics
   * never include the materialized value. A navigation accepted only after
   * the pinned fill begins can detach that object but cannot retarget it; the
   * remaining renderer-internal interval is outside this adapter's observable
   * boundary.
   */
  async fillSecret(
    target: BoundElement,
    value: string,
    policy: SecretSinkPolicy,
  ): Promise<void> {
    this.assertSecretSinkOrigin(policy);

    let acquired: PlaywrightElementHandle | undefined;
    try {
      try {
        const reverified = await this.reverifyBinding(target);
        acquired = await reverified.locator.elementHandle();
        if (this.page.navigationGeneration() !== reverified.generation) {
          throw new Error('Bound element navigation generation changed during physical acquisition.');
        }
      } catch (error) {
        this.assertSecretSinkOrigin(policy);
        throw error;
      }

      this.assertSecretSinkOrigin(policy);
      await acquired.fill(value);
    } finally {
      try {
        await acquired?.dispose();
      } catch {
        // Cleanup never changes or exposes the primary operation outcome.
      }
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
      const capture = await this.accessibilitySnapshot();
      const after = this.page.navigationGeneration();

      if (before !== after) {
        continue;
      }

      if (query.mode === 'verify') {
        if (expectedFingerprint === undefined) {
          throw new Error('A verify grounding query requires a fingerprint.');
        }

        const result = resolveAccessibilityFingerprint(capture.tree, recordedRef, expectedFingerprint);
        return result === 'hit'
          ? { kind: 'hit', element: this.mintBoundElement(recordedRef, expectedFingerprint, after) }
          : { kind: 'miss', reason: result };
      }

      const result = computeAccessibilityFingerprint(capture.tree, recordedRef, query.resolvedSecrets);
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
   * Confirms that the live page may receive a secret under its resolved policy.
   *
   * This centralizes the three origin checkpoints on the secret-fill path:
   * fail fast before continuity work, reclassify a failed continuity,
   * physical-acquisition, or post-acquisition generation-validation phase if
   * the origin became unsound, and guard the already-acquired element
   * immediately before its fill. When the reclassification check finds the
   * origin still sound, the original failure retains precedence. Sharing one
   * policy decision keeps the checkpoints aligned in their integrity
   * classification and secret-free diagnostics.
   *
   * This remains outside `reverifyBinding` because that general continuity
   * helper serves non-secret operations too; giving it secret-sink policy
   * awareness would couple those operations to a concern they do not have.
   *
   * @param policy - The resolved policy authorizing the secret's destination.
   * @throws {IntegrityViolationError} When the current page origin is not
   *   allowed to receive the policy's secret.
   */
  private assertSecretSinkOrigin(policy: SecretSinkPolicy): void {
    if (!isAllowedSecretSinkOrigin(policy, this.page.url())) {
      throw new IntegrityViolationError('The current page origin is not allowed to receive this secret.', {
        secretRef: policy.secretRef,
        allowedOrigins: policy.allowedOrigins,
        source: policy.source,
      });
    }
  }

  /**
   * Re-establishes a target's binding immediately before its browser call.
   *
   * Provenance is checked before capture so foreign or fabricated handles
   * cannot observe this page. A valid private record must then retain its
   * generation across one fresh capture and still resolve its own recorded
   * fingerprint. The returned locator is built only after those checks from
   * the private reference, preserving the handle's session-local identity.
   * The result also exposes the generation proven by that capture so the
   * secret-only caller can detect navigation that occurs while it strictly
   * acquires its physical element. Other callers retain ordinary Locator
   * behavior and do not inherit secret-sink policy concerns.
   */
  private async reverifyBinding(target: BoundElement): Promise<ReverifiedBinding> {
    const record = this.#bindings.get(target);
    if (record === undefined) {
      throw new Error('Bound element provenance is not valid for this browser session.');
    }

    const before = this.page.navigationGeneration();
    const capture = await this.accessibilitySnapshot();
    const after = this.page.navigationGeneration();
    if (before !== record.generation || after !== record.generation) {
      throw new Error('Bound element navigation generation is stale.');
    }

    const result = resolveAccessibilityFingerprint(capture.tree, record.ref, record.fingerprint);
    if (result !== 'hit') {
      throw new Error(`Bound element fingerprint verification failed: ${result}.`);
    }

    return {
      generation: after,
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
   * `PageSnapshot` has shape `{ accessibilityTree, screenshot }` and takes
   * only the capture's parsed tree, so detection-only raw YAML and
   * discarded scalar values have no structural route into AI re-resolution.
   * This method does not compute a fingerprint: `resolveGrounded()` makes its
   * own independent capture and delegates that computation to the core
   * algorithm.
   */
  async snapshotForResolution(): Promise<PageSnapshot> {
    const [capture, screenshot] = await Promise.all([
      this.accessibilitySnapshot(),
      this.screenshot(),
    ]);

    return { accessibilityTree: capture.tree, screenshot };
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot();
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  /**
   * Produces the one same-instant accessibility capture used by grounding and
   * screenshot-retention detection.
   *
   * All three fields derive from one body `ariaSnapshot()` observation rather
   * than separate browser reads. Keeping the evidence tied to one DOM instant
   * prevents a detector from combining raw and parsed values from different
   * page states.
   */
  async accessibilitySnapshot(): Promise<AccessibilityCapture> {
    const rawYaml = await this.page.locator('body').ariaSnapshot();
    return {
      rawYaml,
      tree: parseAriaSnapshot(rawYaml),
      scalarValues: extractDiscardedScalarValues(rawYaml),
    };
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
