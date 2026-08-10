/*
 * Exposes the command environment at the designated real system-adapter
 * boundary.
 *
 * Command composition injects this environment into the AI subprocess runner,
 * keeping the runner independent of mutable process-global state. Direct
 * environment access is intentionally confined to this ESLint-exempt adapter
 * path.
 */

/**
 * Reads the environment object used to start command-line child processes.
 *
 * @returns The live process environment object for command composition.
 *
 * @remarks
 * This remains a plain real-adapter function instead of a port because the
 * command runner already receives an environment object through its injected
 * dependencies. A separate zero-argument port would repeat that substitution
 * seam without adding an independently useful application boundary.
 *
 * Returning the live object lets the runner filter its environment at each
 * command invocation, so a caller that reuses the runner observes the current
 * values without granting the AI adapter access to the process global.
 */
export function readCommandEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
