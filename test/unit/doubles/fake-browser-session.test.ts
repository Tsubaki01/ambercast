import { describe, expect, it } from 'vitest';
import type { BoundElement, GroundingQuery } from '../../../src/ports/browser.js';
import type { ElementRef, Fingerprint } from '../../../src/core/ir/schema.js';
import {
  bindForTest,
  createFakeBrowserSession,
  elementRefKey,
  fingerprintsEqual,
  operationObservation,
  type FakeBrowserSession,
  type FakeBrowserSessionEntry,
} from '../../doubles/fake-browser-session.js';

const REF: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const OTHER_REF: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Email' };
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(64) };
const OTHER_FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v2', hash: 'b'.repeat(64) };
const REF_KEY = JSON.stringify(['accessibility', 'button', 'Submit']);

function entries(
  exists = true,
  currentFingerprint: Fingerprint = FINGERPRINT,
  entry: Partial<FakeBrowserSessionEntry> = {},
): Map<string, FakeBrowserSessionEntry> {
  return new Map([[REF_KEY, { exists, currentFingerprint, ...entry }]]);
}

async function resolvedElement(
  session: FakeBrowserSession,
  query: GroundingQuery = { mode: 'verify', fingerprint: FINGERPRINT },
): Promise<BoundElement> {
  const result = await session.resolveGrounded(REF, query);
  if (result.kind === 'miss') {
    throw new Error(`Fixture unexpectedly missed: ${result.reason}`);
  }

  return result.element;
}

async function expectTargetedOperationsToReject(
  session: FakeBrowserSession,
  element: BoundElement,
): Promise<void> {
  const operationCount = session.operations().length;

  await expect(session.perform({ type: 'click', target: element })).rejects.toThrow();
  await expect(session.evaluateAssert({ check: 'element-visible', target: element })).rejects.toThrow();
  await expect(session.evaluateAssert({ check: 'text-equals', target: element, text: 'Submit' })).rejects.toThrow();
  await expect(session.captureValue(element, 'text')).rejects.toThrow();

  expect(session.operations()).toHaveLength(operationCount);
}

