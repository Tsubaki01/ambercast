import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/main.js';

/**
 * Unit-level coverage for the CLI banner. Calls main() directly with an
 * injected in-memory writable stream so this test never spawns a process
 * and never depends on the built dist/ output — see
 * .claude/impl/issue-10-plan.md "Test strategy" for why this, not the
 * e2e test, is the genuine TDD red step for this issue (the assertion
 * fails against the step-6 scaffold's empty-bodied main() until step 11
 * implements it).
 *
 * A real node:stream Writable (not a hand-rolled object cast to
 * NodeJS.WritableStream) so the test exercises the same interface
 * main()'s default `process.stdout` actually implements.
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

// Read the version from package.json directly, the same source
// tsdown.config.js/vitest.config.ts read it from to build __VERSION__ —
// this is the boundary case the plan calls out: the banner must track
// package.json's actual version rather than a value hardcoded in the test
// or the implementation.
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
