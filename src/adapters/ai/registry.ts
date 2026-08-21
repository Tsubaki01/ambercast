/**
 * Lists lazy AI-executor factories for runtime provider selection.
 */

import type { InstructionCoveredAiExecutor } from '#ports/ai.js';
import type { AiProviderName } from '#core/errors/ai-executor-unavailable-error.js';
import type { CommandRunner } from './shared/command-runner.js';
import { createClaudeCodeCliExecutor } from './claude-code-cli/index.js';
import { createCodexCliExecutor } from './codex-cli/index.js';

/**
 * Lazily creates each supported AI executor.
 *
 * @remarks
 * Factories deliberately defer construction and availability probing. Runtime
 * provider resolution owns the `auto` policy and asks only for the provider
 * it needs, avoiding a startup probe or command spawn for an unused executor.
 */
export const AI_EXECUTOR_FACTORIES: Readonly<Record<
  AiProviderName,
  (deps: { readonly run: CommandRunner }) => InstructionCoveredAiExecutor
>> = {
  claude: createClaudeCodeCliExecutor,
  codex: createCodexCliExecutor,
};
