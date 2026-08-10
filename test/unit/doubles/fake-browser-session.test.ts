import { describe, expect, it } from 'vitest';
import type { ElementRef, Fingerprint } from '../../../src/core/ir/schema.js';
import {
  createFakeBrowserSession,
  elementRefKey,
  fingerprintsEqual,
} from '../../doubles/fake-browser-session.js';

const REF: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const OTHER_REF: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Email' };
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(64) };
const OTHER_FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'b'.repeat(64) };
const REF_KEY = JSON.stringify(['accessibility', 'button', 'Submit']);

function entries(exists = true, currentFingerprint: Fingerprint = FINGERPRINT): ReadonlyMap<string, {
  readonly currentFingerprint: Fingerprint;
  readonly exists: boolean;
}> {
  return new Map([[REF_KEY, { exists, currentFingerprint }]]);
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

  it('exposes every BrowserSession operation as callable', async () => {
    const session = createFakeBrowserSession(entries());

    expect(typeof session.perform).toBe('function');
    expect(typeof session.evaluateAssert).toBe('function');
    expect(typeof session.captureValue).toBe('function');
    expect(typeof session.resolveGrounded).toBe('function');
    expect(typeof session.snapshotForResolution).toBe('function');
    expect(typeof session.screenshot).toBe('function');
    expect(typeof session.accessibilitySnapshot).toBe('function');
    expect(typeof session.close).toBe('function');

    await expect(Promise.all([
      session.perform({ type: 'click', target: REF }),
      session.evaluateAssert({ check: 'element-visible', target: REF }),
      session.captureValue(REF, 'text'),
      session.resolveGrounded(REF, FINGERPRINT),
      session.snapshotForResolution(),
      session.screenshot(),
      session.accessibilitySnapshot(),
      session.close(),
    ])).resolves.toHaveLength(8);
  });

  it('returns a hit only when two otherwise identical grounding scenarios have matching fingerprints', async () => {
    const session = createFakeBrowserSession(entries(true, FINGERPRINT));
    const matching = session.resolveGrounded(REF, FINGERPRINT);
    const mismatching = session.resolveGrounded(REF, OTHER_FINGERPRINT);

    await expect(Promise.all([matching, mismatching])).resolves.toEqual([
      { kind: 'hit', ref: REF },
      { kind: 'miss', reason: 'fingerprint-mismatch' },
    ]);
  });

  it('returns element-not-found when an entry is absent or marked absent', async () => {
    const noEntry = createFakeBrowserSession(new Map());
    const absentEntry = createFakeBrowserSession(entries(false, FINGERPRINT));

    await expect(noEntry.resolveGrounded(REF, OTHER_FINGERPRINT)).resolves.toEqual({
      kind: 'miss',
      reason: 'element-not-found',
    });
    await expect(absentEntry.resolveGrounded(REF, OTHER_FINGERPRINT)).resolves.toEqual({
      kind: 'miss',
      reason: 'element-not-found',
    });
  });

  it('captures distinct configured values for text and value modes', async () => {
    const session = createFakeBrowserSession(entries(), {
      captureValues: new Map([[REF_KEY, { text: 'Submit', value: 'submit-button-1' }]]),
    });

    await expect(session.captureValue(REF, 'text')).resolves.toBe('Submit');
    await expect(session.captureValue(REF, 'value')).resolves.toBe('submit-button-1');
  });

  it('preserves an empty configured capture value', async () => {
    const session = createFakeBrowserSession(entries(), {
      captureValues: new Map([[REF_KEY, { text: '', value: 'submit-button-1' }]]),
    });

    await expect(session.captureValue(REF, 'text')).resolves.toBe('');
  });

  it('returns its configured assertion outcome', async () => {
    const outcome = { passed: false, message: 'The form is incomplete.' } as const;
    const session = createFakeBrowserSession(entries(), { assertOutcome: outcome });

    await expect(session.evaluateAssert({ check: 'element-visible', target: REF })).resolves.toBe(outcome);
  });

  it('rejects after consuming every scripted assertion outcome', async () => {
    const outcome = { passed: false, message: 'The form is incomplete.' } as const;
    const session = createFakeBrowserSession(entries(), { assertOutcomes: [outcome] });

    await expect(session.evaluateAssert({ check: 'element-visible', target: REF })).resolves.toBe(outcome);
    await expect(session.evaluateAssert({ check: 'element-visible', target: REF }))
      .rejects.toThrow('No scripted assertion outcome remains.');
  });

  it('records browser-facing work in order while leaving teardown outside the operation log', async () => {
    const session = createFakeBrowserSession(entries(), {
      assertOutcomes: [
        { passed: true },
        { passed: false, message: 'The second check failed.' },
      ],
    });

    await session.perform({ type: 'click', target: REF });
    await session.evaluateAssert({ check: 'element-visible', target: REF });
    await session.evaluateAssert({ check: 'text-visible', text: 'Missing' });
    await session.snapshotForResolution();
    await session.close();

    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'click', target: REF } },
      { type: 'evaluate-assert', check: { check: 'element-visible', target: REF } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Missing' } },
      { type: 'snapshot-for-resolution' },
    ]);
  });

  it('returns each configured snapshot view from the same snapshot', async () => {
    const snapshot = {
      accessibilityTree: { role: 'document', name: 'Sign in' },
      screenshot: new Uint8Array([137, 80, 78, 71]),
    } as const;
    const session = createFakeBrowserSession(entries(), { snapshot });

    await expect(session.snapshotForResolution()).resolves.toBe(snapshot);
    await expect(session.screenshot()).resolves.toBe(snapshot.screenshot);
    await expect(session.accessibilitySnapshot()).resolves.toBe(snapshot.accessibilityTree);
  });

  it('records materialized action and assertion arguments through callbacks', async () => {
    const performed: unknown[] = [];
    const evaluated: unknown[] = [];
    const action = { type: 'fill', target: REF, value: 'person@example.test' } as const;
    const check = { check: 'text-equals', target: REF, text: 'Signed in' } as const;
    const session = createFakeBrowserSession(entries(), {
      onPerform: (received) => performed.push(received),
      onEvaluateAssert: (received) => evaluated.push(received),
    });

    await session.perform(action);
    await session.evaluateAssert(check);

    expect(performed).toEqual([action]);
    expect(evaluated).toEqual([check]);
  });

  it('keeps action-recording state isolated between sessions', async () => {
    const firstActions: unknown[] = [];
    const secondActions: unknown[] = [];
    const first = createFakeBrowserSession(entries(), { onPerform: (action) => firstActions.push(action) });
    const second = createFakeBrowserSession(entries(), { onPerform: (action) => secondActions.push(action) });
    const firstAction = { type: 'click', target: REF } as const;
    const secondAction = { type: 'click', target: OTHER_REF } as const;

    await Promise.all([first.perform(firstAction), second.perform(secondAction)]);

    expect(firstActions).toEqual([firstAction]);
    expect(secondActions).toEqual([secondAction]);
  });

  it('allows repeated close calls while running its close callback only once', async () => {
    const closes: string[] = [];
    const session = createFakeBrowserSession(entries(), { onClose: () => closes.push('closed') });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();

    expect(closes).toEqual(['closed']);
  });
});
