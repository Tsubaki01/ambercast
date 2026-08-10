type ChromiumAvailabilityEnvironment = { readonly CI?: string };

/**
 * Resolves whether a contract-browser suite can run after probing Chromium.
 *
 * Both browser contract specs use this shared decision so an unavailable
 * browser is handled consistently instead of each spec maintaining a subtly
 * different catch-and-skip branch. CI is strict only when `env.CI` is exactly
 * `'true'`: environment values are strings, so truthiness would incorrectly
 * make local `CI=false` or `CI=0` behave as CI while preserving GitHub
 * Actions' actual value. A cleanup failure follows the same local-versus-CI
 * policy as a launch failure, so a successful probe requires both operations.
 *
 * @param launch - An injected browser probe. Injection lets unit tests verify
 * the local-versus-CI failure policy for launch and cleanup with fake browser
 * handles and failures, without requiring Chromium to be installed or
 * launched.
 * @param env - The environment source from which the optional CI indicator is
 * read; an unset indicator represents local execution.
 * @returns A promise that resolves `true` only after launch and cleanup both
 * succeed, or `false` for either failure during local execution.
 * @throws The original probe failure when the injected CI indicator is exactly
 * `'true'`, so a broken CI browser installation or cleanup cannot be hidden
 * by skipped tests.
 */
export async function resolveChromiumAvailability(
  launch: () => Promise<{ close(): Promise<void> }>,
  env: ChromiumAvailabilityEnvironment = process.env,
): Promise<boolean> {
  try {
    const browser = await launch();
    await browser.close();
    return true;
  } catch (error) {
    if (env.CI === 'true') {
      throw error;
    }
    return false;
  }
}
