/**
 * Resolves configured AI-provider policy into one concrete provider.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { composeAiDeadline, hasAiDeadlineExpired } from '#core/ai/ai-deadline.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import {
  AiExecutorUnavailableError,
  type AiProviderAvailabilityAttempt,
} from '#core/errors/ai-executor-unavailable-error.js';

/**
 * Bounds one executable liveness probe independently of model-generation
 * budgets. Automatic selection accepts up to eight seconds for each of its
 * two sequential providers before reporting unavailability, because a quick
 * version probe has no reason to inherit a potentially much longer AI-call
 * budget.
 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Resolves configured AI-provider policy into one concrete provider.
 *
 * @remarks
 * A command-line override wins, explicit configured providers pass through,
 * and `auto` probes lazy Claude then Codex factories in that fixed order.
 * If neither probe is available it throws `AiExecutorUnavailableError` with
 * one timeout-or-not-found diagnostic attempt for each provider that was
 * probed. Caller cancellation still takes precedence over recording an
 * unsuccessful probe.
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
    const attempts: AiProviderAvailabilityAttempt[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      signal?.throwIfAborted();
      const deadline = composeAiDeadline(signal, PROBE_TIMEOUT_MS);
      const isAvailable = await AI_EXECUTOR_FACTORIES[provider]({
        run: createSpawnCommandRunner({ env: readCommandEnvironment() }),
      }).isAvailable(deadline.signal);
      signal?.throwIfAborted();
      if (isAvailable) {
        return provider;
      }
      attempts.push({ provider, reason: hasAiDeadlineExpired(deadline) ? 'timeout' : 'not-found' });
    }

    throw new AiExecutorUnavailableError('No AI provider is available.', { attempts });
  })();
}
