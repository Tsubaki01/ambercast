/*
 * Exposes the configuration layer through one stable import path. Keeping the
 * barrel thin lets callers depend on loading rather than this layer's private
 * module layout while preserving core ownership of the resolved vocabulary.
 */

/**
 * Loads the resolved configuration for one project.
 */
export { loadConfig } from './load.js';

/**
 * Describes the injected inputs accepted by {@link loadConfig}.
 */
export type { LoadConfigOptions } from './load.js';

/**
 * Describes the complete, resolved configuration returned to callers.
 */
export type { ResolvedConfig } from '#core/config/schema.js';
