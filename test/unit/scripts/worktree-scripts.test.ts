import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ADD_SCRIPT = fileURLToPath(new URL('../../../scripts/worktree-add.mjs', import.meta.url));
const REMOVE_SCRIPT = fileURLToPath(new URL('../../../scripts/worktree-remove.mjs', import.meta.url));

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly receptacle: string;
}

let fixture: Fixture | undefined;

function getFixture(): Fixture {
  if (fixture === undefined) {
    throw new Error('The temporary Git fixture has not been created.');
  }

  return fixture;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runScript(script: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: getFixture().repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      AMBERCAST_WT_SKIP_SETUP: '1',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runAdd(args: readonly string[], environment: NodeJS.ProcessEnv = {}): string {
  return runScript(ADD_SCRIPT, args, environment);
}

function runRemove(args: readonly string[]): string {
  return runScript(REMOVE_SCRIPT, args);
}

function expectScriptFailure(command: () => unknown): string {
  try {
    command();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stderr' in error) {
      const { stderr } = error;

      if (typeof stderr === 'string') {
        return stderr;
      }

      if (Buffer.isBuffer(stderr)) {
        return stderr.toString('utf8');
      }
    }

    throw error;
  }

  throw new Error('Expected the script to exit with a failure status.');
}

function worktreePath(issue: string, slug?: string): string {
  const name = slug === undefined ? `issues-${issue}` : `issues-${issue}-${slug}`;
  return join(getFixture().receptacle, name);
}

function branchExists(branch: string): boolean {
  try {
    runGit(getFixture().repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function createWorktree(issue: string, slug?: string): string {
  runAdd(slug === undefined ? [issue] : [issue, slug]);
  return worktreePath(issue, slug);
}

beforeEach(async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'ambercast-worktree-scripts-'));
  const root = await realpath(createdRoot);
  const repository = join(root, 'product', 'workspace', 'repo');
  const receptacle = join(root, 'product', '.worktrees');

  await Promise.all([
    mkdir(repository, { recursive: true }),
    mkdir(receptacle, { recursive: true }),
  ]);
  runGit(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'README.md'), '# fixture\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);

  fixture = { root, repository, receptacle };
});

afterEach(async () => {
  if (fixture !== undefined) {
    await rm(fixture.root, { force: true, recursive: true });
  }

  fixture = undefined;
});

describe('worktree-add.mjs', () => {
  it('creates a new issue branch from local main in the default receptacle', () => {
    const output = runAdd(['101']);
    const path = worktreePath('101');

    expect(existsSync(path)).toBe(true);
    expect(runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('issues/101');
    expect(runGit(path, ['rev-parse', 'HEAD']).trim()).toBe(
      runGit(getFixture().repository, ['rev-parse', 'main']).trim(),
    );
    expect(branchExists('issues/101')).toBe(true);
    expect(output).toContain(path);
    expect(output).toContain('issues/101');
    expect(output).toContain(`cd ${path}`);
  });

  it('creates a slugged issue branch and directory', () => {
    runAdd(['102', 'worktree-tooling']);
    const path = worktreePath('102', 'worktree-tooling');

    expect(existsSync(path)).toBe(true);
    expect(runGit(path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('issues/102-worktree-tooling');
    expect(branchExists('issues/102-worktree-tooling')).toBe(true);
  });

  it('attaches an existing branch that is not checked out elsewhere', () => {
    runGit(getFixture().repository, ['branch', 'issues/103']);

    runAdd(['103']);

    expect(runGit(worktreePath('103'), ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('issues/103');
  });

  it('rejects a branch that is already checked out in another worktree', () => {
    const existingPath = join(getFixture().root, 'already-checked-out');
    runGit(getFixture().repository, ['branch', 'issues/104']);
    runGit(getFixture().repository, ['worktree', 'add', existingPath, 'issues/104']);

    const error = expectScriptFailure(() => runAdd(['104']));

    expect(error).toMatch(/already checked out/i);
    expect(existsSync(worktreePath('104'))).toBe(false);
  });

  it('rejects an existing target directory before creating a branch', async () => {
    const path = worktreePath('105');
    await mkdir(path, { recursive: true });

    const error = expectScriptFailure(() => runAdd(['105']));

    expect(error).toMatch(/directory.*exists/i);
    expect(branchExists('issues/105')).toBe(false);
  });

  it.each([['0'], ['-1'], ['1.5'], ['not-an-issue']])(
    'rejects invalid issue number %s without creating a worktree',
    async (issue) => {
      const error = expectScriptFailure(() => runAdd([issue]));

      expect(error).toContain('Usage:');
      expect(await readdir(getFixture().receptacle)).toEqual([]);
    },
  );

  it.each([['Bad-slug'], ['bad_slug'], ['-bad']])(
    'rejects invalid slug %s without creating a worktree',
    async (slug) => {
      const error = expectScriptFailure(() => runAdd(['106', slug]));

      expect(error).toContain('Usage:');
      expect(await readdir(getFixture().receptacle)).toEqual([]);
    },
  );

  it('uses the absolute AMBERCAST_WORKTREE_ROOT override when provided', async () => {
    const override = join(getFixture().root, 'alternate-worktrees');
    await mkdir(override, { recursive: true });

    runAdd(['107'], { AMBERCAST_WORKTREE_ROOT: override });

    expect(existsSync(join(override, 'issues-107'))).toBe(true);
    expect(existsSync(worktreePath('107'))).toBe(false);
  });
});

describe('worktree-remove.mjs', () => {
  it('removes a clean worktree selected by its issue number', () => {
    const path = createWorktree('201');
    const output = runRemove(['201']);

    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/201')).toBe(true);
    expect(output).toMatch(/removed/i);
  });

  it('matches a lone slugged worktree from its bare issue number', () => {
    const path = createWorktree('202', 'documentation');

    runRemove(['202']);

    expect(existsSync(path)).toBe(false);
  });

  it('requires an explicit path when both plain and slugged worktrees match an issue number', () => {
    const plainPath = createWorktree('203');
    const sluggedPath = createWorktree('203', 'follow-up');

    const error = expectScriptFailure(() => runRemove(['203']));

    expect(error).toMatch(/multiple worktrees.*explicit path/i);
    expect(existsSync(plainPath)).toBe(true);
    expect(existsSync(sluggedPath)).toBe(true);
  });

  it('refuses to remove a dirty worktree without --force', async () => {
    const path = createWorktree('204');
    await writeFile(join(path, 'uncommitted.txt'), 'dirty\n');

    const error = expectScriptFailure(() => runRemove(['204']));

    expect(error).toMatch(/dirty.*--force/i);
    expect(existsSync(path)).toBe(true);
  });

  it('removes a dirty worktree when --force is supplied', async () => {
    const path = createWorktree('205');
    await writeFile(join(path, 'uncommitted.txt'), 'dirty\n');

    runRemove(['205', '--force']);

    expect(existsSync(path)).toBe(false);
  });

  it('deletes a merged branch with --with-branch after removing its worktree', () => {
    const path = createWorktree('206');

    runRemove(['206', '--with-branch']);

    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/206')).toBe(false);
  });

  it('leaves an unmerged branch intact and reports the safe-delete failure', async () => {
    const path = createWorktree('207');
    await writeFile(join(path, 'change.txt'), 'unmerged\n');
    runGit(path, ['add', 'change.txt']);
    runGit(path, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unmerged']);

    const error = expectScriptFailure(() => runRemove(['207', '--with-branch']));

    expect(error).toMatch(/not fully merged|not an ancestor/i);
    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/207')).toBe(true);
  });

  it('force-deletes an unmerged branch when --force and --with-branch are supplied', async () => {
    const path = createWorktree('208');
    await writeFile(join(path, 'change.txt'), 'unmerged\n');
    runGit(path, ['add', 'change.txt']);
    runGit(path, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unmerged']);

    runRemove(['208', '--force', '--with-branch']);

    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/208')).toBe(false);
  });

  it('rejects an unknown issue number', () => {
    const error = expectScriptFailure(() => runRemove(['999']));

    expect(error).toMatch(/no worktree.*999/i);
  });

  it('copies missing logs and todos back without overwriting main-checkout files', async () => {
    const path = createWorktree('209');
    const mainLogs = join(getFixture().repository, '.claude', 'logs');
    const mainTodos = join(getFixture().repository, '.claude', 'todos');

    await Promise.all([
      mkdir(join(path, '.claude', 'logs'), { recursive: true }),
      mkdir(join(path, '.claude', 'todos', 'nested'), { recursive: true }),
      mkdir(mainLogs, { recursive: true }),
      mkdir(mainTodos, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(path, '.claude', 'logs', 'only-in-worktree.md'), 'preserve this log\n'),
      writeFile(join(path, '.claude', 'logs', 'already-in-main.md'), 'linked copy\n'),
      writeFile(join(path, '.claude', 'todos', 'nested', 'only-in-worktree.md'), 'preserve this todo\n'),
      writeFile(join(mainLogs, 'already-in-main.md'), 'main copy\n'),
    ]);

    const output = runRemove(['209', '--force']);

    await expect(readFile(join(mainLogs, 'only-in-worktree.md'), 'utf8')).resolves.toBe('preserve this log\n');
    await expect(readFile(join(mainLogs, 'already-in-main.md'), 'utf8')).resolves.toBe('main copy\n');
    await expect(readFile(join(mainTodos, 'nested', 'only-in-worktree.md'), 'utf8')).resolves.toBe('preserve this todo\n');
    expect(output).toMatch(/skipped.*already-in-main/i);
  });

  it('refuses to remove the main worktree when given its path', () => {
    const error = expectScriptFailure(() => runRemove([getFixture().repository]));

    expect(error).toMatch(/main worktree/i);
    expect(existsSync(getFixture().repository)).toBe(true);
  });
});
