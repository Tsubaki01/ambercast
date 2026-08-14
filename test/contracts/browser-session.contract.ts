import { describe, expect, it } from 'vitest';
import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import type { BoundElement, BrowserSession, GroundingMissReason } from '../../src/ports/browser.js';

export type BrowserSessionContractScenario =
  | 'normal'
  | 'missing'
  | 'ambiguous'
  | 'snapshot-invalid'
  | 'descriptor-mutable';

export interface BrowserSessionContractSetup {
  readonly ref: ElementRef;
  readonly currentFingerprint: Fingerprint;
  readonly exists: boolean;
  readonly scenario?: BrowserSessionContractScenario;
}

export interface BrowserSessionOperationObservation {
  readonly ariaSnapshotCalls: number;
  readonly roleLocatorCalls: number;
  readonly finalOperationCalls: number;
}

type TargetedOperation = {
  readonly description: string;
  invoke(session: BrowserSession, element: BoundElement): Promise<unknown>;
};

export interface BrowserSessionContractHarness {
  createSession(setup: BrowserSessionContractSetup): BrowserSession | Promise<BrowserSession>;
  /**
   * Supplies a reachable same-descriptor page for the public navigate action.
   *
   * Navigation invalidation is a shared port behavior, so this remains a
   * harness-owned fixture choice rather than an external URL assumption.
   */
  navigationUrl(setup: BrowserSessionContractSetup): string;
  actualFingerprintFor?(session: BrowserSession, setup: BrowserSessionContractSetup): Fingerprint | Promise<Fingerprint>;
  /**
   * Declares evidence misses a harness can arrange faithfully. The fake
   * supports every reason; a real browser may not manufacture parser-invalid
   * Playwright output, so its dedicated adapter unit suite covers that seam.
   */
  readonly supportedGroundingMissReasons?: readonly GroundingMissReason[];
  /**
   * Makes the current descriptor differ without triggering a navigation.
   *
   * The hook is deliberately adapter-owned: the fake updates its fixture Map,
   * while Chromium drives the fixture's ordinary Mutate control through the
   * public browser port.
   */
  invalidateDescriptor?(session: BrowserSession, setup: BrowserSessionContractSetup): Promise<void>;
  /**
   * Observes the three browser-boundary stages guarded by element provenance.
   *
   * This is required rather than best-effort so fabricated and cross-session
   * handles cannot pass their contract tests through a generic stub throw.
   */
  operationObservation(session: BrowserSession): BrowserSessionOperationObservation;
  dispose?(): void | Promise<void>;
}

const REF: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const MATCHING_FINGERPRINT: Fingerprint = {
  algorithm: 'a11y-neighborhood-v2',
  hash: 'a'.repeat(64),
};

const TARGETED_OPERATIONS: readonly TargetedOperation[] = [
  {
    description: 'perform',
    invoke: (session, element) => session.perform({ type: 'click', target: element }),
  },
  {
    description: 'element-visible assertion',
    invoke: (session, element) => session.evaluateAssert({ check: 'element-visible', target: element }),
  },
  {
    description: 'text-equals assertion',
    invoke: (session, element) => session.evaluateAssert({ check: 'text-equals', target: element, text: 'Submit' }),
  },
  {
    description: 'captureValue',
    invoke: (session, element) => session.captureValue(element, 'text'),
  },
];

async function actualFingerprintFor(
  harness: BrowserSessionContractHarness,
  session: BrowserSession,
  setup: BrowserSessionContractSetup,
): Promise<Fingerprint> {
  if (harness.actualFingerprintFor === undefined) {
    return setup.currentFingerprint;
  }

  return harness.actualFingerprintFor(session, setup);
}

export function fingerprintWithFlippedLeadingHexCharacter(fingerprint: Fingerprint): Fingerprint {
  const replacement = fingerprint.hash[0] === '0' ? '1' : '0';

  return { ...fingerprint, hash: `${replacement}${fingerprint.hash.slice(1)}` };
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Object.values(value).every(isJsonValue);
  }

  return false;
}

function supportsMiss(harness: BrowserSessionContractHarness, reason: GroundingMissReason): boolean {
  return harness.supportedGroundingMissReasons?.includes(reason)
    ?? (reason === 'fingerprint-mismatch' || reason === 'element-not-found');
}

async function withSession(
  harness: BrowserSessionContractHarness,
  setup: BrowserSessionContractSetup,
  assertion: (session: BrowserSession) => Promise<void>,
): Promise<void> {
  let session: BrowserSession | undefined;

  try {
    session = await harness.createSession(setup);
    await assertion(session);
  } finally {
    try {
      await session?.close();
    } finally {
      await harness.dispose?.();
    }
  }
}

