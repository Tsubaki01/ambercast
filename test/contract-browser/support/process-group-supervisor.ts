/**
 * Supplies the liveness observations and signaling used to supervise a process group.
 *
 * @remarks Injection keeps the escalation policy independent from process APIs
 * and allows callers to define how their runtime observes a group.
 */
export interface ProcessGroupProbes {
  /** @returns Whether the supervised child's own PID is still live. */
  readonly isChildPidAlive: () => boolean;
  /** @returns Whether the child's stdio streams have fully closed. */
  readonly hasClosed: () => boolean;
  /** @returns Whether any member, including a descendant, remains in the POSIX group. */
  readonly isGroupAlive: () => boolean;
  /**
   * Sends a signal to the process group.
   *
   * @param signal - The POSIX signal to deliver.
   * @throws Propagates signaling failures other than an already-gone group race.
   */
  readonly signalGroup: (signal: NodeJS.Signals) => void;
}

/**
 * Configures escalation and confirmation timing for a process group.
 */
export interface ProcessGroupSupervisorTimings {
  /** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
  readonly sigkillAfterMs: number;
  /** Milliseconds to wait after SIGKILL before rejecting confirmation. */
  readonly failAfterMs: number;
  /** Milliseconds between fresh, simultaneous liveness checks. */
  readonly pollIntervalMs: number;
}

/**
 * Controls termination confirmation for one detached process group.
 */
export interface ProcessGroupSupervisor {
  /**
   * Terminates the group and confirms that its child, stdio, and every group
   * member are gone at the same observation point.
   *
   * @returns A permanently memoized promise that resolves after confirmation.
   * @throws {Error} If confirmation is still incomplete after the SIGTERM and
   * SIGKILL grace windows.
   * @throws Propagates a probe or signal failure. Every later call returns the
   * same rejection and never sends another signal.
   * @remarks Calls share one lifetime outcome so independent callers cannot
   * extend the termination budget or repeat escalation.
   */
  readonly terminateAndConfirm: () => Promise<void>;
  /** @returns Whether `terminateAndConfirm` has confirmed termination. */
  readonly terminated: () => boolean;
}

/**
 * Creates a SIGTERM-to-SIGKILL supervisor for one process group.
 *
 * @param probes - The caller's liveness and signaling operations.
 * @param timings - The escalation windows and polling interval.
 * @returns A supervisor whose termination outcome is shared by all callers.
 * @remarks Confirmation requires all three probes to agree in one poll; this
 * avoids accepting a stale combination of independently observed states.
 */
export function createProcessGroupSupervisor(
  probes: ProcessGroupProbes,
  timings: ProcessGroupSupervisorTimings,
): ProcessGroupSupervisor {
  let outcome: Promise<void> | undefined;
  let confirmedTerminated = false;

  const hasConfirmedTermination = (): boolean => {
    const childAlive = probes.isChildPidAlive();
    const closed = probes.hasClosed();
    const groupAlive = probes.isGroupAlive();
    return !childAlive && closed && !groupAlive;
  };

  const waitForConfirmation = async (deadline: number): Promise<boolean> => {
    while (true) {
      if (performance.now() >= deadline) {
        return false;
      }
      if (hasConfirmedTermination()) {
        return true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(timings.pollIntervalMs, remaining)));
    }
  };

  const terminateAndConfirm = (): Promise<void> => {
    if (outcome !== undefined) {
      return outcome;
    }

    let resolveOutcome!: () => void;
    let rejectOutcome!: (error: unknown) => void;
    outcome = new Promise<void>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    void outcome.catch(() => undefined);

    void (async () => {
      try {
        if (hasConfirmedTermination()) {
          confirmedTerminated = true;
          resolveOutcome();
          return;
        }

        const sigkillAt = performance.now() + timings.sigkillAfterMs;
        probes.signalGroup('SIGTERM');
        if (await waitForConfirmation(sigkillAt)) {
          confirmedTerminated = true;
          resolveOutcome();
          return;
        }

        const failAt = performance.now() + timings.failAfterMs;
        probes.signalGroup('SIGKILL');
        if (await waitForConfirmation(failAt)) {
          confirmedTerminated = true;
          resolveOutcome();
          return;
        }

        rejectOutcome(new Error('The supervised process group did not confirm termination after SIGKILL grace.'));
      } catch (error) {
        rejectOutcome(error);
      }
    })();

    return outcome;
  };

  return {
    terminateAndConfirm,
    terminated: () => confirmedTerminated,
  };
}
