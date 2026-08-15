import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { isAllowedSecretSinkOrigin, type SecretSinkPolicy } from '#core/secrets/sink-policy.js';
import type {
  AssertCheck,
  AssertOutcome,
  AccessibilityCapture,
  BoundElement,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  GroundingQuery,
  PageSnapshot,
  PerformableAction,
} from '../../src/ports/browser.js';

type VerifyMissReason = Exclude<Extract<GroundedResolution, { readonly kind: 'miss' }>['reason'], 'secret-contaminated'>;
type ComputeMissReason = Exclude<Extract<GroundedResolution, { readonly kind: 'miss' }>['reason'], 'fingerprint-mismatch'>;

/**
 * The current state used to arrange one grounded element for a session fake.
 *
 * A test may script evidence failures that the fake cannot derive from its
 * compact descriptor fixture. Ordinary presence and fingerprint checks remain
 * modeled statefully, so a scripted result never turns binding or later use
 * into an unconditional success path.
 */
export interface FakeBrowserSessionEntry {
  currentFingerprint: Fingerprint;
  exists: boolean;
  readonly scriptedMissReasons?: {
    readonly verify?: VerifyMissReason;
    readonly compute?: ComputeMissReason;
  };
}

/**
 * Scripted browser results and observation hooks for one fake session.
 *
 * Capture values are keyed by {@link elementRefKey}, which allows a test to
 * use equivalent element-reference objects without depending on object
 * identity. An absent scripted capture deliberately reads as an empty string
 * so shape-oriented contracts can use an otherwise unconfigured session.
 */
export interface FakeBrowserSessionOptions {
  readonly captureValues?: ReadonlyMap<string, { readonly text: string; readonly value: string }>;
  readonly assertOutcome?: AssertOutcome;
  /**
   * Base URL used as `new URL(navigateUrl, baseUrl)` for each fake navigation.
   *
   * An omitted value is `about:blank`, so a relative navigation fails loudly
   * instead of acquiring a fabricated origin. Supplying the target's launch
   * base URL mirrors Chromium's context-level relative-URL resolution.
   */
  readonly baseUrl?: string;
  /** Current page URL; an omitted value starts at Chromium's `about:blank`. */
  readonly currentUrl?: string;
  /**
   * Ordered assertion outcomes for scenarios that model multiple observations.
   *
   * Supplying this list makes an exhausted script fail loudly instead of
   * silently repeating a result, so a test cannot accidentally omit a browser
   * observation while still receiving a plausible replay outcome.
   */
  readonly assertOutcomes?: readonly AssertOutcome[];
  /**
   * Detection-only capture channels scripted independently of parsed tree
   * evidence. Neutral defaults keep fixtures free of
   * secret-detection content unless a test explicitly requests it.
   */
  readonly accessibilityCapture?: Partial<Pick<AccessibilityCapture, 'rawYaml' | 'scalarValues'>>;
  readonly snapshot?: PageSnapshot;
  readonly onPerform?: (action: PerformableAction) => void;
  /** Observes a successful secret-fill operation after the fake's gates pass. */
  readonly onFillSecret?: (action: FakeFillSecretOperation) => void;
  readonly onEvaluateAssert?: (check: AssertCheck) => void;
  /**
   * Observes the first successful `close` call.
   *
   * Closing is idempotent, so later calls are no-ops and never invoke this
   * hook again; shared teardown can therefore close safely without duplicate signals.
   */
  readonly onClose?: () => void;
}

/** A successful secret-fill operation observed by the fake browser session. */
export type FakeFillSecretOperation = {
  readonly type: 'fill-secret';
  readonly target: BoundElement;
  readonly value: string;
  readonly policy: SecretSinkPolicy;
};

/**
 * A browser-facing operation observed by the session fake.
 *
 * Rejected targeted operations are intentionally absent: callers use this
 * trace to prove that provenance and staleness checks stop work before it can
 * reach the browser-facing operation boundary.
 */
