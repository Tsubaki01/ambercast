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
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';

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
 * Complete accessibility evidence used to decide whether a screenshot may be
 * retained.
 *
 * `tree` contains the identity-bearing values that the ARIA parser placed in
 * nodes. `scalarValues` contains YAML-decoded values that the parser
 * deliberately discarded or never placed in a node, while `rawYaml` retains
 * the renderer output as a backstop for evidence neither structured channel
 * recognizes.
 *
 * @remarks
 * These channels form one capture, rather than three independent browser
 * observations: implementations derive all of them from one `ariaSnapshot()`
 * call. That invariant prevents the channels from describing different DOM
 * instants, which would make a detection decision internally inconsistent.
 */
export type AccessibilityCapture = {
  /** The verbatim accessibility renderer output used only for detection. */
  readonly rawYaml: string;

  /**
   * The parsed, identity-bearing tree used by resolution and diagnostics.
   * Parse failure is represented structurally by the `SNAPSHOT_INVALID`
   * sentinel from the ARIA snapshot parser, rather than by rejecting this
   * capture, because `JsonValueT` alone cannot express that distinction.
   */
  readonly tree: JsonValueT;

  /** Decoded scalar evidence intentionally outside the identity-bearing tree. */
  readonly scalarValues: readonly string[];
};

/**
 * A lightweight, session-local continuity handle for a bound element.
 *
 * @remarks
 * `resolveGrounded` is the sole source of a `BoundElement`: it mints one only
 * after a stable accessibility capture confirms that exactly one element
 * matches the supplied {@link ElementRef} (and, in verify mode, that its
 * descriptor hashes to the expected {@link Fingerprint}). Every later
 * element-targeted operation accepts this handle instead of a bare
 * `ElementRef`, preserving session provenance, navigation generation, and
 * accessibility-fingerprint continuity rather than independently resolving a
 * locator at each call.
 *
 * The two fields are plain, serializable data — a `BoundElement` is safe to
 * log or include in a diagnostic without leaking anything beyond what the
 * plan and grounding cache already expose. That is deliberate: the
 * continuity checks this type represents do not live in these fields. They
 * live in adapter-private state, keyed by this object's identity, that
 * records which session minted it, at which navigation generation, and is
 * consulted — never these public fields — immediately before every operation
 * (see `perform`/`evaluateAssert`/`captureValue`). A caller that constructs a
 * look-alike `{ref, fingerprint}` object, or that passes a genuine
 * `BoundElement` to a different session instance than the one that minted
 * it, fails that private lookup and is rejected before any Playwright call.
 * At mint time, the adapter copies both `ref` and `fingerprint` into that
 * private record without sharing either value with this public object. A
 * caller's runtime mutation of either public value therefore cannot alter the
 * provenance, locator, or expected fingerprint that a later operation uses.
 *
 * A `BoundElement` is not a DOM node handle and cannot prove physical-node
 * identity. Its checks narrow, rather than eliminate, wrong-target risk: an
 * in-place replacement by another node with the same fingerprint before the
 * next re-verification is indistinguishable. The same residual interval
 * remains between a successful re-verification and the browser operation.
 *
 * The handle is inherently session-local and short-lived: it is never
 * persisted (grounding stores an `ElementRef` and a `Fingerprint`, not this
 * type) and it is not meaningful once the session that minted it has
 * navigated away from the observation it was minted against or has closed.
 */
export interface BoundElement {
  /** The accessibility locator this handle was bound against. */
  readonly ref: ElementRef;

  /**
   * The descriptor fingerprint captured at bind time, exposed for diagnostics
   * and grounding persistence. Operations re-verify the private record's copy
   * rather than consulting this public field.
   */
  readonly fingerprint: Fingerprint;
}

