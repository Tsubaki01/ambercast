import { runInNewContext } from 'node:vm';

/**
 * Synthetic dependency-cruiser fixture; not a product module. It is nested so
 * the adapters-root-file fallback does not preempt the external-allowlist rule.
 */
export const syntheticAdapterValue = runInNewContext('1');
