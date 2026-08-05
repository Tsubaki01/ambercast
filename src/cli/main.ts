/**
 * Writes the canonical placeholder banner exactly once to `stdout`.
 *
 * Every CLI invocation shares this banner-emission contract regardless of
 * `argv`, so `main()` takes no invocation arguments precisely because its
 * output never varies with `argv`: there is nothing an argument could usefully
 * change; `test/e2e/cli.test.ts` protects the exact output byte-for-byte.
 *
 * `__VERSION__` is a build-time constant rather than a runtime
 * `package.json` read because relative paths resolve differently when the
 * test runner loads this unbundled source and when the bundled `dist/cli.js`
 * runs.
 *
 * The CLI layer is the only layer permitted to call `process.exit`, but a
 * successful write returns naturally because forcing an exit immediately
 * after a stream write can truncate output before it flushes. Injectable
 * `stdout` lets `test/unit/cli-main.test.ts` assert against an in-memory
 * stream without spawning a process, while `test/e2e/cli.test.ts` verifies
 * identical output through the built executable path.
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