/**
 * A browser action whose values are ready for direct execution.
 *
 * @remarks
 * This deliberately mirrors, rather than reuses, the unresolved IR action
 * shape. The caller that owns run state and secret lookup resolves
 * interpolation immediately before calling {@link BrowserSession.perform},
 * so this port never receives unresolved run data. Secret values never flow
 * through this union or `perform()` at all: {@link BrowserSession.fillSecret}
 * is the sole port method that receives one and documents that security
 * boundary.
 * Every element-targeted variant carries a {@link BoundElement} rather than a
 * bare `ElementRef`: the caller obtained it from `resolveGrounded` (directly,
 * or via AI re-resolution followed by a confirming bind), so the operation
 * inherits its session, generation, and fingerprint continuity checks rather
 * than this port independently resolving an unverified locator. Those checks
 * narrow wrong-target risk; they do not make the handle a physical DOM-node
 * identity.
 */
export type PerformableAction =
  | { readonly type: 'click'; readonly target: BoundElement }
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'press'; readonly target: BoundElement; readonly key: TracePress['key'] }
  | { readonly type: 'fill'; readonly target: BoundElement; readonly value: string };

/**
 * An assertion check with expected values materialized for the current run.
 *
 * @remarks
 * This is a port-local mirror rather than an IR assertion because the caller
 * resolves interpolated text before evaluating it. Its branches contain a
 * target only where the assertion semantics need an element, so callers do
 * not invent one for page-wide text or URL checks.
 *
 * `element-visible` and `text-equals` carry a {@link BoundElement}, for the
 * same reason `PerformableAction`'s element-targeted variants do: each
 * preserves the session, generation, and fingerprint continuity of a
 * one-element binding, which narrows rather than eliminates wrong-target
 * risk. `element-count` deliberately keeps a bare `ElementRef` instead: it
 * counts every current role/name match on the page, which is structurally
 * incompatible with a `BoundElement`'s exactly-one-match precondition — an assertion whose
 * purpose is verifying a duplicate or absent count cannot itself require
 * singularity to run.
 */
export type AssertCheck =
  | { readonly check: 'text-visible'; readonly text: string }
  | { readonly check: 'element-visible'; readonly target: BoundElement }
  | { readonly check: 'text-equals'; readonly target: BoundElement; readonly text: string }
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
 * A request to bind an {@link ElementRef} against the current page.
 *
 * @remarks
 * `verify` mode checks a fingerprint the caller already has — from a
 * grounding cache hit, or from an earlier local classification the caller
 * wants continuity with (see the AI re-resolution confirmation bind) — against
 * one fresh capture. `compute` mode has no such fingerprint to check yet: it
 * derives one from the same fresh capture, applying the same duplicate- and
 * secret-taint rejection `computeAccessibilityFingerprint` already applies
 * for AI re-resolution, and mints a `BoundElement` from whatever unique match
 * results (unless the taint or duplicate gate rejects it first). Each bind
 * attempt uses one fresh capture and mints a handle only from an observation
 * whose navigation generation stayed stable. A `resolveGrounded` call may
 * retry a navigation race and therefore take up to three captures; no attempt
 * reuses a caller capture or adds a later capture before minting, which keeps
 * the handle tied to its stable observation.
 *
 * `resolveGrounded` is deliberately the only element-identity entry point:
 * routing both the "I already trust a fingerprint" and the "I need to derive
 * one" cases through one method, distinguished only by which query variant
 * the caller supplies, is what keeps trace replay, fresh agentic execution,
 * and AI re-resolution from growing separate, potentially divergent
 * resolution paths.
 */
export type GroundingQuery =
  | {
      /** Verify the current page against an already-known fingerprint. */
      readonly mode: 'verify';
      readonly fingerprint: Fingerprint;
    }
  | {
      /**
       * Derive a fingerprint from the current page, guarded by the same
       * secret-taint rejection generation-time computation uses.
       */
      readonly mode: 'compute';
      /**
       * Resolved secret values whose presence in the bound candidate's
       * descriptor must reject the bind. Passed through unchanged to
       * `computeAccessibilityFingerprint`; may be a single-use iterable and is
       * consumed at most once per call.
       */
      readonly resolvedSecrets: Iterable<ReadonlySet<string>>;
    };

