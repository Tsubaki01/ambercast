/*
 * Provides the interactive-terminal check at the designated system-adapter
 * boundary.
 *
 * Healing command composition obtains this host fact here so confirmation
 * policy receives an explicit, mockable dependency instead of observing a
 * process TTY directly.
 */

/**
 * Creates the check used to determine whether a confirmation prompt is
 * available to the current caller.
 *
 * @returns A function that reports whether the current terminal is interactive.
 *
 * @remarks
 * This adapter observes the relevant process TTY state here,
 * rather than letting command composition read it inline. Keeping host
 * detection behind this factory makes the runtime's confirmation cases
 * deterministic under test and follows `process-environment-info.js`'s
 * established adapter boundary for mutable process facts. The deferred real
 * observation answers only whether a confirmation can be presented; the
 * healing runtime retains the separate authorization and CI policy.
 */
export function createTtyInteractivityCheck(
  processInfo: Pick<NodeJS.Process, 'stdin' | 'stderr'> = process,
): () => boolean {
  return (): boolean => processInfo.stdin.isTTY === true && processInfo.stderr.isTTY === true;
}
