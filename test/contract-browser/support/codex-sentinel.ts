import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A per-test executable replacement for the explicit Codex provider. */
export interface CodexSentinel {
  /** Directory containing the executable that must be prepended to the CLI child's PATH. */
  readonly pathEntry: string;
  /** Recorded provider argv arrays, in invocation order. */
  readonly invocations: () => Promise<readonly string[][]>;
  /** Removes the sentinel directory; repeated calls are deliberately no-ops. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Creates a narrow, filesystem-backed Codex CLI sentinel for a spawned CLI.
 *
 * The counter exists before the first provider call so an empty invocation
 * list represents a genuine zero-dispatch result rather than a missing-file
 * setup failure. Setup rolls back its directory on every partial failure,
 * because callers receive a cleanup handle only after this function resolves.
 */
export async function createCodexSentinel(): Promise<CodexSentinel> {
  let directory: string | undefined;

  try {
    directory = await mkdtemp(join(tmpdir(), 'ambercast-codex-sentinel-'));
    const sentinelDirectory = directory;
    const counterPath = join(sentinelDirectory, 'invocations.jsonl');
    const executablePath = join(sentinelDirectory, 'codex');
    const source = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const counterPath = ${JSON.stringify(counterPath)};
const argv = process.argv.slice(2);
appendFileSync(counterPath, JSON.stringify(argv) + '\\n');
process.stdin.resume();

if (argv[0] === '--version') {
  process.stdout.write('codex sentinel 0.0.0\\n');
  process.exit(0);
}

if (argv[0] === 'exec') {
  const outputIndexes = argv.flatMap((argument, index) => argument === '-o' ? [index] : []);
  const outputIndex = outputIndexes[0];
  const outputPath = outputIndex === undefined ? undefined : argv[outputIndex + 1];
  if (outputIndexes.length !== 1 || outputPath === undefined || outputPath.length === 0) {
    process.stderr.write('codex sentinel requires exactly one -o <output-path> argument\\n');
    process.exit(1);
  }
  writeFileSync(outputPath, '{"confirmed":true}');
  process.exit(0);
}

process.stderr.write('codex sentinel received an unexpected invocation\\n');
process.exit(1);
`;

    await writeFile(counterPath, '');
    await writeFile(executablePath, source);
    await chmod(executablePath, 0o755);

    let cleaned = false;
    return {
      pathEntry: sentinelDirectory,
      async invocations(): Promise<readonly string[][]> {
        const content = await readFile(counterPath, 'utf8');
        return content.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
      },
      async cleanup(): Promise<void> {
        if (cleaned) {
          return;
        }
        cleaned = true;
        await rm(sentinelDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}