/**
 * Reasons a current page cannot safely satisfy a grounding query.
 *
 * This is shared by the browser port's resolution result and every caller
 * that turns a miss into user-facing control flow, so adding a new reason
 * remains a single contract change.
 */
export type GroundingMissReason =
  | 'fingerprint-mismatch'
  | 'element-not-found'
  | 'ambiguous-match'
  | 'snapshot-invalid'
  | 'secret-contaminated';

/**
 * The result of binding an {@link ElementRef} against the current page.
 *
 * A miss distinguishes absent, invalid, changed, tainted, and duplicate
 * accessibility evidence so callers can retain a safe control-flow gate
 * while diagnostics explain the actual resolution failure.
 *
 * @remarks
 * `fingerprint-mismatch` can only occur for a `verify`-mode query (there is
 * no expected fingerprint to mismatch in `compute` mode) and
 * `secret-contaminated` can only occur for a `compute`-mode query (`verify`
 * mode never derives a fresh descriptor to taint-check — its known
 * fingerprint already passed that gate whenever it was originally computed).
 * This mode/reason correlation is a documented invariant of the
 * implementation, not something this type encodes structurally: two call
 * sites did not justify a query-keyed generic or overloaded result shape.
 */
export type GroundedResolution =
  | {
      /** The recorded reference remains valid for the current page. */
      readonly kind: 'hit';
      /** The live, session-local handle confirmed by this bind. */
      readonly element: BoundElement;
    }
  | {
      /** The recorded grounding cannot be used for the current page. */
      readonly kind: 'miss';
      /**
       * Whether an expected fingerprint no longer matches, the unique
       * candidate's neighborhood changed, no candidate exists, more than one
       * normalized role-and-name candidate exists, the parser rejected the
       * snapshot, or a resolved secret value contaminated the derived
       * descriptor.
       */
      readonly reason: GroundingMissReason;
    };

/**
 * A live browser session owned by the caller until {@link close} resolves.
 */
export interface BrowserSession {
  /**
   * Executes a fully materialized action.
   *
   * @param action - The action with resolved run values and a
   *   {@link BoundElement} target for every element-targeted variant.
   * @returns Resolves after the action completes.
   * @throws If the browser cannot complete the action, including when the
   *   action's `BoundElement` fails its operation-immediate re-verification
   *   (see {@link resolveGrounded}) — a plain, reason-bearing error, not a
   *   classified `AmbercastError`, matching this port's existing convention
   *   of leaving browser-rejection classification to the caller.
   */
  perform(action: PerformableAction): Promise<void>;

  /**
   * Writes a materialized secret value to an already-bound page element.
   *
   * @remarks
   * This is the only port method permitted to receive a secret value. The
   * caller resolves `policy` once and supplies it unchanged; implementations
   * never recompute it. Implementations check the current page origin against
   * that policy at three checkpoints: before continuity re-verification, when
   * continuity re-verification rejects, and synchronously immediately before
   * the underlying fill. The first checkpoint preserves the integrity failure
   * when a navigation changes both origin and generation. After a continuity
   * failure, the origin check replaces that error only if the origin is now
   * unsound; otherwise the original continuity error propagates unchanged.
   * A fully synchronous implementation whose continuity re-verification has no
   * asynchronous or callback boundary may omit the reclassification checkpoint:
   * no origin mutation can interleave for its catch to observe, so its pre-check
   * and final pre-fill check suffice, as in the fake test double in
   * `test/doubles/fake-browser-session.ts`.
   * No additional `await` sits between that post-failure origin re-check and
   * the final pre-fill check, nor between that final check and the fill,
   * applying operation-immediate re-verification to origin just as
   * `BoundElement` continuity applies it to staleness.
   *
   * Origin and `BoundElement` continuity are independent layers: the latter
   * remains the ordinary failure documented by {@link resolveGrounded}, while
   * a rejected origin propagates as an integrity violation. Unlike other
   * targeted port operations, every implementation uses the classified error
   * required below for this origin-specific path.
   *
   * This closes the JavaScript-visible asynchronous gap but cannot make origin
   * inspection and the browser's DOM mutation atomic in the renderer process.
   * A navigation can still land after the browser receives the fill and before
   * the renderer executes it; that residual TOCTOU interval is outside what
   * this port can observe or close.
   *
   * @param target - The session-local element to receive the secret.
   * @param value - The materialized secret value, which implementations must not expose.
   * @param policy - The already-resolved secret-sink policy for `value`.
   * @returns Resolves after the browser fill completes.
   * @throws A plain, reason-bearing `Error` when `target` fails
   *   operation-immediate continuity re-verification and the post-failure
   *   origin re-check finds the origin still sound.
   * @throws {IntegrityViolationError} When any of the three
   *   operation-immediate origin checkpoints rejects the page.
   *   Implementations preserve this exact class so replay preserves the
   *   integrity failure instead of treating it as a behavioral miss eligible
   *   for agentic fallback.
   */
  fillSecret(target: BoundElement, value: string, policy: SecretSinkPolicy): Promise<void>;

