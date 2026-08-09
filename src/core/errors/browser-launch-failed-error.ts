import { AmbercastError } from './types.js';

/** Reports a browser session that cannot be launched for the resolved target. */
export class BrowserLaunchFailedError extends AmbercastError {
  readonly kind = 'browser-launch-failed' as const;
}
