import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureTargetLocked,
  formatLockReason,
  isSameOrDescendant,
  isStrictDescendant,
  parseWorktreePorcelain,
  resolveCwdRealpath,
// @ts-expect-error The production ESM script is deliberately untyped JavaScript.
} from '../../../scripts/lib/worktree.mjs';

const ADD_SCRIPT = fileURLToPath(new URL('../../../scripts/worktree-add.mjs', import.meta.url));
const REMOVE_SCRIPT = fileURLToPath(new URL('../../../scripts/worktree-remove.mjs', import.meta.url));
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

interface Fixture {
  readonly root: string;
  readonly repositoryName: string;
  readonly repository: string;
  readonly receptacleRoot: string;
  readonly receptacle: string;
}

interface RunScriptOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly skipSetup?: boolean;
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

function runScript(
  script: string,
  args: readonly string[],
  { cwd = getFixture().repository, environment = {}, skipSetup = true }: RunScriptOptions = {},
): string {
  const commandEnvironment = { ...process.env, ...environment };

  if (skipSetup) {
    commandEnvironment.AMBERCAST_WT_SKIP_SETUP = '1';
  } else {
    delete commandEnvironment.AMBERCAST_WT_SKIP_SETUP;
  }

  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: commandEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runAdd(args: readonly string[], options: RunScriptOptions = {}): string {
  return runScript(ADD_SCRIPT, args, options);
}

function runRemove(args: readonly string[], options: RunScriptOptions = {}): string {
  return runScript(REMOVE_SCRIPT, args, options);
}

function expectScriptFailureOutput(command: () => unknown): { stdout: string; stderr: string } {
  try {
    command();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'stderr' in error && 'stdout' in error) {
      const output = (value: unknown): string => {
        if (typeof value === 'string') {
          return value;
        }

        return Buffer.isBuffer(value) ? value.toString('utf8') : '';
      };

      return {
        stdout: output(error.stdout),
        stderr: output(error.stderr),
      };
    }

    throw error;
  }

  throw new Error('Expected the script to exit with a failure status.');
}