export type FakeBrowserSessionOperation =
  | { readonly type: 'perform'; readonly action: PerformableAction }
  | FakeFillSecretOperation
  | { readonly type: 'evaluate-assert'; readonly check: AssertCheck }
  | { readonly type: 'capture-value'; readonly target: BoundElement; readonly mode: CaptureMode }
  | { readonly type: 'resolve-grounded'; readonly target: ElementRef; readonly query: GroundingQuery }
  | { readonly type: 'snapshot-for-resolution' };

/**
 * The public browser contract plus scenario-local operation inspection.
 */
export interface FakeBrowserSession extends BrowserSession {
  /** Returns a fresh copy of browser-facing work in the order it occurred. */
  operations(): readonly FakeBrowserSessionOperation[];
}

/**
 * The browser-boundary work observed by the fake after provenance validation.
 *
 * These counters model the three calls that a real targeted operation must
 * keep behind provenance validation. Contract tests use them to prove that a
 * fabricated or foreign handle cannot even start evidence capture, locator
 * construction, or its final browser operation.
 */
export interface FakeBrowserSessionOperationObservation {
  readonly ariaSnapshotCalls: number;
  readonly roleLocatorCalls: number;
  readonly finalOperationCalls: number;
}

type FakeBindingRecord = {
  readonly generation: number;
  readonly ref: ElementRef;
  readonly fingerprint: Fingerprint;
};

type FakeBrowserSessionState = {
  readonly entries: Map<string, FakeBrowserSessionEntry>;
  readonly bindings: WeakMap<BoundElement, FakeBindingRecord>;
  readonly operations: FakeBrowserSessionOperation[];
  generation: number;
  currentUrl: string;
  closed: boolean;
  assertOutcomeIndex: number;
  ariaSnapshotCalls: number;
  roleLocatorCalls: number;
  finalOperationCalls: number;
};

const sessionStates = new WeakMap<FakeBrowserSession, FakeBrowserSessionState>();

/**
 * Encoders remain exhaustive as the IR gains element-reference strategies.
 *
 * A JSON array preserves field boundaries even when accessibility names
 * contain punctuation that would make a delimiter-based key ambiguous.
 */
const elementRefKeyEncoders = {
  accessibility: (ref: ElementRef): string => JSON.stringify([ref.strategy, ref.role, ref.name]),
} satisfies Record<ElementRef['strategy'], (ref: ElementRef) => string>;

const fingerprintComparisons = {
  algorithm: (left: Fingerprint, right: Fingerprint): boolean => left.algorithm === right.algorithm,
  hash: (left: Fingerprint, right: Fingerprint): boolean => left.hash === right.hash,
} satisfies Record<keyof Fingerprint, (left: Fingerprint, right: Fingerprint) => boolean>;

/**
 * Creates the structural lookup key shared by fake grounding and capture data.
 *
 * @param ref - The element reference whose fields identify the fixture entry.
 * @returns A collision-safe key for the reference's declared strategy.
 */
export function elementRefKey(ref: ElementRef): string {
  switch (ref.strategy) {
    case 'accessibility':
      return elementRefKeyEncoders.accessibility(ref);
  }

  throw new Error('unsupported element reference strategy');
}

/**
 * Compares every persisted fingerprint field rather than object identity.
 *
 * The exhaustive comparison table makes a fingerprint-schema addition fail to
 * compile here until its equality semantics are explicitly chosen.
 *
 * @param left - One recorded or current fingerprint.
 * @param right - The other fingerprint to compare.
 * @returns Whether the algorithm and hash agree exactly.
 */
export function fingerprintsEqual(left: Fingerprint, right: Fingerprint): boolean {
  return Object.values(fingerprintComparisons).every((compare) => compare(left, right));
}

function copyRef(ref: ElementRef): ElementRef {
  return { ...ref };
}

function copyFingerprint(fingerprint: Fingerprint): Fingerprint {
  return { ...fingerprint };
}

