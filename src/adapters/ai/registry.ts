/**
 * Lists lazy AI-executor factories for runtime provider selection.
 */

import type { AiExecutor } from '#ports/ai.js';
import { createClaudeCodeCliExecutor } from './claude-code-cli/index.js';
import { createCodexCliExecutor } from './codex-cli/index.js';

/**
 * A concrete configured provider name accepted by the executor registry.
 */
export type AiProviderName = 'claude' | 'codex';

/**
 * Lazily creates each supported AI executor.
 *
 * @remarks
 * Factories deliberately defer construction and availability probing. Runtime
 * provider resolution owns the `auto` policy and asks only for the provider
 * it needs, avoiding a startup probe or command spawn for an unused executor.
 */
export const AI_EXECUTOR_FACTORIES: Readonly<Record<AiProviderName, () => AiExecutor>> = {
  claude: createClaudeCodeCliExecutor,
  codex: createCodexCliExecutor,
};
