// Plain JavaScript on purpose (not tsdown.config.ts): tsdown's native
// TypeScript config loading needs a newer Node floor than this project's
// >=22.14 baseline guarantees, so a .js config sidesteps that entirely.
// See .claude/impl/issue-10-plan.md ("Decisions") for the full rationale.
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/main.ts',
  },
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  dts: true,
  clean: true,
  // Build-time constant so neither the source nor the bundle needs a
  // runtime file read to know its own version (see plan "Decisions" for
  // why a runtime read is unsafe across src/ vs dist/ path depths).
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
