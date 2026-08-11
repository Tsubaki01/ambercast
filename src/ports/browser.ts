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
 * A browser engine that a target can select for a run.
 *
 * @remarks
 * Deriving this union from the target contract keeps target validation and
 * driver selection aligned as browser support grows.
 */
export type BrowserEngine = TargetDefinition['browser'];

/**
 * Paired browser evidence captured at the same point in a session.
 */
export type PageSnapshot = {
  /** A serializable accessibility-tree representation for inspection. */
  readonly accessibilityTree: JsonValueT;

  /** Raw screenshot bytes that callers can persist or attach to diagnostics. */
  readonly screenshot: Uint8Array;
};

/**
 * A browser action whose values are ready for direct execution.
 *
 * `fill-secret` identifies materialized secret data that drivers and tracers
 * must not log.
 *
 * @remarks
 * This deliberately mirrors, rather than reuses, the unresolved IR action
 * shape. The caller that owns run state and secret lookup resolves
 * interpolation and secret references immediately before calling
 * {@link BrowserSession.perform}, so this port never receives either.
 */
export type PerformableAction =
  | { readonly type: 'click'; readonly target: ElementRef }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'press'; readonly target: ElementRef; readonly key: TracePress['key'] }
  | { readonly type: 'fill'; readonly target: ElementRef; readonly value: string }
  | { readonly type: 'fill-secret'; readonly target: ElementRef; readonly value: string };

/**
 * An assertion check with expected values materialized for the current run.
 *
 * @remarks
 * This is a port-local mirror rather than an IR assertion because the caller
 * resolves interpolated text before evaluating it. Its branches contain a
 * target only where the assertion semantics need an element, so callers do
 * not invent one for page-wide text or URL checks.
 */
export type AssertCheck =
  | { readonly check: 'text-visible'; readonly text: string }
  | { readonly check: 'element-visible'; readonly target: ElementRef }
  | { readonly check: 'text-equals'; readonly target: ElementRef; readonly text: string }
  | { readonly check: 'url-matches'; readonly pattern: string }
  | { readonly check: 'element-count'; readonly target: ElementRef; readonly count: number };

/**
 * The result of evaluating an assertion check.
 *
 * A passing result may include supplemental detail; every failing result
 * includes a message suitable for diagnosis.
 *
 * @remarks
 * The discriminated shape prevents consumers from accidentally treating an
 * absent failure explanation as a successful assertion.
 */
export type AssertOutcome =
  | { readonly passed: true; readonly message?: string }
  | { readonly passed: false; readonly message: string };

/**
 * The content to read from an element during capture.
 *
 * @remarks
 * The IR capture step does not prescribe this choice. Requiring the caller to
 * choose it keeps future run-usecase policy explicit instead of letting this
 * boundary silently select a default.
 */
export type CaptureMode = 'text' | 'value';

/**
 * The result of checking whether recorded grounding still identifies an
 * element on the current page.
 *
 * A miss distinguishes absence, local-neighborhood drift, and duplicate
 * role-and-name candidates so callers can retain a safe control-flow gate
 * while diagnostics explain the actual resolution failure.
 */
export type GroundedResolution =
  | {
      /** The recorded reference remains valid for the current page. */
      readonly kind: 'hit';
      /** The live element reference confirmed by the check. */
      readonly ref: ElementRef;
    }
  | {
      /** The recorded grounding cannot be used for the current page. */
      readonly kind: 'miss';
      /**
       * Whether the unique candidate's neighborhood changed, no candidate
       * exists, or more than one normalized role-and-name candidate exists.
       */
      readonly reason: 'fingerprint-mismatch' | 'element-not-found' | 'ambiguous-match';
    };

/**
 * A live browser session owned by the caller until {@link close} resolves.
 */
export interface BrowserSession {
  /**
   * Executes a fully materialized action.
   *
   * @param action - The action with resolved run and secret values.
   * @returns Resolves after the action completes.
   * @throws If the browser cannot complete the action.
   */
  perform(action: PerformableAction): Promise<void>;

  /**
   * Evaluates a fully materialized assertion.
   *
   * A failed assertion is returned as an {@link AssertOutcome}; browser or
   * evaluation errors reject instead.
   *
   * @param check - The assertion with interpolated expected text resolved.
   * @returns A passing or diagnosable failing outcome.
   * @throws If the assertion cannot be evaluated.
   */
  evaluateAssert(check: AssertCheck): Promise<AssertOutcome>;

  /**
   * Reads an element using the caller-selected capture strategy.
   *
   * @param target - The element to read.
   * @param mode - Whether to read visible text or the element value.
   * @returns The captured string, which may be empty.
   * @throws If the element cannot be read.
   */
  captureValue(target: ElementRef, mode: CaptureMode): Promise<string>;

  /**
   * Checks whether recorded grounding still identifies a current element.
   *
   * No candidate always produces `element-not-found`, regardless of the
   * supplied fingerprint. Two or more candidates with the exact role and
   * normalized name produce `ambiguous-match`, even if one candidate's
   * neighborhood would hash to `fp`. A `fingerprint-mismatch` is returned
   * only when exactly one candidate exists but its current fingerprint differs
   * from `fp`.
   *
   * @param ref - The recorded element reference to resolve.
   * @param fp - The recorded fingerprint to verify against the live page.
   * @returns A confirmed reference or the reason it cannot be used.
   * @throws If the current page cannot be inspected.
   *
   * @remarks
   * This is a hard gate: every miss remains a miss so stale grounding or an
   * indeterminate duplicate cannot direct a test to the wrong element.
   */
  resolveGrounded(ref: ElementRef, fp: Fingerprint): Promise<GroundedResolution>;

  /**
   * Captures the accessibility tree and screenshot used for resolution.
   *
   * @returns Evidence captured from the current page.
   * @throws If either representation cannot be captured.
   */
  snapshotForResolution(): Promise<PageSnapshot>;

  /**
   * Captures the current page image without prescribing where it is stored.
   *
   * @returns Screenshot bytes for the caller's storage policy.
   * @throws If the screenshot cannot be captured.
   */
  screenshot(): Promise<Uint8Array>;

  /**
   * Captures the current serializable accessibility representation.
   *
   * @returns The tree evidence used by resolution and diagnostics.
   * @throws If the accessibility representation cannot be captured.
   */
  accessibilitySnapshot(): Promise<JsonValueT>;

  /**
   * Releases resources held by the session.
   *
   * @remarks
   * Implementations must treat a second call after closure as a safe no-op rather than an error.
   *
   * @throws If the underlying browser resources cannot be released.
   */
  close(): Promise<void>;
}

/**
 * Launches browser sessions for one supported engine.
 *
 * @remarks
 * Driver selection happens outside this port. That lets a run select the
 * adapter matching its IR target without exposing adapter construction to
 * browser-session consumers.
 */
export interface BrowserDriver {
  /** Identifies the engine this driver is selected to launch. */
  readonly engine: BrowserEngine;

  /**
   * Starts a session for a target that selects this driver's engine.
   *
   * @param target - The target that supplies the base URL and browser engine.
   * @returns A session the caller must later close.
   * @throws If the target cannot be launched.
   */
  launch(target: TargetDefinition): Promise<BrowserSession>;
}
