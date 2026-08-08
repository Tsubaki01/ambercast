import { describe, expect, it, vi } from 'vitest';
import { rejectOnAbort } from '#core/ai/reject-on-abort.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(reason) {
      rejectPromise?.(reason);
    },
  };
}

describe('rejectOnAbort', () => {
  it('rejects a pre-aborted signal without invoking work', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    const work = vi.fn(async () => 'unexpected work');
    controller.abort(reason);

    await expect(rejectOnAbort(controller.signal, work)).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects a mid-call abort without waiting for still-pending work', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel pending work');
    const pending = deferred<string>();
    const work = vi.fn(() => pending.promise);
    const running = rejectOnAbort(controller.signal, work);

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(work).toHaveBeenCalledTimes(1);
    pending.resolve('too late');
  });

  it('keeps same-tick abort precedence and observes the later losing rejection', async () => {
    const controller = new AbortController();
    const abortReason = new Error('abort won');
    const workRejection = new Error('work lost');
    const pending = deferred<string>();
    const work = vi.fn(() => {
      controller.abort(abortReason);
      return pending.promise;
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await expect(rejectOnAbort(controller.signal, work)).rejects.toBe(abortReason);
      expect(work).toHaveBeenCalledTimes(1);
      pending.reject(workRejection);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('removes its abort listener after work settles, so a later abort has no effect', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const work = deferred<string>();
    const running = rejectOnAbort(controller.signal, () => work.promise);

    work.resolve('completed');

    await expect(running).resolves.toBe('completed');
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    const removalsAfterSettlement = removeListener.mock.calls.length;
    controller.abort(new Error('too late'));
    expect(removeListener).toHaveBeenCalledTimes(removalsAfterSettlement);
    removeListener.mockRestore();
  });

  it('preserves work completion when a later abort follows it', async () => {
    const controller = new AbortController();
    const completed = rejectOnAbort(controller.signal, async () => 'completed first');

    await expect(completed).resolves.toBe('completed first');
    controller.abort(new Error('later abort'));
  });

  it('uses an AbortError DOMException when an aborted signal has no reason', async () => {
    const signal = { aborted: true, reason: undefined } as AbortSignal;

    await expect(rejectOnAbort(signal, async () => 'unexpected work')).rejects.toSatisfy((error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ));
  });

  it('converts a synchronous work throw into a rejected promise', async () => {
    const error = new Error('synchronous failure');

    await expect(rejectOnAbort(undefined, () => {
      throw error;
    })).rejects.toBe(error);
  });
});
