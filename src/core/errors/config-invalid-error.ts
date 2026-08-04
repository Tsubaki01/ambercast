/*
 * Provides the classified configuration failure shared by configuration
 * loading and layout construction. Locating it with the core error vocabulary
 * lets both consumers report the same process outcome without either layer
 * owning the other.
 */

import { AmbercastError } from './types.js';

/**
 * Reports configuration data that cannot satisfy Ambercast's configuration
 * contract.
 *
 * @remarks
 * This shared class lets layout construction and configuration loading report
 * one classified failure category instead of defining incompatible local
 * errors. Its fixed kind is resolved through the base class's central
 * exit-code mapping.
 */
export class ConfigInvalidError extends AmbercastError {
  readonly kind = 'config-invalid' as const;
}
