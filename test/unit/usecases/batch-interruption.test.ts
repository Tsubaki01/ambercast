import { describe, expect, it, vi } from 'vitest';
import { BatchInterruptionTracker } from '#usecases/batch-interruption.js';

describe('BatchInterruptionTracker', () => {
  it('latches pre-aborted discovered work but not an empty batch', () => {
    const controller = new AbortController();
    controller.abort();
    const tracker = new BatchInterruptionTracker(controller.signal);

    expect(tracker.interrupted).toBe(false);
    tracker.addDiscovered('work:0', 'case-a');
    expect(tracker.interrupted).toBe(true);
    expect(tracker.pendingIdentities).toEqual(['case-a']);
  });

  it('tracks scheduling keys independently from public identities and deduplicates pending identities', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('plan:0', 'same');
    tracker.addDiscovered('grounding:0', 'same');
    tracker.addDiscovered('selected:1', 'next');
    tracker.markTerminal('plan:0');
    controller.abort();

    expect(tracker.interrupted).toBe(true);
    expect(tracker.pendingIdentities).toEqual(['same', 'next']);
  });

  it('does not latch when cancellation follows the final terminal mark', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('work:0', 'case-a');
    tracker.markTerminal('work:0');
    controller.abort();

    expect(tracker.interrupted).toBe(false);
    expect(tracker.pendingIdentities).toEqual([]);
  });

  it('makes an identical re-add idempotent and rejects rebinding or invalid terminal marks', () => {
    const tracker = new BatchInterruptionTracker();
    tracker.addDiscovered('work:0', 'case-a');
    expect(() => tracker.addDiscovered('work:0', 'case-a')).not.toThrow();
    expect(() => tracker.addDiscovered('work:0', 'case-b')).toThrow();
    expect(() => tracker.markTerminal('missing')).toThrow();
    tracker.markTerminal('work:0');
    expect(() => tracker.markTerminal('work:0')).toThrow();
  });

  it('disposes idempotently and ignores late aborts after normal or exceptional cleanup', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('work:0', 'case-a');
    tracker.dispose();
    tracker.dispose();
    controller.abort();

    expect(tracker.interrupted).toBe(false);
    expect(tracker.pendingIdentities).toEqual(['case-a']);
  });

  it('latches when work is added after an already observed abort and preserves the first pending identity order', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    controller.abort();
    tracker.addDiscovered('work:0', 'first');
    tracker.addDiscovered('work:1', 'second');

    expect(tracker.interrupted).toBe(true);
    expect(tracker.pendingIdentities).toEqual(['first', 'second']);
  });

  it('keeps the latch after an in-flight terminal mark and distinguishes cancellation between cases', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('first', 'first');
    controller.abort();
    tracker.markTerminal('first');
    tracker.addDiscovered('second', 'second');

    expect(tracker.interrupted).toBe(true);
    expect(tracker.pendingIdentities).toEqual(['second']);
  });

  it('leaves an empty disposed tracker unchanged when its signal aborts later', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.dispose();
    controller.abort();

    expect(tracker.interrupted).toBe(false);
    expect(tracker.pendingIdentities).toEqual([]);
  });

  it.each(['normal return', 'rejection'] as const)('cleans up its signal listener from finally on %s', async (mode) => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('work:0', 'case-a');
    const dispose = vi.spyOn(tracker, 'dispose');

    const exercise = async () => {
      try {
        if (mode === 'rejection') {
          throw new Error('expected failure');
        }
      } finally {
        tracker.dispose();
      }
    };

    if (mode === 'rejection') {
      await expect(exercise()).rejects.toThrow('expected failure');
    } else {
      await expect(exercise()).resolves.toBeUndefined();
    }
    controller.abort();
    expect(dispose).toHaveBeenCalledOnce();
    expect(tracker.interrupted).toBe(false);
  });

  it('exposes only public identities to report serialization and never a work key', () => {
    const controller = new AbortController();
    const tracker = new BatchInterruptionTracker(controller.signal);
    tracker.addDiscovered('grounding:42:/private/path', 'deleted.test.md');
    controller.abort();

    const serialized = JSON.stringify({ interrupted: tracker.interrupted, skipped: tracker.pendingIdentities.map((file) => ({ file })) });
    expect(serialized).toContain('deleted.test.md');
    expect(serialized).not.toContain('grounding:42:/private/path');
  });
});
