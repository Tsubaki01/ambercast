import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProcessGroupSupervisor,
  type ProcessGroupProbes,
  type ProcessGroupSupervisorTimings,
} from '../../contract-browser/support/process-group-supervisor.js';

const timings: ProcessGroupSupervisorTimings = { sigkillAfterMs: 20, failAfterMs: 20, pollIntervalMs: 5 };

function probes(state: { childAlive: boolean; closed: boolean; groupAlive: boolean }): ProcessGroupProbes {
  return {
    isChildPidAlive: vi.fn(() => state.childAlive),
    hasClosed: vi.fn(() => state.closed),
    isGroupAlive: vi.fn(() => state.groupAlive),
    signalGroup: vi.fn(),
  };
}

function signalMock(observation: ProcessGroupProbes): ReturnType<typeof vi.fn> {
  return observation.signalGroup as ReturnType<typeof vi.fn>;
}

describe('createProcessGroupSupervisor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('confirms an already-dead group without signaling', async () => {
    const state = { childAlive: false, closed: true, groupAlive: false };
    const observation = probes(state);
    const supervisor = createProcessGroupSupervisor(observation, timings);

    await expect(supervisor.terminateAndConfirm()).resolves.toBeUndefined();
    expect(observation.signalGroup).not.toHaveBeenCalled();
    expect(supervisor.terminated()).toBe(true);
  });

  it('resolves during SIGTERM grace with no SIGKILL', async () => {
    const state = { childAlive: true, closed: false, groupAlive: true };
    const observation = probes(state);
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const termination = supervisor.terminateAndConfirm();
    state.childAlive = false; state.closed = true; state.groupAlive = false;
    await vi.advanceTimersByTimeAsync(5);

    await expect(termination).resolves.toBeUndefined();
    expect(observation.signalGroup).toHaveBeenCalledTimes(1);
    expect(observation.signalGroup).toHaveBeenCalledWith('SIGTERM');
    expect(observation.signalGroup).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('escalates to SIGKILL and then confirms', async () => {
    const state = { childAlive: true, closed: false, groupAlive: true };
    const observation = probes(state);
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const termination = supervisor.terminateAndConfirm();
    await vi.advanceTimersByTimeAsync(20);
    state.childAlive = false; state.closed = true; state.groupAlive = false;
    await vi.advanceTimersByTimeAsync(5);

    await expect(termination).resolves.toBeUndefined();
    expect(signalMock(observation).mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('rejects after both graces when no condition confirms', async () => {
    const observation = probes({ childAlive: true, closed: false, groupAlive: true });
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const termination = supervisor.terminateAndConfirm();
    await vi.advanceTimersByTimeAsync(40);

    await expect(termination).rejects.toThrow(/did not confirm termination/i);
    expect(signalMock(observation).mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(supervisor.terminated()).toBe(false);
  });

  it('signals and rejects at the exact production-default grace boundaries', async () => {
    const productionTimings: ProcessGroupSupervisorTimings = {
      sigkillAfterMs: 5_000,
      failAfterMs: 5_000,
      pollIntervalMs: 50,
    };
    const observation = probes({ childAlive: true, closed: false, groupAlive: true });
    const supervisor = createProcessGroupSupervisor(observation, productionTimings);
    const termination = supervisor.terminateAndConfirm();
    let rejected = false;
    void termination.catch(() => { rejected = true; });

    expect(observation.signalGroup).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signalMock(observation).mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM']);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signalMock(observation).mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(termination).rejects.toThrow(/did not confirm termination/i);
  });

  it.each([
    ['open stdio only', { childAlive: false, closed: false, groupAlive: false }],
    ['live child PID only', { childAlive: true, closed: true, groupAlive: false }],
    ['live descendant group only', { childAlive: false, closed: true, groupAlive: true }],
  ])('requires all three conditions when %s remains false', async (_name, state) => {
    const observation = probes(state);
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const termination = supervisor.terminateAndConfirm();
    await vi.advanceTimersByTimeAsync(20);

    expect(observation.signalGroup).toHaveBeenCalledWith('SIGKILL');
    void termination.catch(() => undefined);
  });

  it('does not accumulate partial probe success across ticks', async () => {
    const state = { childAlive: false, closed: false, groupAlive: true };
    const supervisor = createProcessGroupSupervisor(probes(state), timings);
    const termination = supervisor.terminateAndConfirm();
    let settled = false;
    void termination.then(() => { settled = true; }, () => undefined);

    // Each confirmation condition is true on a different tick, but never all
    // three together. A stale per-condition accumulator would incorrectly
    // resolve after the third tick.
    await vi.advanceTimersByTimeAsync(5);
    state.childAlive = true; state.closed = true; state.groupAlive = true;
    await vi.advanceTimersByTimeAsync(5);
    state.childAlive = true; state.closed = false; state.groupAlive = false;
    await vi.advanceTimersByTimeAsync(5);
    expect(settled).toBe(false);
    state.childAlive = true; state.closed = false; state.groupAlive = true;
    await vi.advanceTimersByTimeAsync(25);

    await expect(termination).rejects.toThrow(/did not confirm termination/i);
  });

  it('shares one in-flight ladder between concurrent callers', async () => {
    const observation = probes({ childAlive: true, closed: false, groupAlive: true });
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const first = supervisor.terminateAndConfirm();
    const second = supervisor.terminateAndConfirm();

    expect(first).toBe(second);
    expect(observation.signalGroup).toHaveBeenCalledOnce();
  });

  it('does not signal again after a successful confirmation', async () => {
    const observation = probes({ childAlive: false, closed: true, groupAlive: false });
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const first = supervisor.terminateAndConfirm();
    await first;
    const second = supervisor.terminateAndConfirm();

    expect(second).toBe(first);
    expect(observation.signalGroup).not.toHaveBeenCalled();
  });

  it('does not signal again after a failed confirmation', async () => {
    const observation = probes({ childAlive: true, closed: false, groupAlive: true });
    const supervisor = createProcessGroupSupervisor(observation, timings);
    const first = supervisor.terminateAndConfirm();
    await vi.advanceTimersByTimeAsync(40);
    await expect(first).rejects.toThrow();
    const second = supervisor.terminateAndConfirm();

    expect(second).toBe(first);
    expect(observation.signalGroup).toHaveBeenCalledTimes(2);
  });

  it('treats a group that never existed as immediately confirmed', async () => {
    const observation = probes({ childAlive: false, closed: true, groupAlive: false });
    const supervisor = createProcessGroupSupervisor(observation, timings);

    await expect(supervisor.terminateAndConfirm()).resolves.toBeUndefined();
    expect(observation.signalGroup).not.toHaveBeenCalled();
    expect(supervisor.terminated()).toBe(true);
  });

  it('propagates a non-ESRCH signal failure', async () => {
    const observation = probes({ childAlive: true, closed: false, groupAlive: true });
    const failingProbes: ProcessGroupProbes = { ...observation, signalGroup: vi.fn(() => { throw new Error('EPERM'); }) };
    const supervisor = createProcessGroupSupervisor(failingProbes, timings);

    await expect(supervisor.terminateAndConfirm()).rejects.toThrow('EPERM');
  });
});
