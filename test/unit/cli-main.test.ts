import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/main.js';

/**
 * Calls main() with an in-memory writable stream for process-free,
 * dist/-independent unit coverage of the banner.
 *
 * This is a real node:stream Writable rather than a cast fake object so the
 * test exercises the same interface that main()'s default process.stdout
 * implements.
 */
class MemoryWritable extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

// Read the version from package.json rather than hardcoding it so the banner
// tracks the published version, the same source tsdown.config.js and
// vitest.config.ts use to supply __VERSION__.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const EXPECTED_BANNER = [
  `ambercast v${pkg.version}`,
  '',
  'Prompt-native E2E testing: AI compiles your natural-language test',
  'prompts into a deterministic execution plan, replayed with zero AI calls.',
  '',
  'This package is under active development. The CLI is not functional yet.',
  '',
].join('\n');

describe('main()', () => {
  it('writes the exact placeholder banner, in order, to the given stream', () => {
    const out = new MemoryWritable();

    main(out);

    expect(out.text).toBe(EXPECTED_BANNER);
  });

  it('defaults to writing to process.stdout when no stream is given', () => {
    const original = process.stdout.write;
    const written: string[] = [];
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      main();
    } finally {
      process.stdout.write = original;
    }

    expect(written.join('')).toBe(EXPECTED_BANNER);
  });
});
