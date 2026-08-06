/**
 * Groups the application-facing port dependencies used at composition time.
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
 * Resolves the browser driver selected by a target engine.
 *
 * @param engine - Engine requested by the run's target definition.
 * @returns The driver that can launch that engine.
 * @throws If composition cannot provide a compatible driver.
 *
 * @remarks
 * Browser selection occurs only after the target is known. A resolver keeps
 * that deferred selection explicit, while the other ports are already chosen
 * direct dependencies.
 */
export type BrowserDriverResolver = (engine: BrowserEngine) => BrowserDriver;

/**
 * The immutable port dependencies supplied to application orchestration.
 *
 * @remarks
 * Readonly properties make dependency replacement an explicit composition
 * change instead of an invisible mutation by a consumer. This shared index is
 * for runtime composition, not an adapter import shortcut.
 */
export interface Ports {
  /** Resolves the driver compatible with the target's selected browser engine. */
  readonly browserDriver: BrowserDriverResolver;

  /** Performs the application's structured and browser-directed AI calls. */
  readonly aiExecutor: AiExecutor;

  /** Stores generated artifacts, run data, and binary diagnostic evidence. */
  readonly storage: StorageAdapter;

  /** Provides wall-clock instants and monotonic duration measurements. */
  readonly clock: Clock;

  /** Supplies UUIDs and unit-interval values where orchestration needs entropy. */
  readonly random: RandomSource;

  /** Resolves secret references at the point their values are needed. */
  readonly secrets: SecretsProvider;

  /** Supplies execution-environment facts that influence runtime policy. */
  readonly environment: EnvironmentInfo;

  /** Receives ordered lifecycle reporting without affecting run execution. */
  readonly events: EventSink;
}
