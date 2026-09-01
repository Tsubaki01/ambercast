import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProcessGroupSupervisor } from './process-group-supervisor.js';

/**
 * Configures the watchdog and process-group confirmation windows.
 */
export interface SupervisedCliTimings {
  /** Milliseconds from spawn until SIGTERM for a child that has not closed. */
  readonly sigtermAfterMs: number;
  /** Milliseconds to wait after SIGTERM before SIGKILL. */
  readonly sigkillAfterMs: number;
  /** Milliseconds to wait after SIGKILL before confirmation rejects. */
  readonly failAfterMs: number;
  /** Milliseconds between process-group confirmation probes. */
  readonly pollIntervalMs: number;
}

/**
 * Uses SPEC-E3a's one-minute execution allowance and bounded escalation
 * windows to limit the total lifetime of an uncooperative process group.
 */
export const DEFAULT_SUPERVISED_CLI_TIMINGS: SupervisedCliTimings = {
  sigtermAfterMs: 60_000,
  sigkillAfterMs: 5_000,
  failAfterMs: 5_000,
  pollIntervalMs: 50,
};

/**
 * Describes a started process after its group has been confirmed terminated.
 */
export interface SupervisedCliResult {
  /** Buffered stdout from the child. */
  readonly stdout: Buffer;
  /** Buffered stderr from the child. */
  readonly stderr: Buffer;
  /** Numeric exit status, or `null` when the process ended from a signal. */
  readonly exitCode: number | null;
  /** Terminating signal, or `null` when the process exited normally. */
  readonly signalCode: NodeJS.Signals | null;
}

/**
 * Provides a detached child and the shared supervision result for its group.
 */
export interface SupervisedCli {
  /**
   * The detached child-process handle. Its PID is also the POSIX group ID;
   * stdin is ignored and stdout and stderr are readable pipes.
   */
  readonly child: ChildProcess;
  /**
   * Resolves with buffered output only after group termination is confirmed.
   *
   * @returns The confirmed exit result for a command that started.
   * @throws The original spawn error if the command never starts.
   * @throws The confirmation error if a started group cannot be confirmed gone.
   */
  readonly result: Promise<SupervisedCliResult>;
  /**
   * Requests termination and waits for full group confirmation.
   *
   * @returns The shared confirmation promise.
   * @throws A signaling, probe, or confirmation failure.
   */
  readonly terminateAndConfirm: () => Promise<void>;
  /** @returns Whether the shared confirmation has resolved. */
  readonly terminated: () => boolean;
}

/**
 * Starts an arbitrary command in a detached POSIX process group.
 *
 * The child receives ignored stdin and piped stdout and stderr. Its `result`
 * rejects with the original spawn error when no child starts, or with a
 * termination-confirmation failure when a started group cannot be confirmed.
 *
 * @param command - Executable path or command to start.
 * @param argv - Arguments passed to the command.
 * @param cwd - Working directory for the child.
 * @param env - Environment for the child.
 * @param timings - Optional watchdog and confirmation timings.
 * @returns The child handle and shared supervision API.
 * @throws Does not throw synchronously for spawn failure; consume `result` for
 * the original spawn error or a later confirmation failure.
 */
export function spawnSupervised(
  command: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timings?: SupervisedCliTimings,
): SupervisedCli {
  const effectiveTimings = timings ?? DEFAULT_SUPERVISED_CLI_TIMINGS;
  const child = spawn(command, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let closed = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  const wasNotFound = (error: unknown): boolean => (
    error instanceof Error && 'code' in error && error.code === 'ESRCH'
  );
  const isAlive = (target: number | undefined): boolean => {
    if (target === undefined) return false;
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      if (wasNotFound(error)) return false;
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
      throw error;
    }
  };
  const supervisor = createProcessGroupSupervisor({
    isChildPidAlive: () => isAlive(pid),
    // An absent PID (spawn never produced a child, e.g. ENOENT) is a
    // liveness fact only, never a substitute for observing the real
    // `'close'` event: Node still emits `'close'` shortly after `'error'`
    // even when spawn fails (#242), so `closed` alone is authoritative.
    // Treating a missing PID as "closed" would let a CleanupRegistry
    // release its resources -- via a Supervisor built from this
    // function's `terminateAndConfirm` -- before that event
    // fires. When `'close'` never arrives in some abnormal runtime, the
    // existing SIGTERM/SIGKILL grace ladder in `createProcessGroupSupervisor`
    // still bounds the wait and fails the supervisor closed, matching every
    // other unconfirmed case.
    hasClosed: () => closed,
    isGroupAlive: () => isAlive(pid === undefined ? undefined : -pid),
    signalGroup: (signal) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!wasNotFound(error)) throw error;
      }
    },
  }, effectiveTimings);

  let settled = false;
  let resolveResult!: (result: SupervisedCliResult) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<SupervisedCliResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settleWithConfirmation = (): void => {
    void supervisor.terminateAndConfirm().then(
      () => {
        // A successful supervisor confirmation normally implies `'close'`,
        // but only that listener owns the exit tuple. Let it make a later
        // settle attempt if an event-loop ordering exposes confirmation first.
        if (settled || !closed) return;
        settled = true;
        resolveResult({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signalCode });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectResult(error);
      },
    );
  };
  const watchdog = setTimeout(() => {
    if (!settled) settleWithConfirmation();
  }, effectiveTimings.sigtermAfterMs);

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.on('error', (error) => {
    if (!settled) {
      settled = true;
      rejectResult(error);
    }
    clearTimeout(watchdog);
    void supervisor.terminateAndConfirm().catch(() => undefined);
  });
  child.on('close', (code, signal) => {
    closed = true;
    exitCode = code;
    signalCode = signal;
    clearTimeout(watchdog);
    settleWithConfirmation();
  });

  return {
    child,
    result,
    terminateAndConfirm: supervisor.terminateAndConfirm,
    terminated: supervisor.terminated,
  };
}

/**
 * Starts the built Ambercast CLI in a detached supervised process group with
 * ignored stdin and piped stdout and stderr.
 *
 * @param args - Arguments passed to the CLI.
 * @param cwd - Working directory for the CLI.
 * @param env - Environment for the CLI.
 * @param timings - Optional watchdog and confirmation timings.
 * @returns The child handle and shared supervision API.
 * @throws Does not throw synchronously for spawn failure; `result` rejects
 * with the original spawn error or a later confirmation failure.
 */
export function spawnSupervisedCli(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timings?: SupervisedCliTimings,
): SupervisedCli {
  const binPath = fileURLToPath(new URL('../../../bin/ambercast.js', import.meta.url));
  return spawnSupervised(process.execPath, [binPath, ...args], cwd, env, timings);
}