function expectScriptFailure(command: () => unknown): string {
  return expectScriptFailureOutput(command).stderr;
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

function createUnlockedWorktree(issue: string): string {
  const path = worktreePath(issue);
  runGit(getFixture().repository, ['worktree', 'add', '-b', `issues/${issue}`, path]);
  return path;
}

interface ShimOptions {
  readonly fail?: readonly GitArgvExpectation[];
  readonly failOnOccurrence?: GitArgvExpectation & { readonly occurrence: number };
  readonly failNpm?: readonly string[];
  readonly pauseBefore?: readonly string[];
  readonly pauseBeforeOccurrence?: number;
  readonly removeThenFail?: GitArgvExpectation;
  readonly stripInventoryRecord?: { readonly path: string; readonly occurrence: number };
}

interface GitArgvExpectation {
  readonly args: readonly string[];
  readonly timestampReasonIndex?: number;
}

interface CommandLogEvent {
  readonly command: 'git' | 'npm';
  readonly args: string[];
  readonly timestamp: number;
}

async function installCommandShims(options: ShimOptions = {}): Promise<{ bin: string; gitLog: string; npmLog: string; commandLog: string; ready: string; release: string; filteredInventoryLog: string }> {
  const shimRoot = await mkdtemp(join(getFixture().root, 'command-shims-'));
  const bin = join(shimRoot, 'bin');
  const gitLog = join(shimRoot, 'git.jsonl');
  const npmLog = join(shimRoot, 'npm.jsonl');
  const commandLog = join(shimRoot, 'commands.jsonl');
  const ready = join(shimRoot, 'ready');
  const release = join(shimRoot, 'release');
  const filteredInventoryLog = join(shimRoot, 'filtered-inventory.log');
  const pauseCount = join(shimRoot, 'pause-count');
  await mkdir(bin);
  await writeFile(gitLog, '');
  await writeFile(npmLog, '');
  await writeFile(commandLog, '');
  await writeFile(pauseCount, '0');
  await writeFile(filteredInventoryLog, '');
  const config = JSON.stringify({ ...options, gitLog, ready, release, pauseCount, filteredInventoryLog });
  const gitShim = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const config = ${config};
appendFileSync(process.env.AMBERCAST_GIT_LOG, JSON.stringify(args) + '\\n');
appendFileSync(process.env.AMBERCAST_COMMAND_LOG, JSON.stringify({ command: 'git', args, timestamp: Date.now() }) + '\\n');
const equals = (wanted) => wanted.length === args.length && wanted.every((item, index) => args[index] === item);
const matches = (expected, actual = args) => expected.args.length === actual.length && expected.args.every((item, index) => {
  if (index !== expected.timestampReasonIndex) return actual[index] === item;
  return /^issue-\\d+ owner=[a-z0-9][a-z0-9._-]* created=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/i.test(actual[index] ?? '');
});
if (config.pauseBefore && equals(config.pauseBefore)) {
  const occurrence = Number(readFileSync(config.pauseCount, 'utf8')) + 1;
  writeFileSync(config.pauseCount, String(occurrence));
  if (occurrence !== (config.pauseBeforeOccurrence ?? 1)) {
    execFileSync(process.env.AMBERCAST_REAL_GIT, args, { stdio: 'inherit' });
    process.exit(0);
  }
  writeFileSync(config.ready, 'ready');
  const started = Date.now();
  while (!existsSync(config.release)) {
    if (Date.now() - started > 15_000) process.exit(92);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
if (config.removeThenFail && matches(config.removeThenFail)) {
  execFileSync(process.env.AMBERCAST_REAL_GIT, args, { stdio: 'inherit' });
  process.exit(91);
}
if (config.failOnOccurrence && matches(config.failOnOccurrence)) {
  const occurrences = readFileSync(config.gitLog, 'utf8').split('\\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((recorded) => matches(config.failOnOccurrence, recorded)).length;
  if (occurrences === config.failOnOccurrence.occurrence) process.exit(90);
}
if (config.stripInventoryRecord && equals(['worktree', 'list', '--porcelain', '-z'])) {
  const occurrences = readFileSync(config.gitLog, 'utf8').split('\\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((recorded) => matches({ args: ['worktree', 'list', '--porcelain', '-z'] }, recorded)).length;
  if (occurrences === config.stripInventoryRecord.occurrence) {
    const inventory = execFileSync(process.env.AMBERCAST_REAL_GIT, args, { encoding: 'utf8' });
    const blocks = [];
    let block = [];
    for (const record of inventory.split('\\0')) {
      if (record === '') {
        if (block.length > 0) {
          blocks.push(block);
          block = [];
        }
        continue;
      }
      block.push(record);
    }
    if (block.length > 0) blocks.push(block);
    const filtered = blocks
      .filter((records) => records[0] !== 'worktree ' + config.stripInventoryRecord.path)
      .map((records) => records.join('\\0'))
      .join('\\0\\0');
    writeFileSync(config.filteredInventoryLog, filtered);
    process.stdout.write(filtered);
    process.exit(0);
  }
}
if (config.fail && config.fail.some((expected) => matches(expected))) process.exit(90);
execFileSync(process.env.AMBERCAST_REAL_GIT, args, { stdio: 'inherit' });
`;
const npmShim = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = ${config};
appendFileSync(process.env.AMBERCAST_NPM_LOG, JSON.stringify(args) + '\\n');
appendFileSync(process.env.AMBERCAST_COMMAND_LOG, JSON.stringify({ command: 'npm', args, timestamp: Date.now() }) + '\\n');
if (config.failNpm && config.failNpm.some((expected) => expected === args.join(' '))) process.exit(90);
`;
  await Promise.all([
    writeFile(join(bin, 'git'), gitShim),
    writeFile(join(bin, 'npm'), npmShim),
  ]);
  await Promise.all([chmod(join(bin, 'git'), 0o755), chmod(join(bin, 'npm'), 0o755)]);
  return { bin, gitLog, npmLog, commandLog, ready, release, filteredInventoryLog };
}

function shimEnvironment(shims: { bin: string; gitLog: string; npmLog: string; commandLog: string }): NodeJS.ProcessEnv {
  return {
    PATH: `${shims.bin}${delimiter}${process.env.PATH ?? ''}`,
    AMBERCAST_REAL_GIT: REAL_GIT,
    AMBERCAST_GIT_LOG: shims.gitLog,
    AMBERCAST_NPM_LOG: shims.npmLog,
    AMBERCAST_COMMAND_LOG: shims.commandLog,
  };
}

async function readJsonLines(path: string): Promise<string[][]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

async function readCommandLog(path: string): Promise<CommandLogEvent[]> {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as CommandLogEvent);
}

async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= until) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  runGit(repository, ['init', '-b', 'main']);
  await writeFile(join(repository, 'README.md'), '# fixture\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
}

beforeEach(async () => {
  const createdRoot = await mkdtemp(join(tmpdir(), 'ambercast-worktree-scripts-'));
  const root = await realpath(createdRoot);
  const repositoryName = 'repo';
  const repository = join(root, 'product', 'workspace', repositoryName);
  const receptacleRoot = join(root, 'product', '.worktrees');
  const receptacle = join(receptacleRoot, repositoryName);

  await Promise.all([
    initializeRepository(repository),
    mkdir(receptacleRoot, { recursive: true }),
  ]);

  fixture = { root, repositoryName, repository, receptacleRoot, receptacle };
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

  it('namespaces the default receptacle by the main repository directory basename', () => {
    runAdd(['110']);
    const path = join(getFixture().root, 'product', '.worktrees', 'repo', 'issues-110');

    expect(existsSync(path)).toBe(true);
  });

  it('keeps same-number worktrees from differently named repositories separate', async () => {
    const secondRepositoryName = 'website';
    const secondRepository = join(getFixture().root, 'product', 'workspace', secondRepositoryName);
    await initializeRepository(secondRepository);

    runAdd(['110']);
    runAdd(['110'], { cwd: secondRepository });

    expect(existsSync(join(getFixture().receptacleRoot, 'repo', 'issues-110'))).toBe(true);
    expect(existsSync(join(getFixture().receptacleRoot, secondRepositoryName, 'issues-110'))).toBe(true);
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
      expect(await readdir(getFixture().receptacleRoot)).toEqual([]);
    },
  );

  it.each([['Bad-slug'], ['bad_slug'], ['-bad']])(
    'rejects invalid slug %s without creating a worktree',
    async (slug) => {
      const error = expectScriptFailure(() => runAdd(['106', slug]));

      expect(error).toContain('Usage:');
      expect(await readdir(getFixture().receptacleRoot)).toEqual([]);
    },
  );

  it('accepts --no-setup before the issue number and skips setup without the environment override', () => {
    runAdd(['--no-setup', '107'], { skipSetup: false });
    const path = worktreePath('107');

    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, 'node_modules'))).toBe(false);
  });

  it('rejects an unknown flag without creating a worktree', async () => {
    const error = expectScriptFailure(() => runAdd(['108', '--unexpected']));

    expect(error).toContain('Usage:');
    expect(await readdir(getFixture().receptacleRoot)).toEqual([]);
  });

  it('uses the absolute AMBERCAST_WORKTREE_ROOT override when provided', async () => {
    const override = join(getFixture().root, 'alternate-worktrees');
    await mkdir(override, { recursive: true });

    runAdd(['107'], { environment: { AMBERCAST_WORKTREE_ROOT: override } });

    expect(existsSync(join(override, 'repo', 'issues-107'))).toBe(true);
    expect(existsSync(join(override, 'issues-107'))).toBe(false);
    expect(existsSync(worktreePath('107'))).toBe(false);
  });

  it('uses repository directory names verbatim as namespace segments', async () => {
    const repositoryName = 'ambercast.web';
    const repository = join(getFixture().root, 'product', 'workspace', repositoryName);
    await initializeRepository(repository);

    runAdd(['111'], { cwd: repository });

    expect(existsSync(join(getFixture().receptacleRoot, repositoryName, 'issues-111'))).toBe(true);
  });

  it('rejects a relative AMBERCAST_WORKTREE_ROOT override without creating a worktree', async () => {
    const error = expectScriptFailure(() => runAdd(['109'], {
      environment: { AMBERCAST_WORKTREE_ROOT: 'relative-worktrees' },
    }));

    expect(error).toMatch(/absolute path/i);
    expect(await readdir(getFixture().receptacleRoot)).toEqual([]);
    expect(branchExists('issues/109')).toBe(false);
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

  it('removes a namespaced worktree selected by its bare issue number', () => {
    const path = createWorktree('211');

    expect(path).toBe(join(getFixture().receptacleRoot, 'repo', 'issues-211'));
    runRemove(['211']);

    expect(existsSync(path)).toBe(false);
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

  it('deletes a merged branch with --with-branch only after removing its worktree', async () => {
    const path = createWorktree('206');
    const shims = await installCommandShims();

    runRemove(['206', '--with-branch'], { environment: shimEnvironment(shims) });

    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/206')).toBe(false);
    const calls = await readCommandLog(shims.commandLog);
    expect(calls.findIndex(({ command, args }) => command === 'git' && args.join('\0') === ['worktree', 'remove', path].join('\0'))).toBeLessThan(
      calls.findIndex(({ command, args }) => command === 'git' && args.join('\0') === ['branch', '-d', 'issues/206'].join('\0')),
    );
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

  it('refuses to remove the worktree containing the running command', () => {
    const path = createWorktree('208');

    const error = expectScriptFailure(() => runRemove(['208', '--with-branch'], { cwd: path }));

    expect(error).toMatch(/run from the main checkout/i);
    expect(existsSync(path)).toBe(true);
    expect(branchExists('issues/208')).toBe(true);
  });

  it('force-deletes an unmerged branch when --force and --with-branch are supplied', async () => {
    const path = createWorktree('209');
    await writeFile(join(path, 'change.txt'), 'unmerged\n');
    runGit(path, ['add', 'change.txt']);
    runGit(path, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'unmerged']);

    runRemove(['209', '--force', '--with-branch']);

    expect(existsSync(path)).toBe(false);
    expect(branchExists('issues/209')).toBe(false);
  });

  it('rejects an unknown issue number', () => {
    const error = expectScriptFailure(() => runRemove(['999']));

    expect(error).toMatch(/no worktree.*999/i);
  });

  it('copies missing logs and todos back without overwriting main-checkout files', async () => {
    const path = createWorktree('210');
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

    const output = runRemove(['210', '--force']);

    await expect(readFile(join(mainLogs, 'only-in-worktree.md'), 'utf8')).resolves.toBe('preserve this log\n');
    await expect(readFile(join(mainLogs, 'already-in-main.md'), 'utf8')).resolves.toBe('main copy\n');
    await expect(readFile(join(mainTodos, 'nested', 'only-in-worktree.md'), 'utf8')).resolves.toBe('preserve this todo\n');
    expect(output).toMatch(/skipped.*already-in-main/i);
    expect(output).toContain('Copied todo file: nested/only-in-worktree.md');
  });

  it('refuses to remove the main worktree when given its path', () => {
    const error = expectScriptFailure(() => runRemove([getFixture().repository]));

    expect(error).toMatch(/main worktree/i);
    expect(existsSync(getFixture().repository)).toBe(true);
  });
});

describe('worktree lifecycle safety primitives', () => {
  it('parses NUL porcelain without changing lock evidence', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseWorktreePorcelain('worktree /repo\0branch refs/heads/main\0\0')).toEqual([
      { path: '/repo', branch: 'main' },
    ]);
    expect(parseWorktreePorcelain('worktree /locked\0locked\0\0')).toEqual([{ path: '/locked', locked: true }]);
    expect(parseWorktreePorcelain('worktree /reason\0locked owner has spaces\0\0')).toEqual([
      { path: '/reason', locked: 'owner has spaces' },
    ]);
    expect(parseWorktreePorcelain('worktree /newline\0locked line one\nline two\0\0')).toEqual([
      { path: '/newline', locked: 'line one\nline two' },
    ]);
    expect(parseWorktreePorcelain('worktree /one\0HEAD abc\0prunable stale\0\0worktree /two\0detached\0branch refs/heads/issues/2\0')).toEqual([
      { path: '/one' },
      { path: '/two', branch: 'issues/2' },
    ]);
  });

  it('uses component-aware inclusive and strict containment', () => {
    const parent = '/tmp/receptacle';
    expect(isSameOrDescendant(parent, parent)).toBe(true);
    expect(isStrictDescendant(parent, parent)).toBe(false);
    expect(isSameOrDescendant(parent, '/tmp/receptacle/issues-22')).toBe(true);
    expect(isStrictDescendant(parent, '/tmp/receptacle/issues-22')).toBe(true);
    expect(isSameOrDescendant(parent, '/tmp/sibling')).toBe(false);
    expect(isStrictDescendant(parent, '/tmp/sibling')).toBe(false);
    expect(isSameOrDescendant('/tmp/receptacle/issues-22', '/tmp/receptacle/issues-220')).toBe(false);
    expect(isSameOrDescendant(parent, '/tmp/receptacle/..cache')).toBe(true);
    expect(isStrictDescendant(parent, '/different-root')).toBe(false);
    expect(relative(parent, '/different-root')).toMatch(/^\.\./);
  });

  it('formats only valid owners and captures both cwd resolution failures', () => {
    expect(formatLockReason(235, 'Owner._-9', '2026-08-31T12:34:56Z')).toMatch(
      /^issue-\d+ owner=[a-z0-9][a-z0-9._-]* created=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/i,
    );
    expect(() => formatLockReason(235, 'bad owner', '2026-08-31T12:34:56Z')).toThrow();
    expect(() => formatLockReason(235, '!bad', '2026-08-31T12:34:56Z')).toThrow();
    expect(resolveCwdRealpath({ cwdFn: () => { throw new Error('deleted cwd'); } })).toMatchObject({ ok: false });
    expect(resolveCwdRealpath({ cwdFn: () => '/cwd', realpathFn: () => { throw new Error('bad link'); } })).toMatchObject({ ok: false });
  });
});

describe('worktree-add locking contract', () => {
  it('locks before setup, records the exact reason, and forwards --owner', async () => {
    const shims = await installCommandShims();
    const output = runAdd(['301', '--owner', 'agent.one'], { environment: shimEnvironment(shims), skipSetup: false });
    const path = worktreePath('301');
    const inventory = runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']);
    const reason = /Locked: (.+)/.exec(output)?.[1];
    expect(reason).toMatch(/^issue-301 owner=agent.one created=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(inventory).toContain(`locked ${reason}`);
    const gitCalls = await readJsonLines(shims.gitLog);
    const commandCalls = await readCommandLog(shims.commandLog);
    const addIndex = commandCalls.findIndex(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree add');
    const lockIndex = commandCalls.findIndex(({ command, args }) => command === 'git' && args.slice(0, 2).join(' ') === 'worktree lock');
    const ciIndex = commandCalls.findIndex(({ command, args }) => command === 'npm' && args.join(' ') === 'ci');
    const buildIndex = commandCalls.findIndex(({ command, args }) => command === 'npm' && args.join(' ') === 'run build');
    expect(gitCalls.filter((args) => args.slice(0, 2).join(' ') === 'worktree lock')).toHaveLength(1);
    expect(addIndex).toBeLessThan(lockIndex);
    expect(lockIndex).toBeLessThan(ciIndex);
    expect(ciIndex).toBeLessThan(buildIndex);
    expect(existsSync(path)).toBe(true);
  });

  it.each([
    [['302', '--owner']],
    [['302', '--owner', '--no-setup']],
    [['302', '--owner', 'a', '--owner', 'b']],
    [['302', '--owner', 'bad owner']],
    [['302', '--owner', 'bad!']],
  ])('rejects invalid owner arguments %#', async (args) => {
    const error = expectScriptFailure(() => runAdd(args));
    expect(error).toContain('Usage:');
    expect(await readdir(getFixture().receptacleRoot)).toEqual([]);
  });

  it.each(['a.b', 'a_b', 'a-b'])('accepts owner grammar boundary %s', (owner) => {
    const output = runAdd(['303', owner === 'a.b' ? 'dot' : owner === 'a_b' ? 'under' : 'dash', '--owner', owner]);
    expect(output).toContain(`owner=${owner}`);
  });

  it('defaults owner and fails closed when git lock fails without running npm', async () => {
    const defaultOutput = runAdd(['304']);
    expect(defaultOutput).toContain('owner=unassigned');
    const target = worktreePath('305');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'lock', '--reason', '', target], timestampReasonIndex: 3 }],
    });
    const output = expectScriptFailureOutput(() => runAdd(['305'], { environment: shimEnvironment(shims), skipSetup: false }));
    expect(output.stderr).toMatch(/lock failed.*do NOT assign/i);
    expect(existsSync(target)).toBe(true);
    const inventory = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']));
    expect(inventory).toContainEqual(expect.objectContaining({ path: target }));
    expect(inventory.find((worktree: { path: string; locked?: true | string }) => worktree.path === target)?.locked).toBeUndefined();
    expect(output.stdout).not.toContain('Locked:');
    expect(await readJsonLines(shims.npmLog)).toEqual([]);
  });

  it('prints readiness output only after setup succeeds', async () => {
    const shims = await installCommandShims({ failNpm: ['ci'] });

    const output = expectScriptFailureOutput(() => runAdd(['306'], { environment: shimEnvironment(shims), skipSetup: false }));

    expect(output.stderr).toMatch(/setup failed/i);
    expect(output.stdout).not.toMatch(/Created worktree:|Branch:|Locked:/);
  });
});

