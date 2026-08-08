import { rejectOnAbort } from '../../src/core/ai/reject-on-abort.js';
import type {
  CommandRunner,
  CommandRunOptions,
  CommandRunResult,
} from '../../src/adapters/ai/shared/command-runner.js';

export interface FakeCommandRunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

export type FakeCommandRunScript = CommandRunResult | Error | (
  (call: FakeCommandRunCall) => CommandRunResult | Promise<CommandRunResult>
);

export interface FakeCommandRunner {
  readonly run: CommandRunner;
  readonly calls: FakeCommandRunCall[];
}

export interface DeferredCommandRun {
  readonly promise: Promise<CommandRunResult>;
  resolve(value: CommandRunResult): void;
  reject(reason: unknown): void;
}

/**
 * Creates a scripted command runner with an inspectable invocation history.
 *
 * Scripts are consumed in call order to make adapter protocol tests describe
 * each subprocess outcome explicitly. The runner shares the production abort
 * boundary so a test can keep a signal-insensitive deferred script pending
 * while asserting that the caller-visible operation rejects first.
 */
export function createFakeCommandRunner(scripts: readonly FakeCommandRunScript[] = []): FakeCommandRunner {
  const calls: FakeCommandRunCall[] = [];
  let index = 0;

  return {
    calls,
    run(command, args, options) {
      const call: FakeCommandRunCall = { command, args, options };
      calls.push(call);
      const script = scripts[index];
      index += 1;

      return rejectOnAbort(options?.signal, async () => {
        if (script === undefined) {
          throw new Error(`Unscripted command invocation: ${command}`);
        }

        if (script instanceof Error) {
          throw script;
        }

        return typeof script === 'function' ? script(call) : script;
      });
    },
  };
}

/**
 * Creates a manually settled subprocess result for in-flight abort scenarios.
 */
export function createDeferredCommandRun(): DeferredCommandRun {
  let resolvePromise: ((value: CommandRunResult) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<CommandRunResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(reason) {
      rejectPromise?.(reason);
    },
  };
}