describe('createFakeBrowserSession', () => {
  it('uses a structural accessibility key and compares both fingerprint fields', () => {
    expect(elementRefKey(REF)).toBe(REF_KEY);
    expect(elementRefKey({ ...REF })).toBe(REF_KEY);
    expect(fingerprintsEqual(FINGERPRINT, { ...FINGERPRINT })).toBe(true);
    expect(fingerprintsEqual(FINGERPRINT, OTHER_FINGERPRINT)).toBe(false);
  });

  it('uses an unambiguous key when role and name contain colons', () => {
    const first: ElementRef = { strategy: 'accessibility', role: 'button:a', name: 'b' };
    const second: ElementRef = { strategy: 'accessibility', role: 'button', name: 'a:b' };

    expect(elementRefKey(first)).not.toBe(elementRefKey(second));
  });

  it('exposes every BrowserSession operation as callable with a real bound handle', async () => {
    const session = createFakeBrowserSession(entries());
    const element = bindForTest(session, REF, FINGERPRINT);

    expect(typeof session.perform).toBe('function');
    expect(typeof session.evaluateAssert).toBe('function');
    expect(typeof session.captureValue).toBe('function');
    expect(typeof session.resolveGrounded).toBe('function');
    expect(typeof session.snapshotForResolution).toBe('function');
    expect(typeof session.screenshot).toBe('function');
    expect(typeof session.accessibilitySnapshot).toBe('function');
    expect(typeof session.close).toBe('function');

    await expect(Promise.all([
      session.perform({ type: 'click', target: element }),
      session.evaluateAssert({ check: 'element-visible', target: element }),
      session.captureValue(element, 'text'),
      session.resolveGrounded(REF, { mode: 'verify', fingerprint: FINGERPRINT }),
      session.resolveGrounded(REF, { mode: 'compute', resolvedSecrets: [] }),
      session.snapshotForResolution(),
      session.screenshot(),
      session.accessibilitySnapshot(),
      session.close(),
    ])).resolves.toHaveLength(9);
  });

  it('returns a hit only when verify mode matches and compute mode derives the entry fingerprint', async () => {
    const session = createFakeBrowserSession(entries(true, FINGERPRINT));
    const matching = session.resolveGrounded(REF, { mode: 'verify', fingerprint: FINGERPRINT });
    const mismatching = session.resolveGrounded(REF, { mode: 'verify', fingerprint: OTHER_FINGERPRINT });
    const computed = session.resolveGrounded(REF, { mode: 'compute', resolvedSecrets: [] });

    await expect(Promise.all([matching, mismatching, computed])).resolves.toEqual([
      { kind: 'hit', element: expect.objectContaining({ ref: REF, fingerprint: FINGERPRINT }) },
      { kind: 'miss', reason: 'fingerprint-mismatch' },
      { kind: 'hit', element: expect.objectContaining({ ref: REF, fingerprint: FINGERPRINT }) },
    ]);
  });

  it.each([
    ['verify', 'ambiguous-match', { mode: 'verify', fingerprint: FINGERPRINT }],
    ['verify', 'snapshot-invalid', { mode: 'verify', fingerprint: FINGERPRINT }],
    ['compute', 'ambiguous-match', { mode: 'compute', resolvedSecrets: [] }],
    ['compute', 'snapshot-invalid', { mode: 'compute', resolvedSecrets: [] }],
    ['compute', 'secret-contaminated', { mode: 'compute', resolvedSecrets: [new Set(['Submit'])] }],
  ] as const)('scripts the reachable %s-mode %s miss reason', async (mode, reason, query) => {
    const session = createFakeBrowserSession(entries(true, FINGERPRINT, {
      scriptedMissReasons: { [mode]: reason },
    }));

    await expect(session.resolveGrounded(REF, query)).resolves.toEqual({ kind: 'miss', reason });
  });

  it('reports element-not-found before verify comparison and from compute mode', async () => {
    const noEntry = createFakeBrowserSession(new Map());
    const absentEntry = createFakeBrowserSession(entries(false, FINGERPRINT));

    await expect(noEntry.resolveGrounded(REF, { mode: 'verify', fingerprint: OTHER_FINGERPRINT })).resolves.toEqual({
      kind: 'miss',
      reason: 'element-not-found',
    });
    await expect(absentEntry.resolveGrounded(REF, { mode: 'compute', resolvedSecrets: [] })).resolves.toEqual({
      kind: 'miss',
      reason: 'element-not-found',
    });
  });

  it('bindForTest validates through both modes and does not add an artificial browser operation', async () => {
    const session = createFakeBrowserSession(entries());

    const verified = bindForTest(session, REF, FINGERPRINT);
    const computed = bindForTest(session, REF);

    expect(verified).toEqual({ ref: REF, fingerprint: FINGERPRINT });
    expect(computed).toEqual({ ref: REF, fingerprint: FINGERPRINT });
    expect(session.operations()).toEqual([]);
    await expect(session.perform({ type: 'click', target: verified })).resolves.toBeUndefined();
    await expect(session.perform({ type: 'click', target: computed })).resolves.toBeUndefined();
  });

  it('makes bindForTest reject the same invalid fixture state that resolveGrounded reports', () => {
    const session = createFakeBrowserSession(entries(true, FINGERPRINT, {
      scriptedMissReasons: { verify: 'snapshot-invalid' },
    }));

    expect(() => bindForTest(session, REF, FINGERPRINT)).toThrow('snapshot-invalid');
  });

  it('allows each targeted operation to reuse a still-current handle', async () => {
    const session = createFakeBrowserSession(entries(), {
      captureValues: new Map([[REF_KEY, { text: 'Submit', value: 'submit-button-1' }]]),
    });
    const element = await resolvedElement(session);

    await session.perform({ type: 'click', target: element });
    await session.perform({ type: 'click', target: element });
    await expect(session.evaluateAssert({ check: 'element-visible', target: element })).resolves.toEqual({ passed: true });
    await expect(session.evaluateAssert({ check: 'text-equals', target: element, text: 'Submit' })).resolves.toEqual({ passed: true });
    await expect(session.captureValue(element, 'text')).resolves.toBe('Submit');
    await expect(session.captureValue(element, 'value')).resolves.toBe('submit-button-1');
  });

  it('rejects fabricated handles before every targeted operation can reach the operation log', async () => {
    const session = createFakeBrowserSession(entries());
    const fabricated: BoundElement = { ref: REF, fingerprint: FINGERPRINT };

    await expectTargetedOperationsToReject(session, fabricated);
  });

  it('rejects a genuine handle from a different fake session before browser work', async () => {
    const first = createFakeBrowserSession(entries());
    const second = createFakeBrowserSession(entries());
    const foreign = bindForTest(first, REF, FINGERPRINT);

    await expectTargetedOperationsToReject(second, foreign);
  });

  it('starts operation-immediate revalidation only after provenance succeeds', async () => {
    const liveEntries = entries();
    const session = createFakeBrowserSession(liveEntries);
    const fabricated: BoundElement = { ref: REF, fingerprint: FINGERPRINT };

    await expect(session.perform({ type: 'click', target: fabricated })).rejects.toThrow('provenance');
    expect(operationObservation(session)).toEqual({
      ariaSnapshotCalls: 0,
      roleLocatorCalls: 0,
      finalOperationCalls: 0,
    });

    const bound = bindForTest(session, REF, FINGERPRINT);
    const entry = liveEntries.get(REF_KEY);
    if (entry === undefined) {
      throw new Error('The revalidation fixture must contain the bound entry.');
    }
    entry.currentFingerprint = OTHER_FINGERPRINT;

    await expect(session.perform({ type: 'click', target: bound })).rejects.toThrow('fingerprint');
    expect(operationObservation(session)).toEqual({
      ariaSnapshotCalls: 1,
      roleLocatorCalls: 0,
      finalOperationCalls: 0,
    });
  });

  it('invalidates every targeted operation after its own navigate action advances generation', async () => {
    const session = createFakeBrowserSession(entries());
    const element = bindForTest(session, REF, FINGERPRINT);

    await session.perform({ type: 'navigate', url: 'https://example.test/next' });
    await expectTargetedOperationsToReject(session, element);
  });

  it('invalidates every targeted operation when the descriptor fingerprint changes without navigation', async () => {
    const liveEntries = entries();
    const session = createFakeBrowserSession(liveEntries);
    const element = bindForTest(session, REF, FINGERPRINT);

    const entry = liveEntries.get(REF_KEY);
    if (entry === undefined) {
      throw new Error('The descriptor-invalidation fixture must contain the bound entry.');
    }
    entry.currentFingerprint = OTHER_FINGERPRINT;

    await expectTargetedOperationsToReject(session, element);
  });

  it.each([
    ['perform', async (session: FakeBrowserSession, target: BoundElement) => session.perform({ type: 'click', target })],
    ['element-visible', async (session: FakeBrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'element-visible', target })],
    ['text-equals', async (session: FakeBrowserSession, target: BoundElement) => session.evaluateAssert({ check: 'text-equals', target, text: 'Submit' })],
    ['captureValue', async (session: FakeBrowserSession, target: BoundElement) => session.captureValue(target, 'text')],
  ] as const)('keeps the private binding record authoritative for %s after public fields and original bind inputs are mutated', async (_operation, invoke) => {
    const session = createFakeBrowserSession(entries());
    const originalRef: ElementRef = { ...REF };
    const originalFingerprint: Fingerprint = { ...FINGERPRINT };
    const element = bindForTest(session, originalRef, originalFingerprint);
    const mutableElement = element as { ref: ElementRef; fingerprint: Fingerprint };

    mutableElement.ref = { ...OTHER_REF };
    mutableElement.fingerprint = { ...OTHER_FINGERPRINT };
    (originalRef as { name: string }).name = 'Mutated original name';
    (originalFingerprint as { hash: string }).hash = 'c'.repeat(64);

    await invoke(session, element);
  });

  it('preserves configured empty capture values after provenance validation', async () => {
    const session = createFakeBrowserSession(entries(), {
      captureValues: new Map([[REF_KEY, { text: '', value: 'submit-button-1' }]]),
    });
    const element = bindForTest(session, REF, FINGERPRINT);

    await expect(session.captureValue(element, 'text')).resolves.toBe('');
  });

  it('rejects after consuming every scripted assertion outcome without weakening target validation', async () => {
    const outcome = { passed: false, message: 'The form is incomplete.' } as const;
    const session = createFakeBrowserSession(entries(), { assertOutcomes: [outcome] });
    const element = bindForTest(session, REF, FINGERPRINT);

    await expect(session.evaluateAssert({ check: 'element-visible', target: element })).resolves.toBe(outcome);
    await expect(session.evaluateAssert({ check: 'element-visible', target: element }))
      .rejects.toThrow('No scripted assertion outcome remains.');
  });

  it('records only completed browser-facing work while preserving materialized target objects for callbacks', async () => {
    const performed: unknown[] = [];
    const evaluated: unknown[] = [];
    const session = createFakeBrowserSession(entries(), {
      onPerform: (received) => performed.push(received),
      onEvaluateAssert: (received) => evaluated.push(received),
    });
    const element = bindForTest(session, REF, FINGERPRINT);
    const action = { type: 'fill', target: element, value: 'person@example.test' } as const;
    const check = { check: 'text-equals', target: element, text: 'Signed in' } as const;

    await session.perform(action);
    await session.evaluateAssert(check);
    await session.snapshotForResolution();
    await session.close();

    expect(performed).toEqual([action]);
    expect(evaluated).toEqual([check]);
    expect(session.operations()).toEqual([
      { type: 'perform', action },
      { type: 'evaluate-assert', check },
      { type: 'snapshot-for-resolution' },
    ]);
  });

  it('returns each configured snapshot view from the same snapshot and closes only once', async () => {
    const closes: string[] = [];
    const snapshot = {
      accessibilityTree: { role: 'document', name: 'Sign in' },
      screenshot: new Uint8Array([137, 80, 78, 71]),
    } as const;
    const session = createFakeBrowserSession(entries(), { snapshot, onClose: () => closes.push('closed') });

    await expect(session.snapshotForResolution()).resolves.toBe(snapshot);
    await expect(session.screenshot()).resolves.toBe(snapshot.screenshot);
    await expect(session.accessibilitySnapshot()).resolves.toBe(snapshot.accessibilityTree);
    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(closes).toEqual(['closed']);
  });
});