describe('ensureTargetLocked', () => {
  const targetPath = '/worktrees/issues-241';
  const expectedBranch = 'issues/241';

  it('locks a present registered target that is currently unlocked', () => {
    const calls: string[][] = [];

    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: undefined },
      {
        listWorktreesFn: () => [{ path: targetPath, branch: expectedBranch }],
        existsFn: () => true,
        runGitFn: (args: string[]) => { calls.push(args); return ''; },
      },
    )).toEqual({ state: 'locked', detail: 'lock restoration succeeded' });
    expect(calls).toEqual([['worktree', 'lock', targetPath]]);
  });

  it('leaves a present but unregistered path fail-closed', () => {
    // Issue #241 uses a seam because unregistering a live fixture requires fragile Git administrative-file surgery.
    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: undefined },
      { listWorktreesFn: () => [], existsFn: () => true },
    )).toEqual({ state: 'unknown', detail: 'target path exists but is no longer a registered worktree' });
  });

  it('retains an unknown state when recovery inventory cannot be read', () => {
    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: undefined },
      { listWorktreesFn: () => { throw new Error('inventory unavailable'); } },
    )).toEqual({ state: 'unknown', detail: 'Unable to confirm target identity: inventory unavailable' });
  });

  it('retains an unknown state when target presence cannot be confirmed', () => {
    const gitCalls: string[][] = [];
    const runGitFn = (args: string[]): string => { gitCalls.push(args); return ''; };

    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: undefined },
      {
        listWorktreesFn: () => [{ path: targetPath, branch: expectedBranch }],
        existsFn: () => { throw new Error('presence check failed'); },
        runGitFn,
      },
    )).toEqual({ state: 'unknown', detail: 'Unable to confirm target presence: presence check failed' });
    expect(gitCalls).toEqual([]);
  });

  it('retains an unknown state when relocking fails', () => {
    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: true },
      {
        listWorktreesFn: () => [{ path: targetPath, branch: expectedBranch }],
        existsFn: () => true,
        runGitFn: () => { throw new Error('lock failed'); },
      },
    )).toEqual({ state: 'unknown', detail: 'failed to restore lock: lock failed' });
  });

  it('treats branchless expected identity and a registered branch as drift', () => {
    expect(ensureTargetLocked(
      { targetPath, expectedBranch: undefined, originalLock: undefined },
      {
        listWorktreesFn: () => [{ path: targetPath, branch: expectedBranch }],
        existsFn: () => true,
      },
    )).toEqual({ state: 'unknown', detail: 'registered branch does not match the expected target identity' });
  });

  it('reports gone only when the target is neither registered nor present', () => {
    expect(ensureTargetLocked(
      { targetPath, expectedBranch, originalLock: undefined },
      { listWorktreesFn: () => [], existsFn: () => false },
    )).toEqual({ state: 'gone', detail: 'target is no longer registered or present' });
  });
});

