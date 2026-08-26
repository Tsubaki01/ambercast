/*
 * Provides the interactive confirmation-answer reader at the designated
 * system-adapter boundary.
 *
 * Healing command composition obtains the answer exchange here so confirmation
 * policy can remain explicit and deterministic under test without observing
 * process-standard input directly.
 */

/**
 * Candidate details required to describe an impending healing write.
 *
 * The adapter depends only on this transport-neutral projection, allowing
 * command composition to supply its usecase-specific commit capabilities
 * without reversing the architecture's adapter-to-usecase dependency flow.
 */
export interface ConfirmationCandidate {
  /** Prompt file whose paired artifacts the candidate persists. */
  readonly file: string;

  /** Neutral repair description suitable for a confirmation exchange. */
  readonly healingSummary: string;
}

/** Reads one authorization decision for the supplied pending candidates. */
export type ConfirmationAnswerReader = (
  commits: ReadonlyMap<string, ConfirmationCandidate>,
  signal?: AbortSignal,
) => Promise<boolean>;

/** Process streams used exclusively for the confirmation exchange. */
export interface ConfirmationAnswerStreams {
  readonly stdin: Pick<NodeJS.ReadableStream, 'once' | 'removeListener' | 'pause' | 'resume'>;
  readonly stderr: Pick<NodeJS.WritableStream, 'write'>;
}

function displayLine(value: string): string {
  return value.replace(/[\\\u0000-\u001F\u007F-\u009F]/g, (character) => {
    if (character === '\\') {
      return '\\\\';
    }
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`;
  });
}

/**
 * Creates the reader used to obtain confirmation before pending healing
 * candidates are persisted.
 *
 * @returns A function that asks about the supplied candidates and reports
 * whether the caller authorizes every pending commit capability.
 *
 * @remarks
 * This adapter owns the concrete terminal exchange here,
 * rather than letting command composition select a process-stdio mechanism
 * inline. Keeping that exchange behind this factory lets runtime tests supply
 * an affirmative or declining response deterministically while the runtime
 * retains the separate policy for whether asking is appropriate at all.
 */
export function createConfirmationAnswerReader(
  streams: ConfirmationAnswerStreams = { stdin: process.stdin, stderr: process.stderr },
): ConfirmationAnswerReader {
  return async (commits, signal): Promise<boolean> => {
    if (signal?.aborted === true) {
      return false;
    }

    for (const { file, healingSummary } of commits.values()) {
      streams.stderr.write(`${displayLine(file)}: ${displayLine(healingSummary)}\n`);
    }

    streams.stderr.write('Apply these healing changes? [y/N] ');
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (answer: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(answer);
      };
      const onData = (chunk: Buffer | string): void => {
        const answer = chunk.toString().trim().toLowerCase();
        finish(answer === 'y' || answer === 'yes');
      };
      const onEnd = (): void => {
        finish(false);
      };
      const onError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        finish(false);
      };
      const cleanup = (): void => {
        streams.stdin.removeListener('data', onData);
        streams.stdin.removeListener('end', onEnd);
        streams.stdin.removeListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        streams.stdin.pause();
      };

      streams.stdin.once('data', onData);
      streams.stdin.once('end', onEnd);
      streams.stdin.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      streams.stdin.resume();
    });
  };
}
