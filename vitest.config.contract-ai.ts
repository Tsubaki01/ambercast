import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// The smoke lane uses the same source-level version constant as the default
// suite while remaining opt-in for locally authenticated provider CLIs.
export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/contract-ai/**/*.smoke.test.ts'],
    // Keep command and contract timeouts aligned with the default Vitest lane.
    testTimeout: 30_000,
  },
});
