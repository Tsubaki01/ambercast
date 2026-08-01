import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// Same __VERSION__ constant as tsdown.config.js, so the unit test (which
// imports src/cli/main.ts directly, unbundled) sees the identical
// build-time value the real bundle would inject.
export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
