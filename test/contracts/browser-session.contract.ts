import { describe, expect, it } from 'vitest';
import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import type { BrowserSession } from '../../src/ports/browser.js';

export interface BrowserSessionContractSetup {
  readonly ref: ElementRef;
  readonly currentFingerprint: Fingerprint;
  readonly exists: boolean;
}

export interface BrowserSessionContractHarness {
  createSession(setup: BrowserSessionContractSetup): BrowserSession | Promise<BrowserSession>;
  dispose?(): void | Promise<void>;
}

const REF: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const MATCHING_FINGERPRINT: Fingerprint = {
  algorithm: 'a11y-neighborhood-v1',
  hash: 'a'.repeat(64),
};
const DIFFERENT_FINGERPRINT: Fingerprint = {
  algorithm: 'a11y-neighborhood-v1',
  hash: 'b'.repeat(64),
};

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

async function withSession(
  harness: BrowserSessionContractHarness,
  setup: BrowserSessionContractSetup,
  assertion: (session: BrowserSession) => Promise<void>,
): Promise<void> {
  try {
    await assertion(await harness.createSession(setup));
  } finally {
    await harness.dispose?.();
  }
}

export function registerBrowserSessionContract(harness: BrowserSessionContractHarness): void {
  describe('BrowserSession contract', () => {
    it('resolves existing grounding when its fingerprint matches exactly', async () => {
      await withSession(harness, { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true }, async (session) => {
        await expect(session.resolveGrounded(REF, MATCHING_FINGERPRINT)).resolves.toEqual({ kind: 'hit', ref: REF });
      });
    });

    it('rejects existing grounding when only its fingerprint differs', async () => {
      await withSession(harness, { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true }, async (session) => {
        await expect(session.resolveGrounded(REF, DIFFERENT_FINGERPRINT)).resolves.toEqual({
          kind: 'miss',
          reason: 'fingerprint-mismatch',
        });
      });
    });

    it('reports a missing element before considering a fingerprint mismatch', async () => {
      await withSession(harness, { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: false }, async (session) => {
        await expect(session.resolveGrounded(REF, DIFFERENT_FINGERPRINT)).resolves.toEqual({
          kind: 'miss',
          reason: 'element-not-found',
        });
      });
    });

    it('reports a missing element even when its fingerprint matches', async () => {
      await withSession(harness, { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: false }, async (session) => {
        await expect(session.resolveGrounded(REF, MATCHING_FINGERPRINT)).resolves.toEqual({
          kind: 'miss',
          reason: 'element-not-found',
        });
      });
    });

    it('exposes browser-session operations with their public result shapes', async () => {
      await withSession(harness, { ref: REF, currentFingerprint: MATCHING_FINGERPRINT, exists: true }, async (session) => {
        expect(typeof session.perform).toBe('function');
        expect(typeof session.evaluateAssert).toBe('function');
        expect(typeof session.captureValue).toBe('function');
        expect(typeof session.snapshotForResolution).toBe('function');
        expect(typeof session.screenshot).toBe('function');
        expect(typeof session.accessibilitySnapshot).toBe('function');
        expect(typeof session.close).toBe('function');

        await expect(session.perform({ type: 'click', target: REF })).resolves.toBeUndefined();

        const assertion = await session.evaluateAssert({ check: 'element-visible', target: REF });
        expect(assertion).toEqual(expect.objectContaining({ passed: expect.any(Boolean) }));
        if (!assertion.passed) {
          expect(typeof assertion.message).toBe('string');
        }

        expect(typeof await session.captureValue(REF, 'text')).toBe('string');

        const resolutionSnapshot = await session.snapshotForResolution();
        expect(resolutionSnapshot.screenshot).toBeInstanceOf(Uint8Array);
        expect(isJsonValue(resolutionSnapshot.accessibilityTree)).toBe(true);

        expect(await session.screenshot()).toBeInstanceOf(Uint8Array);
        expect(isJsonValue(await session.accessibilitySnapshot())).toBe(true);

        await expect(session.close()).resolves.toBeUndefined();
      });
    });
  });
}
