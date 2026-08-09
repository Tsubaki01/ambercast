import { createChromiumBrowserDriver } from './chromium.js';
import { BrowserLaunchFailedError } from '#core/errors/browser-launch-failed-error.js';
import type { BrowserDriver, BrowserEngine } from '#ports/browser.js';

/**
 * Construction-time choices shared by every driver selected from this
 * registry.
 *
 * These options are intentionally not part of `BrowserDriverResolver`: the
 * port resolves only an already-composed engine, while CLI policy such as
 * `--headed` is known before any case selects one.
 */
type BrowserLaunchOptions = {
  readonly headed?: boolean;
};

/**
 * Internal constructors for the engines this composition root can provide.
 *
 * The per-engine options parameter belongs only to adapter construction. It
 * is not exported in place of `BrowserDriverResolver`, whose fixed
 * engine-only shape is the contract consumed by the rest of the application.
 */
const BROWSER_DRIVER_FACTORIES: Partial<Record<
  BrowserEngine,
  (options?: BrowserLaunchOptions) => BrowserDriver
>> = {
  chromium: createChromiumBrowserDriver,
};

/**
 * Creates the fixed-shape resolver used by run composition.
 *
 * @param options - Browser choices captured once for this composed command,
 * including whether Chromium should be headed.
 * @returns An engine-only resolver compatible with `BrowserDriverResolver`.
 * @throws `BrowserLaunchFailedError` when
 *   `BROWSER_DRIVER_FACTORIES[engine]` has no registered entry.
 *
 * @remarks
 * The resolver closes over CLI-supplied options when composition is created,
 * then selects a factory only when a target supplies its engine. This
 * preserves the existing resolver port instead of leaking per-engine
 * construction options into every caller.
 *
 * The unregistered-engine branch ensures that a schema-valid target whose
 * engine has no registered factory fails with a classified error rather than
 * a bare `TypeError`, regardless of the registered engine set.
 */
export function createBrowserDriverResolver(
  options?: BrowserLaunchOptions,
): (engine: BrowserEngine) => BrowserDriver {
  return (engine) => {
    const factory = BROWSER_DRIVER_FACTORIES[engine];

    if (factory === undefined) {
      throw new BrowserLaunchFailedError(`No browser driver is registered for engine: ${engine}`);
    }

    return factory(options);
  };
}
