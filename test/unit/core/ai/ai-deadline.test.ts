import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeAiDeadline,
  hasAiDeadlineExpired,
  isAiDeadlineTimeout,
} from '#core/ai/ai-deadline.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('composeAiDeadline', () => {
  it('creates distinct timeout and composite signals with the supplied budgets', () => {
    const caller = new AbortController();
    const firstTimeout = new AbortController();
    const secondTimeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(firstTimeout.signal)
      .mockReturnValueOnce(secondTimeout.signal);

    const first = composeAiDeadline(caller.signal, 123);
    const second = composeAiDeadline(undefined, 456);

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 123);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 456);
    expect(first.timeoutSignal).toBe(firstTimeout.signal);
    expect(second.timeoutSignal).toBe(secondTimeout.signal);
    expect(first.timeoutSignal).not.toBe(second.timeoutSignal);
    expect(first.signal).not.toBe(first.timeoutSignal);
    expect(first.signal).not.toBe(caller.signal);
    expect(second.signal).not.toBe(second.timeoutSignal);
  });

  it('preserves the exact reason from the source that aborts first', () => {
    const localTimeout = new AbortController();
    const caller = new AbortController();
    const callerTimeout = new AbortController();
    const preAbortedCaller = new AbortController();
    const preAbortedTimeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(localTimeout.signal)
      .mockReturnValueOnce(callerTimeout.signal)
      .mockReturnValueOnce(preAbortedTimeout.signal);
    const localReason = new Error('local deadline elapsed');
    const callerReason = new Error('caller stopped the request');
    const preAbortedReason = new Error('caller was already stopped');

    const localDeadline = composeAiDeadline(caller.signal, 1);
    localTimeout.abort(localReason);

    const callerDeadline = composeAiDeadline(caller.signal, 1);
    caller.abort(callerReason);

    preAbortedCaller.abort(preAbortedReason);
    const preAbortedDeadline = composeAiDeadline(preAbortedCaller.signal, 1);

    expect(timeoutSpy).toHaveBeenCalledTimes(3);
    expect(localDeadline.signal.reason).toBe(localDeadline.timeoutSignal.reason);
    expect(localDeadline.signal.reason).toBe(localReason);
    expect(callerDeadline.signal.reason).toBe(callerReason);
    expect(preAbortedDeadline.signal.aborted).toBe(true);
    expect(preAbortedDeadline.signal.reason).toBe(preAbortedReason);
  });
});

describe('hasAiDeadlineExpired', () => {
  it('reports only the deadline timeout, not caller cancellation', () => {
    const caller = new AbortController();
    const callerTimeout = new AbortController();
    const localTimeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(callerTimeout.signal)
      .mockReturnValueOnce(localTimeout.signal);

    const callerDeadline = composeAiDeadline(caller.signal, 1);
    const localDeadline = composeAiDeadline(undefined, 1);

    expect(hasAiDeadlineExpired(callerDeadline)).toBe(false);
    expect(hasAiDeadlineExpired(localDeadline)).toBe(false);
    caller.abort(new Error('caller stopped the request'));
    expect(hasAiDeadlineExpired(callerDeadline)).toBe(false);
    callerTimeout.abort(new Error('local deadline elapsed after caller cancellation'));
    expect(hasAiDeadlineExpired(callerDeadline)).toBe(true);
    localTimeout.abort(new Error('local deadline elapsed'));
    expect(hasAiDeadlineExpired(localDeadline)).toBe(true);
  });
});

describe('isAiDeadlineTimeout', () => {
  it('requires both local expiry and the exact timeout reason', () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const deadline = composeAiDeadline(undefined, 1);
    const matchingName = new DOMException('other timeout', 'TimeoutError');
    const timeoutReason = new DOMException('local timeout', 'TimeoutError');

    expect(isAiDeadlineTimeout(deadline, matchingName)).toBe(false);
    expect(isAiDeadlineTimeout(deadline, undefined)).toBe(false);
    timeout.abort(timeoutReason);

    expect(isAiDeadlineTimeout(deadline, timeoutReason)).toBe(true);
    expect(isAiDeadlineTimeout(deadline, matchingName)).toBe(false);
    expect(isAiDeadlineTimeout(deadline, new Error('unrelated failure'))).toBe(false);
    expect(isAiDeadlineTimeout(deadline, undefined)).toBe(false);
  });
});