async function bind(
  harness: BrowserSessionContractHarness,
  session: BrowserSession,
  setup: BrowserSessionContractSetup,
): Promise<BoundElement> {
  const result = await session.resolveGrounded(setup.ref, {
    mode: 'verify',
    fingerprint: await actualFingerprintFor(harness, session, setup),
  });
  if (result.kind === 'miss') {
    throw new Error(`Contract fixture could not bind ${setup.ref.role} "${setup.ref.name}": ${result.reason}`);
  }

  return result.element;
}

async function expectRejectedWithoutBrowserWork(
  harness: BrowserSessionContractHarness,
  session: BrowserSession,
  operation: TargetedOperation,
  element: BoundElement,
  reason: 'provenance' | 'navigation' | 'fingerprint',
): Promise<void> {
  const before = harness.operationObservation(session);
  const messageMatcher = {
    provenance: /provenance.*browser session/i,
    navigation: /navigation generation is stale/i,
    fingerprint: /fingerprint (?:verification failed|no longer matches)/i,
  }[reason];
  await expect(operation.invoke(session, element)).rejects.toThrow(messageMatcher);
  const after = harness.operationObservation(session);
  expect(after.roleLocatorCalls).toBe(before.roleLocatorCalls);
  expect(after.finalOperationCalls).toBe(before.finalOperationCalls);
  if (reason === 'provenance') {
    expect(after.ariaSnapshotCalls).toBe(before.ariaSnapshotCalls);
  }
}

