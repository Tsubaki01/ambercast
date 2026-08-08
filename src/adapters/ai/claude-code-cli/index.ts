/**
 * Adapts Claude Code's non-interactive structured-output protocol to the AI
 * port without leaking command-line details into callers.
 */

import { abortReason, rejectOnAbort } from '#core/ai/reject-on-abort.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import {
  buildStructuredPrompt,
} from '#adapters/ai/shared/prompt-envelope.js';
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
  AiUsage,
} from '#ports/ai.js';

function responseInvalid(raw: string, message: string, cause?: unknown): AiResponseInvalidError {
  return new AiResponseInvalidError(message, { raw, issues: [{ path: '', message }] }, { cause });
}

function usageFrom(value: unknown): AiUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === 'number'
    ? usage.input_tokens
    : typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number'
    ? usage.output_tokens
    : typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;

  return inputTokens === undefined && outputTokens === undefined
    ? undefined
    : {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    };
}

/**
 * Creates the Claude Code CLI executor.
 *
 * @param deps - Optional subprocess seam for hermetic adapter tests.
 * @returns An executor named `claude-code-cli`.
 * @remarks
 * `execute` sends an isolated prompt through
 * stdin to `claude -p --output-format json --json-schema <inline-schema>` and
 * validates its JSON result field before returning it. A nonzero, signaled,
 * unspawnable, or argument-oversized command becomes
 * `AiExecutorUnavailableError`; availability probes use `claude --version`
 * and fold every failure into `false`.
 *
 * Its `executeAgentic` method first honors an already-aborted signal, then
 * rejects with `AiExecutorUnavailableError` before building a prompt or
 * spawning a process because this adapter does not perform browser-directed
 * dispatch.
 * The production default is `createSpawnCommandRunner()` while injected
 * runners keep the command protocol testable without a live CLI.
 */
export function createClaudeCodeCliExecutor(deps: { readonly run?: CommandRunner } = {}): AiExecutor {
  const run = deps.run ?? createSpawnCommandRunner();

  return {
    name: 'claude-code-cli',
    execute<T>(request: AiExecuteRequest<T>): Promise<AiExecuteResult<T>> {
      return rejectOnAbort(request.signal, async () => {
        const responseSchema = JSON.stringify(request.responseSchema);
        if (responseSchema.length > 200_000) {
          throw new AiExecutorUnavailableError(
            'The Claude Code CLI response schema is too large to pass as an argument.',
            { provider: 'claude', schemaLength: responseSchema.length },
          );
        }

        let result;
        try {
          result = await run(
            'claude',
            ['-p', '--output-format', 'json', '--json-schema', responseSchema],
            {
              input: buildStructuredPrompt(request),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            },
          );
        } catch (error) {
          throw new AiExecutorUnavailableError('The Claude Code CLI is unavailable.', { provider: 'claude' }, { cause: error });
        }

        if (result.outcome !== 'exited' || result.exitCode !== 0) {
          throw new AiExecutorUnavailableError('The Claude Code CLI did not complete the request.', {
            provider: 'claude',
            ...(result.stderr === '' ? {} : { stderrExcerpt: result.stderr.slice(0, 1_000) }),
          });
        }

        let response: unknown;
        try {
          response = JSON.parse(result.stdout);
        } catch (error) {
          throw responseInvalid(result.stdout, 'The Claude Code CLI returned malformed JSON.', error);
        }

        if (response === null || typeof response !== 'object' || Array.isArray(response)) {
          throw responseInvalid(result.stdout, 'The Claude Code CLI response did not contain a string result.');
        }

        const payload = response as Record<string, unknown>;
        if (typeof payload.result !== 'string') {
          throw responseInvalid(result.stdout, 'The Claude Code CLI response did not contain a string result.');
        }

        const data = validateAiResponse(payload.result, request.responseSchema);
        const usage = usageFrom(payload.usage);
        return usage === undefined ? { data, raw: payload.result } : { data, raw: payload.result, usage };
      });
    },
    async executeAgentic(request: AiAgenticRequest): Promise<AiAgenticResult> {
      if (request.signal?.aborted) {
        throw abortReason(request.signal);
      }

      throw new AiExecutorUnavailableError('Agentic browser-directed execution is unavailable for the Claude Code CLI adapter.');
    },
    async isAvailable(signal?: AbortSignal): Promise<boolean> {
      try {
        const result = await run('claude', ['--version'], signal === undefined ? undefined : { signal });
        return result.outcome === 'exited' && result.exitCode === 0;
      } catch {
        return false;
      }
    },
  };
}
