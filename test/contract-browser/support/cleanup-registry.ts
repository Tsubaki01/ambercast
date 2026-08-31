/**
 * Confirms that a process group no longer needs resources owned by this registry.
 */
export interface Supervisor {
  /**
   * Waits until the supervised group is safe to clean up after.
   *
   * @returns A promise that resolves after termination is confirmed.
   * @throws A failure to terminate or confirm the group.
   */
  readonly terminateAndConfirm: () => Promise<void>;
}

/**
 * Releases one resource synchronously or asynchronously.
 *
 * @returns Completion of the resource release.
 */
export type CleanupTask = () => Promise<void> | void;

/**
 * Coordinates a single operation with its registered cleanup work.
 *
 * @remarks Supervisors form a fail-closed gate: resources are released only
 * after every supervisor confirms termination, preventing cleanup from racing
 * a process that can still reference those resources.
 */
export interface CleanupRegistry {
  /**
   * Adds a supervisor to run before resource cleanup.
   *
   * @param supervisor - The termination confirmation to await.
   * @throws {Error} If the operation has already settled and registration is sealed.
   */
  registerSupervisor(supervisor: Supervisor): void;
  /**
   * Adds a resource cleanup task.
   *
   * @param task - The task to run after all supervisors succeed.
   * @throws {Error} If the operation has already settled and registration is sealed.
   */
  deferResource(task: CleanupTask): void;
  /**
   * Runs the operation and performs the registered cleanup.
   *
   * @param operation - The asynchronous operation whose result is returned after cleanup.
   * @returns The operation value when the operation and cleanup all succeed.
   * @throws The original failure directly when exactly one operation,
   * supervisor, or resource failure occurs.
   * @throws {AggregateError} When more than one failure occurs. Its `errors`
   * array is ordered as the operation rejection reason, supervisor failures in
   * registration order, then resource failures in reverse registration order.
   * @throws {Error} Synchronously if called more than once on this registry.
   * @remarks All supervisors are attempted even after one fails. Resource
   * cleanup is skipped if any supervisor fails and otherwise proceeds in LIFO
   * order, continuing after individual resource failures.
   */
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Creates a registry for one operation and its cleanup.
 *
 * @returns An empty, single-use cleanup registry.
 * @remarks A registry seals registrations as soon as its operation settles so
 * teardown cannot miss work registered while it is already in progress.
 */
export function createCleanupRegistry(): CleanupRegistry {
  const supervisors: Supervisor[] = [];
  const resources: CleanupTask[] = [];
  let hasRun = false;
  let sealed = false;

  const assertOpen = (): void => {
    if (sealed) {
      throw new Error('Cleanup registry registration is sealed after the operation settles.');
    }
  };

  return {
    registerSupervisor: (supervisor) => {
      assertOpen();
      supervisors.push(supervisor);
    },
    deferResource: (task) => {
      assertOpen();
      resources.push(task);
    },
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      if (hasRun) {
        throw new Error('A cleanup registry can run only once.');
      }
      hasRun = true;

      return (async (): Promise<T> => {
        let operationOutcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          operationOutcome = { ok: true, value: await operation() };
        } catch (error) {
          operationOutcome = { ok: false, error };
        }
        sealed = true;

        const supervisorErrors: unknown[] = [];
        for (const supervisor of supervisors) {
          try {
            await supervisor.terminateAndConfirm();
          } catch (error) {
            supervisorErrors.push(error);
          }
        }

        const resourceErrors: unknown[] = [];
        if (supervisorErrors.length === 0) {
          for (const resource of resources.toReversed()) {
            try {
              await resource();
            } catch (error) {
              resourceErrors.push(error);
            }
          }
        }

        const errors = [
          ...(operationOutcome.ok ? [] : [operationOutcome.error]),
          ...supervisorErrors,
          ...resourceErrors,
        ];
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'The operation and cleanup reported multiple failures.');
        }
        if (operationOutcome.ok) {
          return operationOutcome.value;
        }
        throw operationOutcome.error;
      })();
    },
  };
}
