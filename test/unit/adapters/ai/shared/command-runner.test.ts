import { describe, expect, it } from 'vitest';
import {
  createSpawnCommandRunner,
  stripDeniedEnv,
} from '#adapters/ai/shared/command-runner.js';

describe('stripDeniedEnv', () => {
  it('returns a distinct empty environment for an empty input', () => {
    const env: NodeJS.ProcessEnv = {};

    const filtered = stripDeniedEnv(env);

    expect(filtered).toEqual({});
    expect(filtered).not.toBe(env);
  });

  it('removes an environment containing only denied keys', () => {
    const filtered = stripDeniedEnv({
      AMBERCAST_SECRET_DUMMY: 'secret-value',
      AMBERCAST_ENV_DUMMY: 'secret-adjacent-value',
    });

    expect(filtered).toEqual({});
  });

  it('preserves an environment containing only allowed keys', () => {
    const env: NodeJS.ProcessEnv = {
      AMBERCAST_TEST_ALLOWED: '1',
      HOME: '/home/ambercast',
      PATH: '/usr/bin',
    };

    const filtered = stripDeniedEnv(env);

    expect(filtered).toEqual(env);
    expect(filtered).not.toBe(env);
  });

  it('removes denied keys while preserving allowed keys in a mixed environment', () => {
    const filtered = stripDeniedEnv({
      AMBERCAST_ENV_DUMMY: 'secret-adjacent-value',
      AMBERCAST_SECRET_DUMMY: 'secret-value',
      AMBERCAST_TEST_ALLOWED: '1',
      PATH: '/usr/bin',
    });

    expect(filtered).toEqual({
      AMBERCAST_TEST_ALLOWED: '1',
      PATH: '/usr/bin',
    });
  });

  it('removes denied keys regardless of their casing', () => {
    const filtered = stripDeniedEnv({
      Ambercast_Secret_Mixed: 'secret-value',
      ambercast_env_mixed: 'secret-adjacent-value',
      PATH: '/usr/bin',
    });

    expect(filtered).toEqual({ PATH: '/usr/bin' });
  });

  it('preserves key names outside the denied namespace boundary', () => {
    const env: NodeJS.ProcessEnv = { AMBERCAST_SECRETS_X: 'allowed-value' };

    expect(stripDeniedEnv(env)).toEqual(env);
  });

  it('does not mutate the input environment object', () => {
    const env: NodeJS.ProcessEnv = {
      AMBERCAST_SECRET_DUMMY: 'secret-value',
      AMBERCAST_TEST_ALLOWED: '1',
    };
    const original = { ...env };

    const filtered = stripDeniedEnv(env);

    expect(env).toEqual(original);
    expect(filtered).not.toBe(env);
  });
});

describe('createSpawnCommandRunner', () => {
  it('does not expose Ambercast secret namespaces to a spawned child', async () => {
    const keys = [
      'AMBERCAST_SECRET_DUMMY',
      'AMBERCAST_ENV_DUMMY',
      'Ambercast_Secret_Mixed',
      'AMBERCAST_TEST_ALLOWED',
    ] as const;
    const originalValues = new Map(keys.map((key) => [key, process.env[key]]));
    const path = process.env.PATH;
    const home = process.env.HOME;

    expect(path).toBeDefined();
    expect(home).toBeDefined();

    try {
      process.env.AMBERCAST_SECRET_DUMMY = 'secret-value';
      process.env.AMBERCAST_ENV_DUMMY = 'secret-adjacent-value';
      process.env.Ambercast_Secret_Mixed = 'mixed-case-secret-value';
      process.env.AMBERCAST_TEST_ALLOWED = '1';

      const runner = createSpawnCommandRunner({ env: process.env });
      const result = await runner(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']);

      expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
      if (result.outcome !== 'exited') {
        throw new Error('Expected the environment probe child to exit normally.');
      }

      const childEnv = JSON.parse(result.stdout) as NodeJS.ProcessEnv;

      expect(childEnv).not.toHaveProperty('AMBERCAST_SECRET_DUMMY');
      expect(childEnv).not.toHaveProperty('AMBERCAST_ENV_DUMMY');
      expect(childEnv).not.toHaveProperty('Ambercast_Secret_Mixed');
      expect(childEnv.PATH).toBe(path);
      expect(childEnv.HOME).toBe(home);
      expect(childEnv.AMBERCAST_TEST_ALLOWED).toBe('1');
    } finally {
      for (const key of keys) {
        const originalValue = originalValues.get(key);

        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  });

  it('gives a child no inherited environment when no environment dependency is supplied', async () => {
    const key = 'AMBERCAST_TEST_ALLOWED_OMITTED';
    const originalValue = process.env[key];

    try {
      process.env[key] = 'must-not-reach-child';

      const runner = createSpawnCommandRunner();
      const result = await runner(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']);

      expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
      if (result.outcome !== 'exited') {
        throw new Error('Expected the environment probe child to exit normally.');
      }

      const childEnv = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
      expect(childEnv).not.toHaveProperty('PATH');
      expect(childEnv).not.toHaveProperty('HOME');
      expect(childEnv).not.toHaveProperty(key);
    } finally {
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  it('reads an injected environment object again for each child invocation', async () => {
    const env: NodeJS.ProcessEnv = { AMBERCAST_TEST_LIVE: 'before' };
    const runner = createSpawnCommandRunner({ env });

    const first = await runner(process.execPath, ['-e', 'process.stdout.write(process.env.AMBERCAST_TEST_LIVE ?? "missing")']);
    env.AMBERCAST_TEST_LIVE = 'after';
    const second = await runner(process.execPath, ['-e', 'process.stdout.write(process.env.AMBERCAST_TEST_LIVE ?? "missing")']);

    expect(first).toMatchObject({ outcome: 'exited', exitCode: 0, stdout: 'before' });
    expect(second).toMatchObject({ outcome: 'exited', exitCode: 0, stdout: 'after' });
  });

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