function mintBoundElement(
  state: FakeBrowserSessionState,
  ref: ElementRef,
  fingerprint: Fingerprint,
): BoundElement {
  const record: FakeBindingRecord = {
    generation: state.generation,
    ref: copyRef(ref),
    fingerprint: copyFingerprint(fingerprint),
  };
  const element: BoundElement = {
    ref: copyRef(ref),
    fingerprint: copyFingerprint(fingerprint),
  };
  state.bindings.set(element, record);
  return element;
}

/*
 * This fixture-level taint check deliberately compares only the requested
 * descriptor fields as literal, case-sensitive, whitespace-preserving text.
 * Production normalizes accessible names and also examines the target's
 * neighborhood, so tests that depend on either richer behavior must script a
 * `secret-contaminated` miss instead of treating this approximation as browser
 * evidence.
 */
function computeDescriptorContainsResolvedSecret(ref: ElementRef, query: GroundingQuery): boolean {
  if (query.mode !== 'compute') {
    return false;
  }

  for (const values of query.resolvedSecrets) {
    for (const secret of values) {
      if (secret === '') {
        continue;
      }

      if (ref.role === secret || ref.name === secret) {
        return true;
      }
      if (secret.length >= 3 && (ref.role.includes(secret) || ref.name.includes(secret))) {
        return true;
      }
    }
  }

  return false;
}

function resolveBinding(
  state: FakeBrowserSessionState,
  ref: ElementRef,
  query: GroundingQuery,
): GroundedResolution {
  const entry = state.entries.get(elementRefKey(ref));
  if (entry === undefined || !entry.exists) {
    return { kind: 'miss', reason: 'element-not-found' };
  }

  const scriptedReason = entry.scriptedMissReasons?.[query.mode];
  if (scriptedReason !== undefined) {
    return { kind: 'miss', reason: scriptedReason };
  }

  if (computeDescriptorContainsResolvedSecret(ref, query)) {
    return { kind: 'miss', reason: 'secret-contaminated' };
  }

  if (query.mode === 'verify') {
    if (!fingerprintsEqual(query.fingerprint, entry.currentFingerprint)) {
      return { kind: 'miss', reason: 'fingerprint-mismatch' };
    }

    return {
      kind: 'hit',
      element: mintBoundElement(state, ref, entry.currentFingerprint),
    };
  }

  return {
    kind: 'hit',
    element: mintBoundElement(state, ref, entry.currentFingerprint),
  };
}

function requireCurrentBinding(state: FakeBrowserSessionState, element: BoundElement): FakeBindingRecord {
  const record = state.bindings.get(element);
  if (record === undefined) {
    throw new Error('Bound element provenance is invalid for this browser session.');
  }

  state.ariaSnapshotCalls += 1;

  if (record.generation !== state.generation) {
    throw new Error('Bound element navigation generation is stale.');
  }

  const entry = state.entries.get(elementRefKey(record.ref));
  if (entry === undefined || !entry.exists) {
    throw new Error('Bound element no longer exists on the current page.');
  }

  if (!fingerprintsEqual(record.fingerprint, entry.currentFingerprint)) {
    throw new Error('Bound element fingerprint no longer matches the current descriptor.');
  }

  return record;
}

/**
 * Mints a fake-session handle synchronously for a test that is not exercising
 * asynchronous bind control flow itself.
 *
 * The factory uses the same presence, scripted-evidence, and fingerprint
 * validation as `resolveGrounded`; it only omits that method's asynchronous
 * boundary and operation-log entry. The returned handle is registered in the
 * supplied fake session's private provenance registry, so later operations
 * perform the same generation and descriptor checks as a normally resolved
 * handle.
 *
 * @param session - The fake session that will own the returned handle.
 * @param ref - The current accessibility reference to bind.
 * @param fingerprint - An optional expected descriptor; omitting it selects
 *   compute-mode validation.
 * @returns A session-local handle that passed the equivalent fake bind check.
 * @throws If the arranged fake evidence cannot bind this reference.
 */
