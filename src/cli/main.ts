/**
 * Prints the CLI's placeholder startup banner and returns.
 *
 * What: writes the same six lines the original plain-JS `bin/ambercast.js`
 * printed via `console.log` before this issue's toolchain existed —
 * version line, blank line, two-line product description, blank line,
 * "not functional yet" notice — each terminated with a single `\n`, in
 * this exact order and with no additional lines before, between, or after
 * them. The `test/e2e/cli.test.ts` byte-exact assertion (see the plan's
 * "Test strategy") depends on this list being complete and unchanged:
 *
 *   1. `ambercast v${__VERSION__}`
 *   2. `` (empty)
 *   3. `Prompt-native E2E testing: AI compiles your natural-language test`
 *   4. `prompts into a deterministic execution plan, replayed with zero AI calls.`
 *   5. `` (empty)
 *   6. `This package is under active development. The CLI is not functional yet.`
 *
 * Why: this repository is pre-implementation (see AGENTS.md "Status"), and
 * issue #10 exists only to stand up the TypeScript/tsdown/Vitest toolchain
 * — it must not change any user-visible behavior. The version comes from
 * the build-time `__VERSION__` constant (declared in `src/global.d.ts`,
 * injected by `tsdown.config.js`/`vitest.config.ts`) rather than a runtime
 * `package.json` read, because a relative-path read would resolve
 * differently from `src/cli/main.ts` (under the test runner, unbundled)
 * than from the bundled `dist/cli.js` — see the plan's "Decisions".
 *
 * Who/when: called exactly once per process, by `bin/ambercast.js` (the
 * published entry point) at CLI startup. There is no argument parsing yet
 * — every invocation prints the same banner regardless of `argv` — so
 * `main()` intentionally takes no arguments describing the invocation.
 * Real command dispatch (and the exit-code decisions that come with it)
 * lands in a later issue.
 *
 * Where: this file is the CLI layer. Per the architecture design, only a
 * file in this position is ever allowed to call `process.exit` — this
 * function does not call it because there is no error path to report yet
 * (writing to `stdout` cannot fail in a way this CLI needs to react to),
 * and Node's own guidance is that calling `process.exit()` right after a
 * stream write risks truncating output before it flushes. The process
 * simply runs to natural completion with exit code 0.
 *
 * How: `stdout` is injectable (defaulting to `process.stdout`) specifically
 * so `test/unit/cli-main.test.ts` can assert the exact written text against
 * an in-memory stream without spawning a process; `test/e2e/cli.test.ts`
 * separately proves the real `bin/ambercast.js` → `dist/cli.js` path
 * produces identical output when actually executed.
 */
export function main(stdout: NodeJS.WritableStream = process.stdout): void {
  const lines = [
    `ambercast v${__VERSION__}`,
    '',
    'Prompt-native E2E testing: AI compiles your natural-language test',
    'prompts into a deterministic execution plan, replayed with zero AI calls.',
    '',
    'This package is under active development. The CLI is not functional yet.',
    '',
  ];
  stdout.write(lines.join('\n'));
}
