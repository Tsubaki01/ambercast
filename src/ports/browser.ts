/**
 * Declares the browser boundary used by run orchestration and browser
 * adapters. The caller materializes run data before crossing this boundary,
 * keeping browser implementations independent of secret and run-state ports.
 */
import type {
  ElementRef,
  Fingerprint,
  JsonValueT,
  TargetDefinition,
  TracePress,
} from '#core/ir/schema.js';

/**
 * A browser engine supported by the IR target definition.
 *
 * Deriving this union from the target contract keeps target validation and
 * driver selection aligned as browser support grows.
 */
export type BrowserEngine = TargetDefinition['browser'];

/**
 * A portable snapshot captured from a browser session.
 *
 * The accessibility tree remains a serializable {@link JsonValueT}, rather
 * than `unknown`, so consumers can inspect it without an unsafe cast while
 * preserving the value class that can be recorded or transported. Screenshots
 * use `Uint8Array` to avoid imposing a Node-specific binary type.
 */
export type PageSnapshot = {
  readonly accessibilityTree: JsonValueT;
  readonly screenshot: Uint8Array;
};

/**
 * An action whose values are ready for direct browser execution.
 *
 * This intentionally mirrors the trace action vocabulary instead of reusing
 * its unresolved IR shape. The caller that owns run state and secret lookup
 * resolves interpolation and secret references immediately before calling
 * {@link BrowserSession.perform}, so this port never receives either. The
 * separate secret-fill variant remains visible to drivers and tracers as a
 * do-not-log signal after materialization.
 */
export type PerformableAction =
  | { readonly type: 'click'; readonly target: ElementRef }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'press'; readonly target: ElementRef; readonly key: TracePress['key'] }
  | { readonly type: 'fill'; readonly target: ElementRef; readonly value: string }
  | { readonly type: 'fill-secret'; readonly target: ElementRef; readonly value: string };

/**
 * An assertion whose expected text has been materialized for the current run.
 *
 * As with {@link PerformableAction}, this is a local mirror rather than an IR
 * assertion: the caller resolves interpolated text before evaluating it. Its
 * branches retain targets only where the assertion semantics require an
 * element, avoiding an invented target for page-wide text and URL checks.
 */
export type AssertCheck =
  | { readonly check: 'text-visible'; readonly text: string }
  | { readonly check: 'element-visible'; readonly target: ElementRef }
  | { readonly check: 'text-equals'; readonly target: ElementRef; readonly text: string }
  | { readonly check: 'url-matches'; readonly pattern: string }
  | { readonly check: 'element-count'; readonly target: ElementRef; readonly count: number };

/**
 * The diagnosable result of evaluating an assertion.
 *
 * A failed assertion always carries an explanation, while a passing assertion
 * may include non-failure detail without being forced to do so.
 */
export type AssertOutcome =
  | { readonly passed: true; readonly message?: string }
  | { readonly passed: false; readonly message: string };

/**
 * The browser read strategy to use when capturing an element.
 *
 * Choosing a strategy is run-usecase policy because the IR capture step does
 * not prescribe one. Requiring it from the caller makes that choice explicit
 * and prevents this boundary from silently selecting a default.
 */
export type CaptureMode = 'text' | 'value';

/**
 * A live, launched browser session.
 *
 * Its action and assertion operations accept one structured argument because
 * each relevant branch already contains its target; a second target argument
 * would allow two conflicting descriptions of the same element.
 */
export interface BrowserSession {
  /**
   * Executes a fully materialized action.
   *
   * @param action - The action with resolved run and secret values.
   */
  perform(action: PerformableAction): Promise<void>;

  /**
   * Evaluates a fully materialized assertion.
   *
   * @param check - The assertion with any interpolated expected text resolved.
   * @returns A passing or diagnosable failing outcome.
   */
  evaluateAssert(check: AssertCheck): Promise<AssertOutcome>;

  /**
   * Reads an element using the caller-selected capture strategy.
   *
   * @param target - The element to read.
   * @param mode - The explicit text or value strategy to apply.
   * @returns The captured string, including an allowed empty value.
   */
  captureValue(target: ElementRef, mode: CaptureMode): Promise<string>;

  /**
   * Verifies that recorded grounding still identifies a current element.
   *
   * This is a Midscene-style hard gate rather than a Stagehand-style soft
   * wait: a mismatch must surface as a miss so stale grounding cannot be
   * mistaken for a match and cause a test to pass against the wrong element.
   *
   * @param ref - The recorded element reference to resolve.
   * @param fp - The recorded fingerprint to verify against the live page.
   * @returns A hit with the live reference or a reasoned miss.
   */
  resolveGrounded(
    ref: ElementRef,
    fp: Fingerprint,
  ): Promise<
    | { kind: 'hit'; ref: ElementRef }
    | { kind: 'miss'; reason: 'fingerprint-mismatch' | 'element-not-found' }
  >;

  /**
   * Captures the paired evidence used to resolve browser interactions.
   *
   * @returns The current serializable accessibility tree and screenshot.
   */
  snapshotForResolution(): Promise<PageSnapshot>;

  /**
   * Captures the current page image without prescribing persistence.
   *
   * @returns Screenshot bytes suitable for the caller's storage policy.
   */
  screenshot(): Promise<Uint8Array>;

  /**
   * Captures the current serializable accessibility representation.
   *
   * @returns The tree evidence used by resolution and diagnostics.
   */
  accessibilitySnapshot(): Promise<JsonValueT>;

  /**
   * Releases resources held by the browser session.
   */
  close(): Promise<void>;
}

/**
 * Launches sessions for one supported browser engine.
 *
 * Driver selection happens outside the port, allowing a single run to choose
 * the adapter matching its IR target without exposing adapter construction to
 * browser-session consumers.
 */
export interface BrowserDriver {
  /**
   * The engine this driver can launch.
   */
  readonly engine: BrowserEngine;

  /**
   * Starts a session for a validated target.
   *
   * @param target - The target that supplies the base URL and browser engine.
   * @returns A session owned by the caller, which must later close it.
   */
  launch(target: TargetDefinition): Promise<BrowserSession>;
}