describe('worktree-remove locking, validation, and mutex contract', () => {
  async function lock(path: string, reason?: string): Promise<void> {
    runGit(getFixture().repository, reason === undefined
      ? ['worktree', 'lock', path]
      : ['worktree', 'lock', '--reason', reason, path]);
  }

  function expectRegisteredAndLocked(path: string): void {
    const inventory = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']));
    expect(inventory).toContainEqual(expect.objectContaining({ path }));
    expect(inventory.find((worktree: { path: string; locked?: true | string }) => worktree.path === path)?.locked).toBeDefined();
  }

  async function expectNoDestructiveCalls(shims: { gitLog: string }): Promise<void> {
    const calls = await readJsonLines(shims.gitLog);
    expect(calls.some((args) => args[0] === 'worktree' && ['unlock', 'remove'].includes(args[1] ?? ''))).toBe(false);
  }

  it('unlocks a locked tree before removing it and skips unlock for legacy trees', async () => {
    createWorktree('401');
    const shims = await installCommandShims();
    runRemove(['401'], { environment: shimEnvironment(shims) });
    const calls = await readJsonLines(shims.gitLog);
    expect(calls.findIndex((args) => args.slice(0, 2).join(' ') === 'worktree unlock')).toBeLessThan(
      calls.findIndex((args) => args.slice(0, 2).join(' ') === 'worktree remove'),
    );
    const legacy = worktreePath('402');
    await mkdir(getFixture().receptacle, { recursive: true });
    runGit(getFixture().repository, ['worktree', 'add', '-b', 'issues/402', legacy]);
    const second = await installCommandShims();
    runRemove(['402'], { environment: shimEnvironment(second) });
    expect((await readJsonLines(second.gitLog)).some((args) => args.slice(0, 2).join(' ') === 'worktree unlock')).toBe(false);
    expect(existsSync(legacy)).toBe(false);
  });

  it('refuses each self-removal form without changing registered locked targets', async () => {
    const target = createWorktree('403');
    for (const cwd of [target, join(target, '.claude')]) {
      await mkdir(cwd, { recursive: true });
      const shims = await installCommandShims();
      const error = expectScriptFailure(() => runRemove(['403'], { cwd, environment: shimEnvironment(shims) }));
      expect(error).toMatch(/run from the main checkout|containing this command/i);
      await expectNoDestructiveCalls(shims);
      expectRegisteredAndLocked(target);
    }
    const link = join(getFixture().root, 'inside-link');
    await symlink(target, link);
    expect(await realpath(link)).toBe(target);
    const shims = await installCommandShims();
    const error = expectScriptFailure(() => runRemove(['403'], { cwd: link, environment: shimEnvironment(shims) }));
    expect(error).toMatch(/main checkout|containing/i);
    await expectNoDestructiveCalls(shims);
    expectRegisteredAndLocked(target);
  });

  it('allows sibling names with a shared prefix and supports an override across add/remove', async () => {
    const sibling = createWorktree('22');
    const target = createWorktree('220');
    runRemove(['220'], { cwd: sibling });
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(target)).toBe(false);
    const override = join(getFixture().root, 'override');
    await mkdir(override);
    runAdd(['404'], { environment: { AMBERCAST_WORKTREE_ROOT: override } });
    const overridden = join(override, 'repo', 'issues-404');
    runRemove(['404'], { environment: { AMBERCAST_WORKTREE_ROOT: override } });
    expect(existsSync(overridden)).toBe(false);
  });

  it('does not release a pre-existing mutex and exposes its journal', async () => {
    const path = createWorktree('405');
    const mutex = join(getFixture().receptacle, '.cleanup-lock');
    await mkdir(mutex, { recursive: true });
    await writeFile(join(mutex, 'transaction.json'), '{"phase":"unlocked"}');
    const error = expectScriptFailure(() => runRemove(['405']));
    expect(error).toContain(mutex);
    expect(error).toContain('unlocked');
    expect(existsSync(mutex)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('leaves a pre-unlock transaction journal while a remover is paused and cleans it after success', async () => {
    const target = createWorktree('406');
    const shims = await installCommandShims({ pauseBefore: ['worktree', 'unlock', target] });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '406'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });
    try {
      await waitFor(shims.ready);
      const journal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
      expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ target, phase: 'pre-unlock' });
      const secondShims = await installCommandShims();
      const second = expectScriptFailure(() => runRemove(['406'], { environment: shimEnvironment(secondShims) }));
      expect(second).toContain('.cleanup-lock');
      await expectNoDestructiveCalls(secondShims);
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 0 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('treats unlock failure as fatal and releases an owned mutex', async () => {
    const target = createWorktree('407');
    const originalLock = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))
      .find((worktree: { readonly path: string }) => worktree.path === target)?.locked;
    const shims = await installCommandShims({ fail: [{ args: ['worktree', 'unlock', target] }] });
    const error = expectScriptFailure(() => runRemove(['407'], { environment: shimEnvironment(shims) }));
    expect(error).toMatch(/unlock/i);
    const calls = await readJsonLines(shims.gitLog);
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'lock')).toBe(false);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))
      .find((worktree: { readonly path: string }) => worktree.path === target)?.locked).toBe(originalLock);
  });

  it('restores the exact reason after a post-unlock journal write failure and releases its mutex', async () => {
    const target = createWorktree('421');
    const originalLock = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))
      .find((worktree: { readonly path: string }) => worktree.path === target)?.locked;
    const shims = await installCommandShims({ pauseBefore: ['worktree', 'unlock', target] });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '421'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const mutex = join(getFixture().receptacle, '.cleanup-lock');
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    try {
      await waitFor(shims.ready);
      await chmod(join(mutex, 'transaction.json'), 0o400);
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 1 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      expect(stderr).toContain('lock restoration succeeded');
      expect(stderr).toContain('failed to update transaction journal');
      expect(stderr).toMatch(/EACCES|permission/i);
      expect(existsSync(mutex)).toBe(false);
      const registeredTarget = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))
        .find((worktree: { readonly path: string }) => worktree.path === target);
      expect(registeredTarget).toBeDefined();
      expect(registeredTarget?.locked).toBe(originalLock);
      expect(await readJsonLines(shims.gitLog)).toContainEqual(['worktree', 'lock', '--reason', originalLock, target]);
    } finally {
      await chmod(join(mutex, 'transaction.json'), 0o600).catch(() => undefined);
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('retains the mutex without overwriting a mismatched lock reason', async () => {
    const target = createWorktree('426');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'remove', target] }],
      pauseBefore: ['worktree', 'remove', target],
    });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '426'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });

    try {
      await waitFor(shims.ready);
      runGit(getFixture().repository, ['worktree', 'lock', '--reason', 'third-party reason', target]);
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 1 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      const mutex = join(getFixture().receptacle, '.cleanup-lock');
      const journal = join(mutex, 'transaction.json');
      expect(existsSync(mutex)).toBe(true);
      expect(existsSync(journal)).toBe(true);
      expect(parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))
        .find((worktree: { readonly path: string }) => worktree.path === target)?.locked).toBe('third-party reason');
      const calls = await readJsonLines(shims.gitLog);
      expect(calls.filter((args) => args[0] === 'worktree' && args[1] === 'lock')).toHaveLength(0);
      expect(calls.filter((args) => args.join('\0') === 'worktree\0list\0--porcelain\0-z')).toHaveLength(3);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('retains the mutex when the registered target drifts to another branch', async () => {
    const target = createWorktree('427');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'remove', target] }],
      pauseBefore: ['worktree', 'remove', target],
    });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '427'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });

    try {
      await waitFor(shims.ready);
      runGit(target, ['switch', '-c', 'issues/427-drift']);
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 1 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
      expect(existsSync(join(getFixture().receptacle, '.cleanup-lock', 'transaction.json'))).toBe(true);
      expect((await readJsonLines(shims.gitLog)).some((args) => args[0] === 'worktree' && args[1] === 'lock')).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('retains the mutex when a registered target disappears from disk', async () => {
    const target = createWorktree('428');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'remove', target] }],
      pauseBefore: ['worktree', 'remove', target],
    });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '428'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });

    try {
      await waitFor(shims.ready);
      await rm(target, { force: true, recursive: true });
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 1 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
      expect(existsSync(join(getFixture().receptacle, '.cleanup-lock', 'transaction.json'))).toBe(true);
      expect((await readJsonLines(shims.gitLog)).some((args) => args[0] === 'worktree' && args[1] === 'lock')).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('retains the mutex when the recovery inventory command fails', async () => {
    const target = createWorktree('429');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'remove', target] }],
      failOnOccurrence: { args: ['worktree', 'list', '--porcelain', '-z'], occurrence: 3 },
    });

    expect(expectScriptFailure(() => runRemove(['429'], { environment: shimEnvironment(shims) }))).toMatch(/remove/i);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
    expect(JSON.parse(await readFile(join(getFixture().receptacle, '.cleanup-lock', 'transaction.json'), 'utf8'))).toMatchObject({ target });
  });

  it('fails closed when recovery finds a present target that is no longer registered', async () => {
    const target = createWorktree('431');
    const bystander = createWorktree('432');
    const shims = await installCommandShims({
      fail: [{ args: ['worktree', 'remove', target] }],
      stripInventoryRecord: { path: target, occurrence: 3 },
    });
    let error: { readonly status?: number | null; readonly stderr?: string | Buffer } | undefined;

    try {
      runRemove(['431'], { environment: shimEnvironment(shims) });
    } catch (caught) {
      if (typeof caught !== 'object' || caught === null) throw caught;
      error = caught as { readonly status?: number | null; readonly stderr?: string | Buffer };
    }

    if (error === undefined) throw new Error('Expected worktree-remove to fail.');
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.stderr?.toString('utf8') ?? '';
    expect(error.status).toBe(1);
    expect(stderr).toContain('target path exists but is no longer a registered worktree');
    expect(existsSync(target)).toBe(true);
    expect((await readJsonLines(shims.gitLog)).some((args) => args.join('\0') === ['worktree', 'lock', target].join('\0'))).toBe(false);
    const mutex = join(getFixture().receptacle, '.cleanup-lock');
    expect(existsSync(mutex)).toBe(true);
    expect(JSON.parse(await readFile(join(mutex, 'transaction.json'), 'utf8'))).toMatchObject({ phase: 'unlocked' });

    const filtered = parseWorktreePorcelain(await readFile(shims.filteredInventoryLog, 'utf8')) as readonly { readonly path: string; readonly branch?: string; readonly locked?: true | string }[];
    const unshimmed = parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z'])) as readonly { readonly path: string; readonly branch?: string; readonly locked?: true | string }[];
    const mainPath = getFixture().repository;
    expect(filtered.find((worktree) => worktree.path === target)).toBeUndefined();
    for (const path of [mainPath, bystander]) {
      expect(filtered.find((worktree) => worktree.path === path)).toEqual(
        unshimmed.find((worktree) => worktree.path === path),
      );
    }
  });

  it('locks a detached worktree with matching branchless identity after removal failure', async () => {
    const target = worktreePath('430');
    await mkdir(getFixture().receptacle, { recursive: true });
    runGit(getFixture().repository, ['worktree', 'add', '--detach', target, 'HEAD']);
    const shims = await installCommandShims({ fail: [{ args: ['worktree', 'remove', target] }] });

    expect(expectScriptFailure(() => runRemove([target], { environment: shimEnvironment(shims) }))).toMatch(/remove/i);
    expect(parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))).toContainEqual(
      expect.objectContaining({ path: target, locked: true }),
    );
    expect((await readJsonLines(shims.gitLog)).filter((args) => args[0] === 'worktree' && args[1] === 'lock')).toEqual([
      ['worktree', 'lock', target],
    ]);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
  });

  it('restores string and bare locks after a failed remove, reporting restoration success', async () => {
    const stringTarget = createUnlockedWorktree('408');
    await lock(stringTarget, 'the original reason with spaces');
    const stringShim = await installCommandShims({ fail: [{ args: ['worktree', 'remove', stringTarget] }] });
    const stringError = expectScriptFailure(() => runRemove(['408'], { environment: shimEnvironment(stringShim) }));
    expect(stringError).toMatch(/remove.*restoration succeeded|restoration succeeded.*remove/is);
    expect((await readJsonLines(stringShim.gitLog)).some((args) => args.join('\0').includes('the original reason with spaces'))).toBe(true);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);

    const bareTarget = createUnlockedWorktree('409');
    await lock(bareTarget);
    const bareShim = await installCommandShims({ fail: [{ args: ['worktree', 'remove', bareTarget] }] });
    const bareError = expectScriptFailure(() => runRemove(['409'], { environment: shimEnvironment(bareShim) }));
    expect(bareError).toMatch(/remove.*restoration succeeded|restoration succeeded.*remove/is);
    const relock = (await readJsonLines(bareShim.gitLog)).find((args) => args[0] === 'worktree' && args[1] === 'lock');
    expect(relock).not.toContain('--reason');
    expectRegisteredAndLocked(bareTarget);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);

    const failedBareTarget = createUnlockedWorktree('420');
    await lock(failedBareTarget);
    const failedBareShim = await installCommandShims({
      fail: [
        { args: ['worktree', 'remove', failedBareTarget] },
        { args: ['worktree', 'lock', failedBareTarget] },
      ],
    });
    const failedBareError = expectScriptFailure(() => runRemove(['420'], { environment: shimEnvironment(failedBareShim) }));
    expect(failedBareError).toMatch(/remove.*lock|lock.*remove/is);
    const bareJournal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
    expect(JSON.parse(await readFile(bareJournal, 'utf8'))).toMatchObject({ target: failedBareTarget, phase: 'unlocked' });
  });

  it('does not re-lock a directory that git removed before reporting removal failure', async () => {
    const target = createWorktree('410');
    const shims = await installCommandShims({ removeThenFail: { args: ['worktree', 'remove', target] } });
    const error = expectScriptFailure(() => runRemove(['410'], { environment: shimEnvironment(shims) }));
    expect(error).toMatch(/remove/i);
    const calls = await readJsonLines(shims.gitLog);
    expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'lock')).toBe(false);
    const journal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ target, phase: 'unlocked' });
  });

  it('retains the mutex and journal when a legacy-unlocked removal succeeds before git reports failure', async () => {
    const target = createUnlockedWorktree('422');
    const shims = await installCommandShims({ removeThenFail: { args: ['worktree', 'remove', target] } });

    expect(expectScriptFailure(() => runRemove(['422'], { environment: shimEnvironment(shims) }))).toMatch(/remove/i);
    const journal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ target, phase: 'unlocked' });
    expect(existsSync(target)).toBe(false);
  });

  it('retains the mutex and journal when a legacy-unlocked post-remove journal update fails', async () => {
    const target = createUnlockedWorktree('423');
    const shims = await installCommandShims({ pauseBefore: ['worktree', 'remove', target] });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '423'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });
    const mutex = join(getFixture().receptacle, '.cleanup-lock');
    const journal = join(mutex, 'transaction.json');

    try {
      await waitFor(shims.ready);
      await rm(journal);
      await mkdir(journal);
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 1 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      expect(existsSync(mutex)).toBe(true);
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('retains the mutex and journal when legacy-unlocked branch deletion fails', async () => {
    const target = createUnlockedWorktree('424');
    const shims = await installCommandShims({ fail: [{ args: ['branch', '-d', 'issues/424'] }] });

    expect(expectScriptFailure(() => runRemove(['424', '--with-branch'], { environment: shimEnvironment(shims) }))).toMatch(/branch/i);
    const journal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(true);
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ target, phase: 'removed' });
    expect(existsSync(target)).toBe(false);
  });

  it('does not delete a branch when worktree removal fails', async () => {
    const target = createWorktree('414');
    const shims = await installCommandShims({ fail: [{ args: ['worktree', 'remove', target] }] });

    expect(expectScriptFailure(() => runRemove(['414', '--with-branch'], { environment: shimEnvironment(shims) }))).toMatch(/remove/i);

    expect(branchExists('issues/414')).toBe(true);
    const calls = await readJsonLines(shims.gitLog);
    expect(calls.some((args) => args[0] === 'branch' && ['-d', '-D'].includes(args[1] ?? ''))).toBe(false);
  });

  it('records unlocked and removed journal phases, then releases the journal after a restored lock', async () => {
    const unlockedTarget = createWorktree('415');
    const pauseShims = await installCommandShims({ pauseBefore: ['worktree', 'remove', unlockedTarget] });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '415'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(pauseShims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });
    try {
      await waitFor(pauseShims.ready);
      const journal = join(getFixture().receptacle, '.cleanup-lock', 'transaction.json');
      expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ target: unlockedTarget, phase: 'unlocked' });
      await writeFile(pauseShims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 0 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }

    const removedTarget = createWorktree('416');
    const removedShims = await installCommandShims({ fail: [{ args: ['branch', '-d', 'issues/416'] }] });
    expect(expectScriptFailure(() => runRemove(['416', '--with-branch'], { environment: shimEnvironment(removedShims) }))).toMatch(/branch/i);
    expect(JSON.parse(await readFile(join(getFixture().receptacle, '.cleanup-lock', 'transaction.json'), 'utf8'))).toMatchObject({
      target: removedTarget,
      phase: 'removed',
    });
    await rm(join(getFixture().receptacle, '.cleanup-lock'), { force: true, recursive: true });

    const relockedTarget = createWorktree('417');
    const relockedShims = await installCommandShims({ fail: [{ args: ['worktree', 'remove', relockedTarget] }] });
    expect(expectScriptFailure(() => runRemove(['417'], { environment: shimEnvironment(relockedShims) }))).toMatch(/remove/i);
    expectRegisteredAndLocked(relockedTarget);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
  }, 30_000);

  it('locks a previously-unlocked worktree that survives a failed removal and releases its mutex', async () => {
    const target = worktreePath('418');
    await mkdir(getFixture().receptacle, { recursive: true });
    runGit(getFixture().repository, ['worktree', 'add', '-b', 'issues/418', target]);
    const shims = await installCommandShims({ fail: [{ args: ['worktree', 'remove', target] }] });

    expect(expectScriptFailure(() => runRemove(['418'], { environment: shimEnvironment(shims) }))).toMatch(/remove/i);
    const calls = await readJsonLines(shims.gitLog);
    const relocks = calls.filter((args) => args[0] === 'worktree' && args[1] === 'lock');
    expect(relocks).toEqual([['worktree', 'lock', target]]);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock', 'transaction.json'))).toBe(false);
    expect(parseWorktreePorcelain(runGit(getFixture().repository, ['worktree', 'list', '--porcelain', '-z']))).toContainEqual(
      expect.objectContaining({ path: target, locked: true }),
    );
  });

  it('uses the post-mutex inventory as the authority for the target lock state', async () => {
    const target = worktreePath('419');
    await mkdir(getFixture().receptacle, { recursive: true });
    runGit(getFixture().repository, ['worktree', 'add', '-b', 'issues/419', target]);
    const shims = await installCommandShims({
      pauseBefore: ['worktree', 'list', '--porcelain', '-z'],
      pauseBeforeOccurrence: 2,
    });
    const child = spawn(process.execPath, [REMOVE_SCRIPT, '419'], {
      cwd: getFixture().repository,
      env: { ...process.env, ...shimEnvironment(shims), AMBERCAST_WT_SKIP_SETUP: '1' },
      stdio: 'ignore',
    });
    try {
      await waitFor(shims.ready);
      await lock(target, 'changed after pre-mutex inventory');
      await writeFile(shims.release, 'release');
      await new Promise<void>((resolveChild, rejectChild) => child.once('exit', (code) => code === 0 ? resolveChild() : rejectChild(new Error(`remover exited ${code}`))));
      const calls = await readJsonLines(shims.gitLog);
      expect(calls).toContainEqual(['worktree', 'unlock', target]);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      }
    }
  }, 30_000);

  it('rejects external, unregistered, missing, and main targets before destructive operations', async () => {
    const external = join(getFixture().root, 'external-worktree');
    runGit(getFixture().repository, ['worktree', 'add', '-b', 'issues/411', external]);
    const externalShims = await installCommandShims();
    expect(expectScriptFailure(() => runRemove(['411'], { environment: shimEnvironment(externalShims) }))).toMatch(/receptacle|managed|contain/i);
    await expectNoDestructiveCalls(externalShims);
    const unregistered = join(getFixture().receptacle, 'unregistered');
    await mkdir(unregistered, { recursive: true });
    const unregisteredShims = await installCommandShims();
    expect(expectScriptFailure(() => runRemove([unregistered], { environment: shimEnvironment(unregisteredShims) }))).toMatch(/no worktree/i);
    await expectNoDestructiveCalls(unregisteredShims);
    const missing = createWorktree('412');
    await rm(missing, { force: true, recursive: true });
    const missingShims = await installCommandShims();
    expect(expectScriptFailure(() => runRemove(['412'], { environment: shimEnvironment(missingShims) }))).toMatch(/realpath|exist|missing/i);
    await expectNoDestructiveCalls(missingShims);
    await rm(getFixture().receptacle, { force: true, recursive: true });
    const mainShims = await installCommandShims();
    expect(expectScriptFailure(() => runRemove([getFixture().repository], { environment: shimEnvironment(mainShims) }))).toMatch(/main worktree/i);
    await expectNoDestructiveCalls(mainShims);
  });

  it('releases owned mutexes after dirty refusal and treats EACCES as non-competition', async () => {
    const dirty = createWorktree('413');
    await writeFile(join(dirty, 'dirty.txt'), 'dirty');
    expect(expectScriptFailure(() => runRemove(['413']))).toMatch(/dirty/i);
    expect(existsSync(join(getFixture().receptacle, '.cleanup-lock'))).toBe(false);
    await chmod(getFixture().receptacle, 0o500);
    try {
      const error = expectScriptFailure(() => runRemove(['413']));
      expect(error).not.toMatch(/another cleanup|competing|stale/i);
      expect(error).toMatch(/EACCES|permission/i);
    } finally {
      await chmod(getFixture().receptacle, 0o700);
    }
  });
});
