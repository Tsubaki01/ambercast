/**
 * Adapts Codex CLI's non-interactive structured-output protocol to the AI
 * port without exposing temporary schema-file management to callers.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectOnAbort } from '#core/ai/reject-on-abort.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { buildStructuredPrompt } from '#adapters/ai/shared/prompt-envelope.js';
import { validateAiResponse } from '#adapters/ai/shared/response-validator.js';
import {
  createSpawnCommandRunner,
  type CommandRunner,
} from '#adapters/ai/shared/command-runner.js';
import type {
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
} from '#ports/ai.js';

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Creates the Codex CLI executor.
 *
 * @param deps - Optional subprocess seam for hermetic adapter tests.
 * @returns An executor named `codex-cli`.
 * @remarks
 * `execute` writes the output schema to a unique
 * temporary directory, pipes the isolated prompt to
 * `codex exec --sandbox read-only --json --output-schema <schema> -o <output> -`,
 * then validates the output file's text. A best-effort `finally` path attempts
 * directory removal after every provider outcome without replacing that
 * outcome when cleanup fails. Nonzero, signaled, and spawn-failure outcomes
 * classify as an unavailable executor; `codex --version` probes never throw.
 *
 * Its `executeAgentic` method gives an already-aborted signal precedence,
 * then rejects before spawning because this adapter has no browser session to
 * direct. The production default is `createSpawnCommandRunner()`, while
 * an injected runner leaves the protocol deterministic under test.
 */
export function createCodexCliExecutor(deps: { readonly run?: CommandRunner } = {}): AiExecutor {
  const run = deps.run ?? createSpawnCommandRunner();

  return {
    name: 'codex-cli',
    execute<T>(request: AiExecuteRequest<T>): Promise<AiExecuteResult<T>> {
      let work: Promise<AiExecuteResult<T>> | undefined;
      const guarded = rejectOnAbort(request.signal, () => {
        work = (async () => {
        const directory = await mkdtemp(join(tmpdir(), 'ambercast-codex-'));
        const schemaPath = join(directory, 'response.schema.json');
        const outputPath = join(directory, 'response.json');

        try {
          await writeFile(schemaPath, JSON.stringify(request.responseSchema));

          let result;
          try {
            result = await run(
              'codex',
              ['exec', '--sandbox', 'read-only', '--json', '--output-schema', schemaPath, '-o', outputPath, '-'],
              {
                input: buildStructuredPrompt(request),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              },
            );
          } catch (error) {
            throw new AiExecutorUnavailableError('The Codex CLI is unavailable.', { provider: 'codex' }, { cause: error });
          }

          if (result.outcome !== 'exited' || result.exitCode !== 0) {
            throw new AiExecutorUnavailableError('The Codex CLI did not complete the request.', { provider: 'codex' });
          }

          let raw: string;
          try {
            raw = await readFile(outputPath, 'utf8');
          } catch (error) {
            throw new AiExecutorUnavailableError('The Codex CLI did not produce a response file.', { provider: 'codex' }, { cause: error });
          }

          return { data: validateAiResponse(raw, request.responseSchema), raw };
        } finally {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
        })();
        return work;
      });

      return guarded.catch(async (error: unknown) => {
        if (request.signal?.aborted && work !== undefined) {
          await work.catch(() => undefined);
        }
        throw error;
      });
    },
    async executeAgentic(request: AiAgenticRequest): Promise<AiAgenticResult> {
      if (request.signal?.aborted) {
        throw abortReason(request.signal);
      }

      throw new AiExecutorUnavailableError('Agentic browser-directed execution is unavailable for the Codex CLI adapter.');
    },
    async isAvailable(): Promise<boolean> {
      try {
        const result = await run('codex', ['--version']);
        return result.outcome === 'exited' && result.exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}
