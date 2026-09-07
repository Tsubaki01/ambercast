/**
 * Composes the concrete services shared by the `generate` and `run` command
 * paths.
 *
 * Generation needs event delivery and the shared filesystem services while it
 * resolves AI only for a real dispatch; replay needs browser driver resolution,
 * secret lookup, and the same event delivery. One composer holds that real
 * dependency set so command paths converge on the same Ports-aligned
 * application boundary instead of duplicating composition policy in a
 * parallel run-specific helper.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createLayoutResolver, type LayoutResolver } from '#core/layout/resolve.js';
import type { InstructionCoveredAiExecutor } from '#ports/ai.js';
import type { BrowserDriverResolver } from '#ports/index.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock, EventSink, SecretsProvider } from '#ports/system.js';
import { createFsTestFileDiscovery, type TestFileDiscovery } from './test-file-discovery.js';

/**
 * The inputs used to compose shared application services for `generate` and
 * `run`.
 */
export interface CreateAmbercastOptions {
  /** Complete command configuration. */
  readonly config: ResolvedConfig;

  /**
   * Optional concrete executor selection for callers that need an adapter in
   * the composed result. Generation omits it and resolves provider policy only
   * when an AI dispatch is needed; replay always supplies a fixed literal for
   * the shared composer shape.
   */
  readonly aiProvider?: 'claude' | 'codex';

  /**
   * Driver resolver supplied for replay. Its `browserDriver` name exactly
   * matches `Ports`, keeping the composed surface aligned as use cases
   * accumulate.
   */
  readonly browserDriver?: BrowserDriverResolver;

  /**
   * Secret lookup supplied for replay. The `secrets` name intentionally
   * matches `Ports`, rather than introducing `secretsProvider` for the
   * same dependency.
   */
  readonly secrets?: SecretsProvider;

  /**
   * Lifecycle event delivery for generation and replay. The `events` name
   * exactly matches `Ports`, rather than creating a parallel `eventSink`
   * vocabulary here.
   */
  readonly events: EventSink;
}

/**
 * Concrete services made available to the generate and run command boundaries.
 */
export interface Ambercast {
  /** Filesystem-backed artifact persistence. */
  readonly storage: StorageAdapter;

  /** Companion-path resolver for the configured test tree. */
  readonly layout: LayoutResolver;

  /** The selected provider adapter when composition was asked to create one. */
  readonly aiExecutor?: InstructionCoveredAiExecutor;

  /** Host clock used by command reporting and replay's per-case duration measurement. */
  readonly clock: Clock;

  /** Filesystem discovery for the bounded configured test patterns. */
  readonly discoverTestFiles: TestFileDiscovery;

  /**
   * Replay driver resolution, named `browserDriver` to precisely mirror
   * `Ports` as the application composition shape converges.
   */
  readonly browserDriver?: BrowserDriverResolver;

  /**
   * Replay secret lookup, retaining Ports' `secrets` name rather than a
   * second `secretsProvider` name for the same port.
   */
  readonly secrets?: SecretsProvider;

  /**
   * Lifecycle event delivery for generation and replay, retaining Ports'
   * `events` name rather than a second `eventSink` name for the same port.
   */
  readonly events: EventSink;
}

/**
 * Composes dependencies for one configured command invocation.
 *
 * @param options - Configuration, optional provider selection, and any replay ports.
 * @returns The shared service set required by command composition and reporting.
 * @remarks
 * This is intentionally not a general ports factory. It serves the two real
 * callers, `generate` and `run`, and grows only with dependencies one of them
 * actually uses. Generation and replay both make `events` a real dependency;
 * command-specific random and environment adapters remain direct imports at
 * their consuming runtime boundary, following the established randomness
 * pattern instead of widening this shared composer. Keeping one composer
 * instead of a speculative `createRunAmbercast()` split preserves a single,
 * visibly Ports-aligned application boundary.
 *
 * `aiProvider` is optional because generation resolves provider policy at its
 * first real AI dispatch rather than while composing shared services.
 * Omitting it leaves `aiExecutor` absent from the result; `run-command.ts`
 * passes a fixed `aiProvider: 'claude'` literal for the shared composer shape.
 * That executor is not passed to `run()`—`RunDeps`
 * has no `aiExecutor` field—so a grounded replay still requires no AI CLI.
 *
 * `browserDriver` and `secrets` remain optional in both input and result
 * because generation supplies neither. Replay keeps local, non-optional
 * references to the same values it passes here and gives those references
 * directly to `run()`'s non-optional `RunDeps` fields; it does not read them
 * back from the optional `Ambercast` properties and therefore needs no unsound
 * assertion. The returned optional fields still make the composed shape
 * visibly converge toward `Ports` for consumers that do need them.
 */
export function createAmbercast(options: CreateAmbercastOptions): Ambercast {
  return {
    storage: createFsStorage(),
    layout: createLayoutResolver(options.config),
    // Omission is a composition-time no-op: the result has no key, and
    // composition performs neither factory construction nor an environment read.
    ...(options.aiProvider === undefined ? {} : {
      aiExecutor: AI_EXECUTOR_FACTORIES[options.aiProvider]({
        run: createSpawnCommandRunner({ env: readCommandEnvironment() }),
      }),
    }),
    clock: createSystemClock(),
    discoverTestFiles: createFsTestFileDiscovery(),
    ...(options.browserDriver === undefined ? {} : { browserDriver: options.browserDriver }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    events: options.events,
  };
}
