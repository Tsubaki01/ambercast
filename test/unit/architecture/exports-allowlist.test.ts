/**
 * Keeps the package's public API boundary deliberate: package.json's exports
 * field is a physical wall against unintended public surface, one of several
 * layered defenses that preserve a deliberate API boundary. This test validates
 * the approved five-entry exports map's complete content, while
 * scripts/verify-pack.mjs separately validates packed-file presence.
 * The test reads package.json directly and uses strict deep equality for the complete exports object, rather than comparing only its keys, so an existing key silently repointed to a wrong target cannot pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package.json exports allowlist', () => {
  it('matches the approved public export map exactly', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

    expect(pkg.exports).toStrictEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './schema/plan.json': './dist/schema/plan.schema.json',
      './schema/grounding.json': './dist/schema/grounding.schema.json',
      './schema/config.json': './dist/schema/config.schema.json',
      './package.json': './package.json',
    });
  });
});
