/*
 * Provides the classified environment failure for replay attempts that cannot
 * obtain a browser session.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a browser session that cannot be launched for the resolved target.
 *
 * @remarks
 * Launch failure belongs to the execution environment rather than test
 * authoring or IR integrity: a browser installation may be missing, resources
 * may be exhausted, or the engine may crash before a test runs. A distinct
 * classification keeps reports and exit codes able to distinguish a test that
 * is wrong from an environment that cannot run an otherwise valid test.
 */
export class BrowserLaunchFailedError extends AmbercastError {
  readonly kind = 'browser-launch-failed' as const;
}
