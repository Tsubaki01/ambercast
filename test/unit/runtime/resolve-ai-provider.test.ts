import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { resolveAiProvider } from '#runtime/resolve-ai-provider.js';

const mocks = vi.hoisted(() => ({
  claudeFactory: vi.fn(),
  codexFactory: vi.fn(),
}));

vi.mock('#adapters/ai/registry.js', () => ({
  AI_EXECUTOR_FACTORIES: { claude: mocks.claudeFactory, codex: mocks.codexFactory },
}));

type ProbeHandler = (signal: AbortSignal | undefined) => Promise<boolean>;

function arrangeProbes(claude: ProbeHandler, codex: ProbeHandler) {
  const claudeIsAvailable = vi.fn(claude);
  const codexIsAvailable = vi.fn(codex);
  mocks.claudeFactory.mockReturnValue({ isAvailable: claudeIsAvailable });
  mocks.codexFactory.mockReturnValue({ isAvailable: codexIsAvailable });
  return { claudeIsAvailable, codexIsAvailable };
}

function interceptTimeouts(controllers: readonly AbortController[]) {
  let index = 0;
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = controllers[index];
    index += 1;
    if (controller === undefined) {
      throw new Error('Unexpected deadline creation.');
    }
    return controller.signal;
  });
}

function resolvesFalseOnAbort(signal: AbortSignal | undefined): Promise<boolean> {
  if (signal === undefined) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    signal.addEventListener('abort', () => resolve(false), { once: true });
  });
}

