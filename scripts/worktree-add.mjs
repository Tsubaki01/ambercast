#!/usr/bin/env node
// Creates an isolated issue worktree without depending on one developer's
// checkout location. Git remains the authority for branch and worktree state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const USAGE = 'Usage: node scripts/worktree-add.mjs <issue-number> [slug] [--no-setup]';
const ISSUE_NUMBER = /^[1-9]\d*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function fail(message) {
  console.error(`worktree-add: ${message}`);
  process.exitCode = 1;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitSucceeds(args) {
  try {
    runGit(args);
    return true;
  } catch {
    return false;
  }
}

function parseWorktreeList() {
  const output = runGit(['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let worktree;

  for (const line of output.split('\n')) {
    if (line === '') {
      if (worktree !== undefined) {
        worktrees.push(worktree);
        worktree = undefined;
      }
      continue;
    }

    if (line.startsWith('worktree ')) {
      worktree = { path: line.slice('worktree '.length) };
      continue;
    }

    if (worktree !== undefined && line.startsWith('branch refs/heads/')) {
      worktree.branch = line.slice('branch refs/heads/'.length);
    }
  }

  if (worktree !== undefined) {
    worktrees.push(worktree);
  }

  if (worktrees.length === 0) {
    throw new Error('Git did not report a main worktree.');
  }

  return worktrees;
}

// Git lists the primary checkout first. Resolving its top-level directory
// makes the layout work when this command itself runs from a linked worktree.
function resolveMainWorktree(worktrees) {
  const [mainWorktree] = worktrees;

  if (mainWorktree === undefined) {
    throw new Error('Git did not report a main worktree.');
  }

  return runGit(['-C', mainWorktree.path, 'rev-parse', '--show-toplevel']).trim();
}

function resolveReceptacle(mainWorktree) {
  const override = process.env.AMBERCAST_WORKTREE_ROOT;

  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error('AMBERCAST_WORKTREE_ROOT must be an absolute path.');
    }

    return resolve(override);
  }

  return resolve(mainWorktree, '..', '..', '.worktrees');
}

function parseArguments(args) {
  const argumentsWithoutSetup = [...args];
  const noSetupIndex = argumentsWithoutSetup.indexOf('--no-setup');

  if (noSetupIndex !== -1 && noSetupIndex !== argumentsWithoutSetup.length - 1) {
    return undefined;
  }

  const noSetup = noSetupIndex !== -1;
  if (noSetup) {
    argumentsWithoutSetup.pop();
  }

  const [issue, slug, ...extra] = argumentsWithoutSetup;
  if (
    extra.length > 0
    || issue === undefined
    || !ISSUE_NUMBER.test(issue)
    || (slug !== undefined && !SLUG.test(slug))
  ) {
    return undefined;
  }

  return { issue, slug, noSetup };
}

function addWorktree(target, branch, branchExists) {
  if (branchExists) {
    execFileSync('git', ['worktree', 'add', target, branch], { stdio: 'inherit' });
    return;
  }

  execFileSync('git', ['worktree', 'add', target, '-b', branch, 'main'], { stdio: 'inherit' });
}

function runSetup(target) {
  execFileSync('npm', ['ci'], { cwd: target, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: target, stdio: 'inherit' });
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    fail(USAGE);
    return;
  }

  const worktrees = parseWorktreeList();
  const mainWorktree = resolveMainWorktree(worktrees);
  const receptacle = resolveReceptacle(mainWorktree);
  const branch = parsed.slug === undefined ? `issues/${parsed.issue}` : `issues/${parsed.issue}-${parsed.slug}`;
  const directoryName = parsed.slug === undefined ? `issues-${parsed.issue}` : `issues-${parsed.issue}-${parsed.slug}`;
  const target = resolve(receptacle, directoryName);

  if (existsSync(target)) {
    fail(`Target directory already exists: ${target}`);
    return;
  }

  const branchExists = gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const checkedOut = worktrees.find((worktree) => worktree.branch === branch);
  if (checkedOut !== undefined) {
    fail(`Branch ${branch} is already checked out at ${checkedOut.path}.`);
    return;
  }

  mkdirSync(receptacle, { recursive: true });
  addWorktree(target, branch, branchExists);

  if (parsed.noSetup || process.env.AMBERCAST_WT_SKIP_SETUP === '1') {
    console.log(`Created worktree: ${target}`);
    console.log(`Branch: ${branch}`);
    console.log(`Next: cd ${target}`);
    return;
  }

  try {
    runSetup(target);
  } catch (error) {
    fail(`Setup failed after creating ${target}: ${getErrorMessage(error)}`);
    console.error(`The worktree was kept. Re-run setup manually with: cd ${target} && npm ci && npm run build`);
    return;
  }

  console.log(`Created worktree: ${target}`);
  console.log(`Branch: ${branch}`);
  console.log(`Next: cd ${target}`);
}

try {
  main();
} catch (error) {
  fail(getErrorMessage(error));
}
