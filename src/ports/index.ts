/**
 * Groups the application-facing port dependencies used at composition time.
 * The aggregate describes ownership and selection without allowing adapters to
 * treat the shared index as an import shortcut.
 */
import type { AiExecutor } from './ai.js';
import type { BrowserDriver, BrowserEngine } from './browser.js';
import type { StorageAdapter } from './storage.js';
import type {
  Clock,
  EnvironmentInfo,
  EventSink,
  RandomSource,
  SecretsProvider,
} from './system.js';

/**
 * Selects the browser driver capable of launching a requested engine.
 *
 * Browser drivers are deferred through a resolver to avoid circular
 * initialization between target selection and adapter composition. The other
 * ports have one already-selected instance and therefore remain direct
 * dependencies.
 *
 * @param engine - The target browser engine to support.
 * @returns The driver for that engine.
 */
export type BrowserDriverResolver = (engine: BrowserEngine) => BrowserDriver;

/**
 * The readonly dependency set supplied to application orchestration.
 *
 * Readonly properties prevent a consumer from silently replacing shared
 * infrastructure after composition, keeping dependency wiring explicit.
 */
export interface Ports {
  /**
   * Selects a browser driver after the run identifies its target engine.
   */
  readonly browserDriver: BrowserDriverResolver;

  /**
   * Performs structured and browser-directed AI work.
   */
  readonly aiExecutor: AiExecutor;

  /**
   * Persists text, binary artifacts, and directories.
   */
  readonly storage: StorageAdapter;

  /**
   * Supplies wall-clock and monotonic time.
   */
  readonly clock: Clock;

  /**
   * Supplies UUIDs and fractional random values.
   */
  readonly random: RandomSource;

  /**
   * Resolves secret references at their use boundary.
   */
  readonly secrets: SecretsProvider;

  /**
   * Reports stable execution-environment facts.
   */
  readonly environment: EnvironmentInfo;

  /**
   * Receives run lifecycle events.
   */
  readonly events: EventSink;
}
