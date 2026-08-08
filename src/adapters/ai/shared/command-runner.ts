/**
 * Defines the small subprocess seam shared by AI command-line adapters.
 *
 * Keeping process creation behind this callable lets adapter tests assert a
 * deterministic request protocol without spawning authenticated provider
 * binaries. The real runner remains the single owner of child lifecycle and
 * stream collection.
 */

import { spawn } from 'node:child_process';

import { rejectOnAbort } from '#core/ai/reject-on-abort.js';

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * The terminal state of one child process that was not aborted by its caller.
 *
 * A signaled outcome identifies external process termination. A caller's own
 * abort is deliberately absent: the runner kills the child and
 * rejects with the abort reason instead of resolving this variant.
 */
export type CommandRunResult =
  | {
      readonly outcome: 'exited';
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    }
  | {
      readonly outcome: 'signaled';
      readonly stdout: string;
      readonly stderr: string;
      readonly signal: NodeJS.Signals;
    };

/**
 * Optional input and cancellation controls for one child invocation.
 */
export interface CommandRunOptions {
  /** Text written to stdin before it closes; omission closes stdin immediately. */
  readonly input?: string;

  /** Cancellation that kills the child and rejects the returned promise. */
  readonly signal?: AbortSignal;
}

/**
 * Runs a command with collected UTF-8 output.
 *
 * @param command - The executable name or path.
 * @param args - Positional command arguments.
 * @param options - Optional stdin text and abort signal.
 * @returns The completed non-abort process outcome.
 * @throws If spawning fails or the supplied signal aborts the call.
 * @remarks
 * The runner concatenates stdout and stderr data until the child closes. When
 * `options.signal` fires, it sends `SIGTERM` to the
 * child and rejects with the signal reason; it must never resolve a
 * self-inflicted abort as `outcome: 'signaled'`.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandRunOptions,
) => Promise<CommandRunResult>;

/**
 * Creates the production runner backed by Node child processes.
 *
 * @returns A runner that implements the subprocess and abort contract.
 * @remarks
 * This factory is the shared process-spawning implementation so the
 * two provider adapters cannot drift in stdin closure, output collection, or
 * cancellation semantics.
 */
export function createSpawnCommandRunner(): CommandRunner {
  return (command, args, options) => rejectOnAbort(options?.signal, () => new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const signal = options?.signal;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(() => reject(abortReason(signal!)));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdin?.on('error', () => undefined);
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (exitCode, terminationSignal) => {
      finish(() => {
        if (terminationSignal !== null) {
          resolve({ outcome: 'signaled', stdout, stderr, signal: terminationSignal });
          return;
        }

        resolve({ outcome: 'exited', stdout, stderr, exitCode: exitCode ?? 1 });
      });
    });

    child.stdin?.end(options?.input);
  }));
}
