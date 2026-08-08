import { describe, expect, it } from 'vitest';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';

describe('createSpawnCommandRunner', () => {
  it('captures UTF-8 stdout and stderr from a normally exiting child', async () => {
    const runner = createSpawnCommandRunner();

    await expect(runner(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']))
      .resolves.toEqual({ outcome: 'exited', stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('preserves non-zero exit status with both output streams', async () => {
    const runner = createSpawnCommandRunner();

    await expect(runner(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)']))
      .resolves.toEqual({ outcome: 'exited', stdout: 'out', stderr: 'err', exitCode: 7 });
  });

  it('kills a hanging child and rejects with the supplied abort reason', async () => {
    const runner = createSpawnCommandRunner();
    const controller = new AbortController();
    const reason = new Error('stop hanging child');
    const running = runner(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { signal: controller.signal });

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
  });

  it('rejects a nonexistent binary instead of manufacturing a process outcome', async () => {
    const runner = createSpawnCommandRunner();

    await expect(runner('/ambercast-test-guaranteed-missing/bin/command', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
