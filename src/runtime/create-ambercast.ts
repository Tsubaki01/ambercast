/**
 * Composes exactly the concrete dependencies required by the generate command.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createLayoutResolver, type LayoutResolver } from '#core/layout/resolve.js';
import type { AiExecutor } from '#ports/ai.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock } from '#ports/system.js';
import { createFsTestFileDiscovery, type TestFileDiscovery } from './test-file-discovery.js';

/**
 * The fully resolved inputs needed to compose one generation application.
 */
export interface CreateAmbercastOptions {
  /** Complete configuration, including already-resolved AI provider policy. */
  readonly config: ResolvedConfig;

  /** Concrete executor selection; `auto` is resolved before composition. */
  readonly aiProvider: 'claude' | 'codex';
}

/**
 * Concrete services consumed by the generation use case and command boundary.
 */
export interface Ambercast {
  /** Filesystem-backed artifact persistence. */
  readonly storage: StorageAdapter;

  /** Companion-path resolver for the configured test tree. */
  readonly layout: LayoutResolver;

  /** The selected provider adapter. */
  readonly aiExecutor: AiExecutor;

  /** Host clock used by command reporting, not by generation itself. */
  readonly clock: Clock;

  /** Filesystem discovery for the bounded configured test patterns. */
  readonly discoverTestFiles: TestFileDiscovery;
}

/**
 * Composes dependencies for one configured generate invocation.
 *
 * @param options - Resolved configuration and a concrete AI-provider choice.
 * @returns The narrow service set required by generation and reporting.
 * @remarks
 * This is intentionally not a general ports factory: browser driver, random
 * source, secrets provider, environment information, and event sink have no
 * generate caller. Omitting fabricated no-op or throwing stand-ins preserves
 * a composition boundary that grows only with a real use-case dependency.
 */
export function createAmbercast(options: CreateAmbercastOptions): Ambercast {
  return {
    storage: createFsStorage(),
    layout: createLayoutResolver(options.config),
    aiExecutor: AI_EXECUTOR_FACTORIES[options.aiProvider](),
    clock: createSystemClock(),
    discoverTestFiles: createFsTestFileDiscovery(),
  };
}
