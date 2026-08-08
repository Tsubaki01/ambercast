/**
 * Runs asynchronous work while making abort precedence and listener lifetime
 * explicit at the shared AI boundary.
 */

/**
 * Gets the reason that callers observe when a signal aborts.
 *
 * This fallback keeps every AI boundary aligned with platform cancellation
 * semantics when a controller omits an explicit reason.
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Resolves work unless an optional signal aborts first.
 *
 * @typeParam T - The work result propagated on normal completion.
 * @param signal - The optional cancellation source to observe.
 * @param work - Lazy asynchronous work that is not invoked for a pre-aborted
 * signal.
 * @returns The work result, or a rejection whose value is the signal reason.
 * @remarks
 * A pre-aborted signal short-circuits before `work` runs. Otherwise the helper
 * installs one abort listener and races it with the one work invocation;
 * either result removes that listener so a later abort cannot alter an
 * already-settled outcome or retain a listener. An absent abort reason uses
 * the platform-compatible `AbortError` DOMException fallback.
 */
export function rejectOnAbort<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  if (signal === undefined) {
    try {
      return work();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = (): boolean => {
      if (settled) {
        return false;
      }

      settled = true;
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (finish()) {
        reject(abortReason(signal));
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });

    let result: Promise<T>;
    try {
      result = work();
    } catch (error) {
      if (finish()) {
        reject(error);
      }
      return;
    }

    if (signal.aborted) {
      // The abort result already won, but observing the discarded work promise
      // still prevents its later rejection from becoming unhandled.
      void result.catch(() => undefined);
      if (finish()) {
        reject(abortReason(signal));
      }
      return;
    }

    result.then(
      (value) => {
        if (finish()) {
          resolve(value);
        }
      },
      (error: unknown) => {
        if (finish()) {
          reject(error);
        }
      },
    );
  });
}
