import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { loadConfig } from '#config/load.js';

const CONFIG_SCHEMA_URL = 'https://ambercast.dev/schema/config.json';

async function withIsolatedConfigDirectory(assertion: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-load-config-'));

  try {
    await assertion(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function writeConfig(path: string, overrides: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...overrides }), 'utf8');
}

describe('loadConfig() with FsStorage', () => {
  it('loads a real discovered config file and anchors relative directories to its directory', async () => {
    await withIsolatedConfigDirectory(async (root) => {
      const projectDirectory = join(root, 'project');
      const configPath = join(projectDirectory, 'ambercast.config.json');
      await writeConfig(configPath, {
        runsDir: 'artifacts/runs',
        testDir: 'prompt-tests',
      });

      const config = await loadConfig({
        cwd: projectDirectory,
        storage: createFsStorage(),
      });

      expect(config.testDir).toBe(join(projectDirectory, 'prompt-tests'));
      expect(config.runsDir).toBe(join(projectDirectory, 'artifacts/runs'));
      expect(config.projectRoot).toBe(projectDirectory);
    });
  });

  it('walks multiple real ancestor directories to find the outer configuration file', async () => {
    await withIsolatedConfigDirectory(async (root) => {
      const projectDirectory = join(root, 'project');
      const workingDirectory = join(projectDirectory, 'apps', 'web', 'tests', 'nested');
      await mkdir(workingDirectory, { recursive: true });
      await writeConfig(join(projectDirectory, 'ambercast.config.json'), {
        runsDir: 'outer-runs',
        testDir: 'outer-tests',
        viewer: { port: 4_611 },
      });

      const config = await loadConfig({
        cwd: workingDirectory,
        storage: createFsStorage(),
      });

      expect(config.viewer).toStrictEqual({ port: 4_611 });
      expect(config.testDir).toBe(join(projectDirectory, 'outer-tests'));
      expect(config.runsDir).toBe(join(projectDirectory, 'outer-runs'));
      expect(config.projectRoot).toBe(projectDirectory);
    });
  });

  it('uses the real working directory as projectRoot when no configuration file exists', async () => {
    await withIsolatedConfigDirectory(async (root) => {
      const workingDirectory = join(root, 'project', 'apps', 'web');
      await mkdir(workingDirectory, { recursive: true });

      const config = await loadConfig({
        cwd: workingDirectory,
        storage: createFsStorage(),
      });

      expect(config.projectRoot).toBe(workingDirectory);
    });
  });

  it('surfaces a real selected-file read error without translating it to ConfigInvalidError', async (context) => {
    await withIsolatedConfigDirectory(async (root) => {
      const configPath = join(root, 'ambercast.config.json');
      const storage = createFsStorage();
      await writeConfig(configPath, {});

      try {
        await chmod(configPath, 0o000);

        let directReadError: unknown;
        try {
          await readFile(configPath, 'utf8');
        } catch (error) {
          directReadError = error;
        }

        if (directReadError === undefined) {
          context.skip('File permissions are not enforced; cannot exercise the selected-file read error.');
          return;
        }

        await expect(storage.exists(configPath)).resolves.toBe(true);

        let thrown: unknown;
        try {
          await loadConfig({
            configPathOverride: configPath,
            cwd: root,
            storage,
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(ConfigInvalidError);
      } finally {
        await chmod(configPath, 0o600);
      }
    });
  });
});
