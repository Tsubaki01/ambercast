import type { EventSink } from '#ports/system.js';

/**
 * Creates an event sink that accepts every run event without observing it.
 *
 * @returns A concrete, never-throwing `EventSink` for unattended execution.
 *
 * @remarks
 * CLI composition always supplies an event sink because run dispatch emits
 * lifecycle events unconditionally. This is therefore a real adapter for the
 * intentionally unobserved case, rather than a throwing placeholder that
 * would make ordinary execution fail when no reporter is configured.
 */
export function createNoopEventSink(): EventSink {
  return {
    emit(): void {},
  };
}
