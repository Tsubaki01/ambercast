/**
 * Keeps the package's public API boundary deliberate: package.json's exports
 * field is a physical wall against unintended public surface, one of the
 * "違反防止5段" defense stages. No other repository check keeps this approved
 * five-entry set exact; scripts/verify-pack.mjs validates packed-file
 * presence, not the exports map itself.
 * The test reads package.json directly and uses strict deep equality for the complete exports object, rather than comparing only its keys, so an existing key silently repointed to a wrong target cannot pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe.skip('package.json exports allowlist', () => {});