function createProbeEntry() {
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });

  return {
    entered,
    markEntered() {
      markEntered?.();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('resolveAiProvider', () => {
  it('returns an override without creating a deadline or probing a provider', async () => {
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(async () => true, async () => true);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await expect(resolveAiProvider('auto', 'codex')).resolves.toBe('codex');

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(claudeIsAvailable).not.toHaveBeenCalled();
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)('returns configured %s without creating a deadline or probing', async (configured) => {
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(async () => true, async () => true);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await expect(resolveAiProvider(configured, undefined)).resolves.toBe(configured);

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(claudeIsAvailable).not.toHaveBeenCalled();
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });

  it('selects Claude when its first automatic probe is available', async () => {
    const timeout = new AbortController();
    const timeoutSpy = interceptTimeouts([timeout]);
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(async () => true, async () => true);

    await expect(resolveAiProvider('auto', undefined)).resolves.toBe('claude');

    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(8_000);
    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(claudeIsAvailable.mock.calls[0]?.[0]).not.toBe(timeout.signal);
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });

  it('uses a distinct deadline for Codex after Claude reports unavailable', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    const timeoutSpy = interceptTimeouts([claudeTimeout, codexTimeout]);
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(async () => false, async () => true);

    await expect(resolveAiProvider('auto', undefined)).resolves.toBe('codex');

    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 8_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 8_000);
    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(codexIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(claudeIsAvailable.mock.calls[0]?.[0]).not.toBe(claudeTimeout.signal);
    expect(codexIsAvailable.mock.calls[0]?.[0]).not.toBe(codexTimeout.signal);
    expect(claudeIsAvailable.mock.calls[0]?.[0]).not.toBe(codexIsAvailable.mock.calls[0]?.[0]);
  });

  it('records not-found attempts when both automatic probes promptly return false', async () => {
    const timeoutSpy = interceptTimeouts([new AbortController(), new AbortController()]);
    arrangeProbes(async () => false, async () => false);

    const error = await resolveAiProvider('auto', undefined).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(AiExecutorUnavailableError);
    expect((error as AiExecutorUnavailableError).details?.attempts).toEqual([
      { provider: 'claude', reason: 'not-found' },
      { provider: 'codex', reason: 'not-found' },
    ]);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it('records a timed-out Claude probe before probing Codex with a fresh deadline', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    const timeoutSpy = interceptTimeouts([claudeTimeout, codexTimeout]);
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(resolvesFalseOnAbort, async () => false);
    const running = resolveAiProvider('auto', undefined);

    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    claudeTimeout.abort(new Error('Claude probe deadline elapsed'));

    await expect(running).rejects.toMatchObject({
      details: {
        attempts: [
          { provider: 'claude', reason: 'timeout' },
          { provider: 'codex', reason: 'not-found' },
        ],
      },
    });
    expect(codexIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it('records timeouts for both probes when each probe waits for its own deadline', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    interceptTimeouts([claudeTimeout, codexTimeout]);
    const codexEntry = createProbeEntry();
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(resolvesFalseOnAbort, (signal) => {
      codexEntry.markEntered();
      return resolvesFalseOnAbort(signal);
    });
    const running = resolveAiProvider('auto', undefined);

    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    claudeTimeout.abort(new Error('Claude probe deadline elapsed'));
    await codexEntry.entered;
    expect(codexIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    codexTimeout.abort(new Error('Codex probe deadline elapsed'));

    await expect(running).rejects.toMatchObject({
      details: {
        attempts: [
          { provider: 'claude', reason: 'timeout' },
          { provider: 'codex', reason: 'timeout' },
        ],
      },
    });
  });

  it('keeps a Claude timeout separate from a fast Codex not-found result', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    interceptTimeouts([claudeTimeout, codexTimeout]);
    const { claudeIsAvailable } = arrangeProbes(resolvesFalseOnAbort, async () => false);
    const running = resolveAiProvider('auto', undefined);

    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    claudeTimeout.abort(new Error('Claude probe deadline elapsed'));

    await expect(running).rejects.toMatchObject({
      details: {
        attempts: [
          { provider: 'claude', reason: 'timeout' },
          { provider: 'codex', reason: 'not-found' },
        ],
      },
    });
  });

  it('keeps a fast Claude not-found result separate from a Codex timeout', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    interceptTimeouts([claudeTimeout, codexTimeout]);
    const codexEntry = createProbeEntry();
    arrangeProbes(async () => false, (signal) => {
      codexEntry.markEntered();
      return resolvesFalseOnAbort(signal);
    });
    const running = resolveAiProvider('auto', undefined);

    await codexEntry.entered;
    codexTimeout.abort(new Error('Codex probe deadline elapsed'));

    await expect(running).rejects.toMatchObject({
      details: {
        attempts: [
          { provider: 'claude', reason: 'not-found' },
          { provider: 'codex', reason: 'timeout' },
        ],
      },
    });
  });

  it('falls through from a timed-out Claude probe to an available Codex probe', async () => {
    const claudeTimeout = new AbortController();
    const codexTimeout = new AbortController();
    interceptTimeouts([claudeTimeout, codexTimeout]);
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(resolvesFalseOnAbort, async () => true);
    const running = resolveAiProvider('auto', undefined);

    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    claudeTimeout.abort(new Error('Claude probe deadline elapsed'));

    await expect(running).resolves.toBe('codex');
    expect(codexIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  });

  it('propagates an unexpected probe rejection without probing the second provider', async () => {
    const timeout = new AbortController();
    interceptTimeouts([timeout]);
    const rejection = new Error('probe unexpectedly failed');
    const { codexIsAvailable } = arrangeProbes(async () => {
      throw rejection;
    }, async () => true);

    await expect(resolveAiProvider('auto', undefined)).rejects.toBe(rejection);
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });

  it('gives caller cancellation precedence when caller and probe timeout abort during one probe', async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = interceptTimeouts([timeout]);
    const reason = new Error('caller stopped provider selection');
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(resolvesFalseOnAbort, async () => true);
    const running = resolveAiProvider('auto', undefined, caller.signal);

    expect(claudeIsAvailable).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(claudeIsAvailable.mock.calls[0]?.[0]).not.toBe(caller.signal);
    expect(claudeIsAvailable.mock.calls[0]?.[0]).not.toBe(timeout.signal);
    caller.abort(reason);
    timeout.abort(new Error('probe deadline elapsed after caller cancellation'));

    await expect(running).rejects.toBe(reason);
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(8_000);
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });

  it('propagates an already-aborted caller signal without probing a provider', async () => {
    const caller = new AbortController();
    const reason = new Error('caller cancelled before provider selection');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const { claudeIsAvailable, codexIsAvailable } = arrangeProbes(async () => true, async () => true);
    caller.abort(reason);

    await expect(resolveAiProvider('auto', undefined, caller.signal)).rejects.toBe(reason);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(claudeIsAvailable).not.toHaveBeenCalled();
    expect(codexIsAvailable).not.toHaveBeenCalled();
  });
});
