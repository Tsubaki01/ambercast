import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// Matches tsdown.config.js so direct unit-test imports see the build-time value
// that the real bundle injects.
export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/contract-ai/**'],
    // TypeScript compiler and dependency-cruiser tests can contend for CPU on CI runners.
    testTimeout: 30_000,
  },
});
