// __VERSION__ is a compile-time constant injected by tsdown.config.js's
// `define` (and mirrored by vitest.config.ts for tests) — see
// .claude/impl/issue-10-plan.md ("Decisions") for why the CLI banner reads
// its version this way instead of reading package.json at runtime.
declare const __VERSION__: string;