export function registerBrowserSessionContract(harness: BrowserSessionContractHarness): void {
  describe('BrowserSession contract', () => {
    it('binds a matching verify query and derives the current fingerprint for a compute query', async () => {
      const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

      await withSession(harness, setup, async (session) => {
        const expected = await actualFingerprintFor(harness, session, setup);
        await expect(session.resolveGrounded(REF, {
          mode: 'verify',
          fingerprint: expected,
        })).resolves.toEqual({
          kind: 'hit',
          element: expect.objectContaining({ ref: REF, fingerprint: expected }),
        });
        await expect(session.resolveGrounded(REF, {
          mode: 'compute',
          resolvedSecrets: [],
        })).resolves.toEqual({
          kind: 'hit',
          element: expect.objectContaining({ ref: REF, fingerprint: expected }),
        });
      });
    });

    if (supportsMiss(harness, 'fingerprint-mismatch')) {
      it('reports fingerprint-mismatch only from a verify query against an existing descriptor', async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

        await withSession(harness, setup, async (session) => {
          await expect(session.resolveGrounded(REF, {
            mode: 'verify',
            fingerprint: fingerprintWithFlippedLeadingHexCharacter(await actualFingerprintFor(harness, session, setup)),
          })).resolves.toEqual({ kind: 'miss', reason: 'fingerprint-mismatch' });
        });
      });
    }

    const evidenceMisses: readonly {
      readonly reason: Exclude<GroundingMissReason, 'fingerprint-mismatch' | 'secret-contaminated'>;
      readonly scenario: BrowserSessionContractScenario;
    }[] = [
      { reason: 'element-not-found', scenario: 'missing' },
      { reason: 'ambiguous-match', scenario: 'ambiguous' },
      { reason: 'snapshot-invalid', scenario: 'snapshot-invalid' },
    ];

    for (const { reason, scenario } of evidenceMisses) {
      if (!supportsMiss(harness, reason)) {
        continue;
      }

      it(`reports ${reason} from both query modes when ${scenario} evidence is arranged`, async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: scenario !== 'missing', scenario };

        await withSession(harness, setup, async (session) => {
          await expect(session.resolveGrounded(REF, {
            mode: 'verify',
            fingerprint: await actualFingerprintFor(harness, session, setup),
          })).resolves.toEqual({ kind: 'miss', reason });
          await expect(session.resolveGrounded(REF, {
            mode: 'compute',
            resolvedSecrets: [],
          })).resolves.toEqual({ kind: 'miss', reason });
        });
      });
    }

    if (supportsMiss(harness, 'secret-contaminated')) {
      it('reports secret-contaminated only from a compute query', async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

        await withSession(harness, setup, async (session) => {
          await expect(session.resolveGrounded(REF, {
            mode: 'compute',
            resolvedSecrets: [new Set(['Submit'])],
          })).resolves.toEqual({ kind: 'miss', reason: 'secret-contaminated' });
        });
      });
    }

    for (const operation of TARGETED_OPERATIONS) {
      it(`allows a valid BoundElement to be reused for ${operation.description}`, async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

        await withSession(harness, setup, async (session) => {
          const element = await bind(harness, session, setup);
          await operation.invoke(session, element);
          await operation.invoke(session, element);
        });
      });
    }

    for (const operation of TARGETED_OPERATIONS) {
      it(`rejects a fabricated BoundElement before ${operation.description} reaches the browser`, async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

        await withSession(harness, setup, async (session) => {
          expect(harness.operationObservation(session)).toEqual({
            ariaSnapshotCalls: 0,
            roleLocatorCalls: 0,
            finalOperationCalls: 0,
          });
          await expectRejectedWithoutBrowserWork(harness, session, operation, {
            ref: REF,
            fingerprint: MATCHING_FINGERPRINT,
          }, 'provenance');
          expect(harness.operationObservation(session)).toEqual({
            ariaSnapshotCalls: 0,
            roleLocatorCalls: 0,
            finalOperationCalls: 0,
          });
        });
      });
    }

    for (const operation of TARGETED_OPERATIONS) {
      it(`rejects ${operation.description} after navigation even when the descriptor remains unchanged`, async () => {
        const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

        await withSession(harness, setup, async (session) => {
          const element = await bind(harness, session, setup);
          await session.perform({ type: 'navigate', url: harness.navigationUrl(setup) });
          await expectRejectedWithoutBrowserWork(harness, session, operation, element, 'navigation');
        });
      });
    }

    if (harness.invalidateDescriptor !== undefined) {
      for (const operation of TARGETED_OPERATIONS) {
        it(`rejects ${operation.description} after descriptor invalidation without navigation`, async () => {
          const setup = {
            ref: REF,
            currentFingerprint: MATCHING_FINGERPRINT,
            exists: true,
            scenario: 'descriptor-mutable' as const,
          };

          await withSession(harness, setup, async (session) => {
            const element = await bind(harness, session, setup);
            await harness.invalidateDescriptor?.(session, setup);
            await expectRejectedWithoutBrowserWork(harness, session, operation, element, 'fingerprint');
          });
        });
      }
    }

    it('rejects a BoundElement minted by an independent browser session', async () => {
      const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };
      let first: BrowserSession | undefined;
      let second: BrowserSession | undefined;

      try {
        first = await harness.createSession(setup);
        second = await harness.createSession(setup);
        const foreignElement = await bind(harness, first, setup);

        for (const operation of TARGETED_OPERATIONS) {
          expect(harness.operationObservation(second)).toEqual({
            ariaSnapshotCalls: 0,
            roleLocatorCalls: 0,
            finalOperationCalls: 0,
          });
          await expectRejectedWithoutBrowserWork(harness, second, operation, foreignElement, 'provenance');
          expect(harness.operationObservation(second)).toEqual({
            ariaSnapshotCalls: 0,
            roleLocatorCalls: 0,
            finalOperationCalls: 0,
          });
        }
      } finally {
        try {
          await first?.close();
        } finally {
          try {
            await second?.close();
          } finally {
            await harness.dispose?.();
          }
        }
      }
    });

    it('exposes browser-session operations with their public result shapes', async () => {
      const setup = { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true };

      await withSession(harness, setup, async (session) => {
        expect(typeof session.perform).toBe('function');
        expect(typeof session.evaluateAssert).toBe('function');
        expect(typeof session.captureValue).toBe('function');
        expect(typeof session.snapshotForResolution).toBe('function');
        expect(typeof session.screenshot).toBe('function');
        expect(typeof session.accessibilitySnapshot).toBe('function');
        expect(typeof session.close).toBe('function');

        const element = await bind(harness, session, setup);
        await expect(session.perform({ type: 'click', target: element })).resolves.toBeUndefined();

        const assertion = await session.evaluateAssert({ check: 'element-visible', target: element });
        expect(assertion).toEqual(expect.objectContaining({ passed: expect.any(Boolean) }));
        if (!assertion.passed) {
          expect(typeof assertion.message).toBe('string');
        }

        expect(typeof await session.captureValue(element, 'text')).toBe('string');

        const resolutionSnapshot = await session.snapshotForResolution();
        expect(resolutionSnapshot.screenshot).toBeInstanceOf(Uint8Array);
        expect(isJsonValue(resolutionSnapshot.accessibilityTree)).toBe(true);

        expect(await session.screenshot()).toBeInstanceOf(Uint8Array);
        const accessibilityCapture = await session.accessibilitySnapshot();
        expect(typeof accessibilityCapture.rawYaml).toBe('string');
        expect(isJsonValue(accessibilityCapture.tree)).toBe(true);
        expect(Array.isArray(accessibilityCapture.scalarValues)).toBe(true);
        expect(accessibilityCapture.scalarValues.every((value) => typeof value === 'string')).toBe(true);
      });
    });
  });
}
