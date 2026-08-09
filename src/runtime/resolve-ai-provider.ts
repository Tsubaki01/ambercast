/**
 * Resolves configured AI-provider policy into one concrete provider.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';

/**
 * Resolves configured AI-provider policy into one concrete provider.
 *
 * @remarks
 * A command-line override wins, explicit configured providers pass through,
 * and `auto` probes lazy Claude then Codex factories in that fixed order.
 * If neither probe is available it throws `AiExecutorUnavailableError`.
 */
export function resolveAiProvider(
  configured: ResolvedConfig['ai']['provider'],
  override: 'claude' | 'codex' | undefined,
  signal?: AbortSignal,
): Promise<'claude' | 'codex'> {
  if (override !== undefined) {
    return Promise.resolve(override);
  }
  if (configured !== 'auto') {
    return Promise.resolve(configured);
  }

  return (async () => {
    for (const provider of ['claude', 'codex'] as const) {
      signal?.throwIfAborted();
      if (await AI_EXECUTOR_FACTORIES[provider]().isAvailable(signal)) {
        return provider;
      }
      signal?.throwIfAborted();
    }

    throw new AiExecutorUnavailableError('No AI provider is available.');
  })();
}
