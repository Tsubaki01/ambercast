import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// This opt-in lane requires a local Chromium install: `npx playwright install chromium`.
export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/contract-browser/**/*.contract.test.ts'],
    // Keep command and contract timeouts aligned with the default Vitest lane.
    testTimeout: 30_000,
  },
});
