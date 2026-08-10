/**
 * Composes the concrete services shared by the `generate` and `run` command
 * paths.
 *
 * Replay needs browser-driver resolution, secret lookup, and event delivery;
 * generation needs an AI executor; and both commands share filesystem storage,
 * layout, clock, and discovery. One composer holds that real dependency set so
 * command paths converge on the same Ports-aligned application boundary
 * instead of duplicating composition policy in a parallel run-specific helper.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createLayoutResolver, type LayoutResolver } from '#core/layout/resolve.js';
import type { AiExecutor } from '#ports/ai.js';
import type { BrowserDriverResolver } from '#ports/index.js';
import type { StorageAdapter } from '#ports/storage.js';
import type { Clock, EventSink, SecretsProvider } from '#ports/system.js';
import { createFsTestFileDiscovery, type TestFileDiscovery } from './test-file-discovery.js';

/**
 * The fully resolved inputs needed to compose the application for `generate`
 * and `run`.
 */
export interface CreateAmbercastOptions {
  /** Complete configuration, including already-resolved AI provider policy. */
  readonly config: ResolvedConfig;

  /**
   * Concrete executor selection. Generation resolves `auto` before
   * composition; replay supplies a fixed inert provider solely to satisfy the
   * shared required composer shape.
   */
  readonly aiProvider: 'claude' | 'codex';

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
   * Replay event delivery. The `events` name exactly matches `Ports`,
   * rather than creating a parallel `eventSink` vocabulary here.
   */
  readonly events?: EventSink;
}

/**
 * Concrete services made available to the generate and run command boundaries.
 */
export interface Ambercast {
  /** Filesystem-backed artifact persistence. */
  readonly storage: StorageAdapter;

  /** Companion-path resolver for the configured test tree. */
  readonly layout: LayoutResolver;

  /** The selected provider adapter. */
  readonly aiExecutor: AiExecutor;

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
   * Replay event delivery, retaining Ports' `events` name rather than a
   * second `eventSink` name for the same port.
   */
  readonly events?: EventSink;
}

/**
 * Composes dependencies for one configured command invocation.
 *
 * @param options - Resolved configuration, provider selection, and any replay ports.
 * @returns The shared service set required by command composition and reporting.
 * @remarks
 * This is intentionally not a general ports factory. It serves the two real
 * callers, `generate` and `run`, and grows only with dependencies one of them
 * actually uses. Replay makes `browserDriver`, `secrets`, and `events` real
 * dependencies; random and environment ports remain outside this composer
 * because neither composed command depends on them. Keeping one composer instead of a speculative
 * `createRunAmbercast()` split preserves a single, visibly Ports-aligned
 * application boundary.
 *
 * `aiProvider` and the resulting `aiExecutor` remain required because
 * `generate-command.ts` reads `ambercast.aiExecutor` directly. To compose a
 * replay, `run-command.ts` supplies a fixed inert literal such as
 * `aiProvider: 'claude'` solely for that shared shape. As the existing
 * `AI_EXECUTOR_FACTORIES` documentation specifies, its factories defer
 * construction and availability probing; this replay composition neither
 * resolves configured or `auto` provider policy nor probes a CLI. The created
 * executor is not read and is not passed to `run()`—`RunDeps` has no
 * `aiExecutor` field—so a grounded replay still requires no AI CLI.
 *
 * `browserDriver`, `secrets`, and `events` remain optional in both input and
 * result because generation supplies none of them. Replay keeps local,
 * non-optional references to the same values it passes here and gives those
 * references directly to `run()`'s non-optional `RunDeps` fields; it does not
 * read them back from the optional `Ambercast` properties and therefore needs
 * no unsound assertion. The returned optional fields still make the composed
 * shape visibly converge toward `Ports` for consumers that do need them.
 */
export function createAmbercast(options: CreateAmbercastOptions): Ambercast {
  return {
    storage: createFsStorage(),
    layout: createLayoutResolver(options.config),
    aiExecutor: AI_EXECUTOR_FACTORIES[options.aiProvider]({
      run: createSpawnCommandRunner({ env: readCommandEnvironment() }),
    }),
    clock: createSystemClock(),
    discoverTestFiles: createFsTestFileDiscovery(),
    ...(options.browserDriver === undefined ? {} : { browserDriver: options.browserDriver }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.events === undefined ? {} : { events: options.events }),
  };
}
