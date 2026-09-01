import { describe, expect, it, vi } from 'vitest';
import { createCleanupRegistry } from '../../contract-browser/support/cleanup-registry.js';
import { spawnSupervised, type SupervisedCli } from '../../contract-browser/support/supervised-cli.js';

const timings = { sigtermAfterMs: 250, sigkillAfterMs: 30, failAfterMs: 30, pollIntervalMs: 5 };

function signalsSent(kill: { mock: { calls: unknown[][] } }): unknown[] {
  return kill.mock.calls.map((call) => call[1]).filter((signal) => signal !== 0);
}

/**
 * A CleanupRegistry (cleanup-registry.ts) built from a real spawnSupervised
 * ENOENT failure must never start LIFO resource cleanup before the process
 * group's termination is genuinely confirmed — i.e. before the child's real
 * `'close'` event has actually fired — even though the operation itself
 * (the spawned command's `result`) rejects immediately on the earlier
 * `'error'` event (see #242). `process-group-supervisor.test.ts` and
 * `cleanup-registry.test.ts` cover each module's internal state machine
 * against synthetic probes/supervisors in isolation; this file runs both
 * real modules together against a real spawn failure, to observe whether
 * `hasClosed`'s probe wiring actually gates cleanup on the real `'close'`
 * event end to end.
 */
describe('supervised-cli x cleanup-registry integration', () => {
  it('runs the deferred resource task only after the real close event fires', async () => {
    // Deliberately does not assert on invocation.terminated(): that flag
    // reflects the supervisor's own confirmation outcome, and stays `true`
    // regardless of whether hasClosed treats a missing PID as closed or
    // requires the real 'close' event -- it cannot distinguish the two, so
    // it never doubles as proof the event fired. A listener owned by this
    // test, independent of the module's internal wiring, is what actually
    // proves that.
    const invocation: SupervisedCli = spawnSupervised('/definitely/not/an-ambercast-command', [], process.cwd(), process.env, timings);
    let sawClose = false;
    invocation.child.once('close', () => { sawClose = true; });
    const registry = createCleanupRegistry();
    registry.registerSupervisor({ terminateAndConfirm: invocation.terminateAndConfirm });
    let resourceRanWithCloseObserved: boolean | undefined;
    registry.deferResource(() => { resourceRanWithCloseObserved = sawClose; });

    await expect(registry.run(() => invocation.result)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(resourceRanWithCloseObserved).toBe(true);
  });

  it('skips the resource task when close never fires, without leaking a live group', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation: SupervisedCli = spawnSupervised('/definitely/not/an-ambercast-command', [], process.cwd(), process.env, timings);
    invocation.child.removeAllListeners('close');
    const registry = createCleanupRegistry();
    registry.registerSupervisor({ terminateAndConfirm: invocation.terminateAndConfirm });
    const resource = vi.fn();
    registry.deferResource(resource);

    const run = registry.run(() => invocation.result);
    await expect(run).rejects.toBeInstanceOf(AggregateError);
    await run.catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({ code: 'ENOENT' });
      expect(errors[1]).toMatchObject({ message: expect.stringMatching(/did not confirm termination/i) });
    });

    expect(resource).not.toHaveBeenCalled();
    expect(signalsSent(kill)).toEqual([]);
  });
});
