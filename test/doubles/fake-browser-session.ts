import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import type {
  AssertCheck,
  AssertOutcome,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  PageSnapshot,
  PerformableAction,
} from '../../src/ports/browser.js';

/**
 * The current state used to arrange one grounded element for a session fake.
 *
 * The fake derives the resolution result from this state instead of accepting
 * a precomputed verdict, so tests exercise the production-facing comparison
 * and not-found precedence rules.
 */
export interface FakeBrowserSessionEntry {
  readonly currentFingerprint: Fingerprint;
  readonly exists: boolean;
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
   * Ordered assertion outcomes for scenarios that model multiple observations.
   *
   * Supplying this list makes an exhausted script fail loudly instead of
   * silently repeating a result, so a test cannot accidentally omit a browser
   * observation while still receiving a plausible replay outcome.
   */
  readonly assertOutcomes?: readonly AssertOutcome[];
  readonly snapshot?: PageSnapshot;
  readonly onPerform?: (action: PerformableAction) => void;
  readonly onEvaluateAssert?: (check: AssertCheck) => void;
  /**
   * Observes the first successful `close` call.
   *
   * Closing is idempotent, so later calls are no-ops and never invoke this
   * hook again; shared teardown can therefore close safely without duplicate signals.
   */
  readonly onClose?: () => void;
}

/**
 * A browser-facing operation observed by the session fake.
 *
 * Resource cleanup is deliberately absent: tests use this log to prove that
 * replay's trust pre-scan performed no browser work, while every completed
 * session still receives its required `close()` call in production code.
 */
export type FakeBrowserSessionOperation =
  | { readonly type: 'perform'; readonly action: PerformableAction }
  | { readonly type: 'evaluate-assert'; readonly check: AssertCheck }
  | { readonly type: 'capture-value'; readonly target: ElementRef; readonly mode: CaptureMode }
  | { readonly type: 'resolve-grounded'; readonly target: ElementRef; readonly fingerprint: Fingerprint }
  | { readonly type: 'snapshot-for-resolution' };

/**
 * The public browser contract plus scenario-local operation inspection.
 */
export interface FakeBrowserSession extends BrowserSession {
  /** Returns a fresh copy of browser-facing work in the order it occurred. */
  operations(): readonly FakeBrowserSessionOperation[];
}

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

/**
 * Builds a deterministic browser-session double from current-page fixtures.
 *
 * The double keeps all state inside this factory and treats a missing element
 * as more informative than a fingerprint mismatch, matching the hard
 * grounding gate that protects callers from a wrong-element pass.
 *
 * @param entries - Current element state indexed by {@link elementRefKey}.
 * @param options - Optional scripted results and call-observation hooks.
 * @returns A browser session that follows the public port contract.
 */
export function createFakeBrowserSession(
  entries: ReadonlyMap<string, FakeBrowserSessionEntry>,
  options: FakeBrowserSessionOptions = {},
): FakeBrowserSession {
  const assertOutcome = options.assertOutcome ?? { passed: true };
  const snapshot = options.snapshot ?? {
    accessibilityTree: {},
    screenshot: new Uint8Array(),
  };
  let closed = false;
  let assertOutcomeIndex = 0;
  const operations: FakeBrowserSessionOperation[] = [];

  return {
    async perform(action): Promise<void> {
      operations.push({ type: 'perform', action });
      options.onPerform?.(action);
    },
    async evaluateAssert(check): Promise<AssertOutcome> {
      operations.push({ type: 'evaluate-assert', check });
      options.onEvaluateAssert?.(check);
      if (options.assertOutcomes === undefined) {
        return assertOutcome;
      }

      const outcome = options.assertOutcomes[assertOutcomeIndex];
      assertOutcomeIndex += 1;
      if (outcome === undefined) {
        throw new Error('No scripted assertion outcome remains.');
      }

      return outcome;
    },
    async captureValue(target: ElementRef, mode: CaptureMode): Promise<string> {
      operations.push({ type: 'capture-value', target, mode });
      return options.captureValues?.get(elementRefKey(target))?.[mode] ?? '';
    },
    async resolveGrounded(ref: ElementRef, fp: Fingerprint): Promise<GroundedResolution> {
      operations.push({ type: 'resolve-grounded', target: ref, fingerprint: fp });
      const entry = entries.get(elementRefKey(ref));
      if (entry === undefined || !entry.exists) {
        return { kind: 'miss', reason: 'element-not-found' };
      }

      if (!fingerprintsEqual(fp, entry.currentFingerprint)) {
        return { kind: 'miss', reason: 'fingerprint-mismatch' };
      }

      return { kind: 'hit', ref };
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      operations.push({ type: 'snapshot-for-resolution' });
      return snapshot;
    },
    async screenshot(): Promise<Uint8Array> {
      return snapshot.screenshot;
    },
    async accessibilitySnapshot() {
      return snapshot.accessibilityTree;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      options.onClose?.();
    },
    operations(): readonly FakeBrowserSessionOperation[] {
      return operations.map((operation) => ({ ...operation }));
    },
  };
}