export function bindForTest(
  session: FakeBrowserSession,
  ref: ElementRef,
  fingerprint?: Fingerprint,
): BoundElement {
  const state = sessionStates.get(session);
  if (state === undefined) {
    throw new Error('bindForTest requires a session created by createFakeBrowserSession.');
  }

  const query: GroundingQuery = fingerprint === undefined
    ? { mode: 'compute', resolvedSecrets: [] }
    : { mode: 'verify', fingerprint };
  const result = resolveBinding(state, ref, query);
  if (result.kind === 'miss') {
    throw new Error(`Fake binding failed: ${result.reason}`);
  }

  return result.element;
}

/**
 * Returns the fake's current browser-boundary counters without exposing its
 * mutable session state. The counters intentionally distinguish validation
 * work from a final action so contracts can detect a provenance rejection
 * implemented too late in an adapter.
 */
export function operationObservation(
  session: FakeBrowserSession,
): FakeBrowserSessionOperationObservation {
  const state = sessionStates.get(session);
  if (state === undefined) {
    throw new Error('operationObservation requires a session created by createFakeBrowserSession.');
  }

  return {
    ariaSnapshotCalls: state.ariaSnapshotCalls,
    roleLocatorCalls: state.roleLocatorCalls,
    finalOperationCalls: state.finalOperationCalls,
  };
}

/**
 * Changes only a fake session's current URL.
 *
 * Keeping URL mutation independent from generation lets a test isolate an
 * origin re-check from bound-element continuity. A fake `navigate` changes
 * both fields separately to model the real navigation race that invalidates a
 * browser binding as well as changing its URL.
 *
 * @param session - The fake session whose page URL changes.
 * @param url - The new current URL without a simulated navigation event.
 * @throws If `session` did not originate from {@link createFakeBrowserSession}.
 */
export function setFakeCurrentUrl(session: FakeBrowserSession, url: string): void {
  const state = sessionStates.get(session);
  if (state === undefined) {
    throw new Error('setFakeCurrentUrl requires a session created by createFakeBrowserSession.');
  }

  state.currentUrl = url;
}

/**
 * Builds a deterministic browser-session double from current-page fixtures.
 *
 * The double keeps all state inside this factory and treats a missing element
 * as more informative than a fingerprint mismatch, matching the hard
 * grounding gate that protects callers from a wrong-element pass. Unlike a
 * passive recorder, it records session-local handles and revalidates their
 * private provenance, navigation generation, and current descriptor before
 * every targeted operation.
 *
 * @param entries - Mutable current element state indexed by {@link elementRefKey}.
 * @param options - Optional scripted results and call-observation hooks.
 * @returns A browser session that follows the public port contract.
 */
