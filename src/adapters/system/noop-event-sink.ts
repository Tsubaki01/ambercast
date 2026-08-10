import type { EventSink } from '#ports/system.js';

/**
 * Creates an event sink that accepts every use-case lifecycle event without
 * observing it.
 *
 * @returns A concrete, never-throwing `EventSink` for unattended execution.
 *
 * @remarks
 * CLI composition always supplies an event sink because generation and replay
 * emit lifecycle events. This is therefore a real adapter for the
 * intentionally unobserved case, rather than a throwing placeholder that
 * would make ordinary execution fail when no reporter is configured.
 */
export function createNoopEventSink(): EventSink {
  return {
    emit(): void {},
  };
}