  /**
   * Returns the browser's current page URL.
   *
   * Callers use this before resolving a secret to evaluate its sink policy,
   * while implementations independently re-read their live page URL
   * immediately before a secret fill. It is unrelated to the `url-matches`
   * assertion, which compares materialized text rather than supplying an
   * origin-policy input.
   *
   * @returns The browser's current page URL.
   */
  currentUrl(): Promise<string>;

  /**
   * Evaluates a fully materialized assertion.
   *
   * A failed assertion is returned as an {@link AssertOutcome}; browser or
   * evaluation errors reject instead.
   *
   * @param check - The assertion with interpolated expected text resolved,
   *   and a {@link BoundElement} target for `element-visible`/`text-equals`.
   * @returns A passing or diagnosable failing outcome.
   * @throws If the assertion cannot be evaluated, including a targeted
   *   check's `BoundElement` failing its operation-immediate re-verification.
   */
  evaluateAssert(check: AssertCheck): Promise<AssertOutcome>;

  /**
   * Reads an element using the caller-selected capture strategy.
   *
   * @param target - The already-bound element to read.
   * @param mode - Whether to read visible text or the element value.
   * @returns The captured string, which may be empty.
   * @throws If the element cannot be read, including `target` failing its
   *   operation-immediate re-verification.
   */
  captureValue(target: BoundElement, mode: CaptureMode): Promise<string>;

  /**
   * Binds an {@link ElementRef} against the current page, verifying an
   * already-known fingerprint or deriving one, per the supplied
   * {@link GroundingQuery}.
   *
   * The result preserves why a miss occurred. Duplicate candidates remain
   * unusable even when one has the expected neighborhood, because no
   * fingerprint can make a role/name locator retain which physical duplicate
   * it identified — see {@link GroundedResolution}.
   *
   * @param ref - The element reference to resolve.
   * @param query - Whether to verify a known fingerprint or derive one.
   * @returns A confirmed, live {@link BoundElement} or the reason binding
   *   failed.
   * @throws If the current page cannot be inspected.
   *
   * @remarks
   * This is a hard gate: every miss remains a miss, limiting stale grounding
   * and ambiguous evidence from widening wrong-target risk. Each attempt
   * takes one fresh accessibility capture and mints a handle only from a
   * stable generation. Implementations may retry a navigation race, so one
   * call can take up to three captures; it never mints from an observation
   * that straddled a navigation. This continuity check does not make the
   * resulting handle a physical DOM-node identity — see {@link BoundElement}.
   */
  resolveGrounded(ref: ElementRef, query: GroundingQuery): Promise<GroundedResolution>;

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
   * Captures the full accessibility evidence used for detection.
   *
   * `rawYaml` and `scalarValues` support screenshot-retention detection only
   * and must never be forwarded to AI, report, grounding, or log paths.
   *
   * @remarks
   * Architecture tests mechanically enforce the detection-only boundary.
   *
   * @returns One same-instant accessibility capture, including the parsed tree
   *   used by resolution and diagnostics.
   * @throws If the accessibility representation cannot be captured.
   */
  accessibilitySnapshot(): Promise<AccessibilityCapture>;

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