export function createFakeBrowserSession(
  entries: Map<string, FakeBrowserSessionEntry>,
  options: FakeBrowserSessionOptions = {},
): FakeBrowserSession {
  const assertOutcome = options.assertOutcome ?? { passed: true };
  const baseUrl = options.baseUrl ?? 'about:blank';
  const snapshot = options.snapshot ?? {
    accessibilityTree: {},
    screenshot: new Uint8Array(),
  };
  const state: FakeBrowserSessionState = {
    entries,
    bindings: new WeakMap(),
    operations: [],
    generation: 0,
    // Chromium starts a newly created page at about:blank, so omitted test setup fails closed.
    currentUrl: options.currentUrl ?? 'about:blank',
    closed: false,
    assertOutcomeIndex: 0,
    ariaSnapshotCalls: 0,
    roleLocatorCalls: 0,
    finalOperationCalls: 0,
  };

  const session: FakeBrowserSession = {
    async perform(action): Promise<void> {
      switch (action.type) {
        case 'navigate':
          state.operations.push({ type: 'perform', action });
          options.onPerform?.(action);
          state.generation += 1;
          state.currentUrl = new URL(action.url, baseUrl).toString();
          return;
        case 'click':
        case 'press':
        case 'fill':
          requireCurrentBinding(state, action.target);
          state.roleLocatorCalls += 1;
          state.finalOperationCalls += 1;
          state.operations.push({ type: 'perform', action });
          options.onPerform?.(action);
          return;
      }
    },
    /**
     * Fills a bound fake element with a materialized secret value.
     *
     * @remarks
     * The fake uses the adapter's origin-before-continuity ordering so
     * usecase tests exercise the same race classification. A rejected origin
     * reports policy diagnostics but never `value`; a real cross-origin
     * navigation also changes generation, so continuity first would mask that
     * integrity failure as ordinary staleness.
     *
     * @param target - The fake-session-bound element to receive the secret.
     * @param value - The materialized secret value, which diagnostics must not expose.
     * @param policy - The already-resolved policy that authorizes `value`.
     * @returns Resolves after the fake records a successful secret fill.
     * @throws {IntegrityViolationError} When the current origin is disallowed.
     * @throws A plain, reason-bearing `Error` when `target` fails continuity verification.
     */
    async fillSecret(
      target: BoundElement,
      value: string,
      policy: SecretSinkPolicy,
    ): Promise<void> {
      if (!isAllowedSecretSinkOrigin(policy, state.currentUrl)) {
        throw new IntegrityViolationError('The current page origin is not allowed to receive this secret.', {
          secretRef: policy.secretRef,
          allowedOrigins: policy.allowedOrigins,
          source: policy.source,
        });
      }

      requireCurrentBinding(state, target);
      state.roleLocatorCalls += 1;
      state.finalOperationCalls += 1;
      const action = { type: 'fill-secret' as const, target, value, policy };
      state.operations.push(action);
      options.onFillSecret?.(action);
    },
    async currentUrl(): Promise<string> {
      return state.currentUrl;
    },
    async evaluateAssert(check): Promise<AssertOutcome> {
      switch (check.check) {
        case 'element-visible':
        case 'text-equals':
          requireCurrentBinding(state, check.target);
          state.roleLocatorCalls += 1;
          state.finalOperationCalls += 1;
          break;
        case 'text-visible':
        case 'url-matches':
        case 'element-count':
          break;
      }

      state.operations.push({ type: 'evaluate-assert', check });
      options.onEvaluateAssert?.(check);
      if (options.assertOutcomes === undefined) {
        return assertOutcome;
      }

      const outcome = options.assertOutcomes[state.assertOutcomeIndex];
      state.assertOutcomeIndex += 1;
      if (outcome === undefined) {
        throw new Error('No scripted assertion outcome remains.');
      }

      return outcome;
    },
    async captureValue(target: BoundElement, mode: CaptureMode): Promise<string> {
      const record = requireCurrentBinding(state, target);
      state.roleLocatorCalls += 1;
      state.finalOperationCalls += 1;
      state.operations.push({ type: 'capture-value', target, mode });
      return options.captureValues?.get(elementRefKey(record.ref))?.[mode] ?? '';
    },
    async resolveGrounded(ref: ElementRef, query: GroundingQuery): Promise<GroundedResolution> {
      state.operations.push({ type: 'resolve-grounded', target: ref, query });
      return resolveBinding(state, ref, query);
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      state.operations.push({ type: 'snapshot-for-resolution' });
      return snapshot;
    },
    async screenshot(): Promise<Uint8Array> {
      return snapshot.screenshot;
    },
    async accessibilitySnapshot(): Promise<AccessibilityCapture> {
      return {
        rawYaml: options.accessibilityCapture?.rawYaml ?? '',
        tree: snapshot.accessibilityTree,
        scalarValues: options.accessibilityCapture?.scalarValues ?? [],
      };
    },
    async close(): Promise<void> {
      if (state.closed) {
        return;
      }

      state.closed = true;
      options.onClose?.();
    },
    operations(): readonly FakeBrowserSessionOperation[] {
      return state.operations.map((operation) => ({ ...operation }));
    },
  };

  sessionStates.set(session, state);
  return session;
}
