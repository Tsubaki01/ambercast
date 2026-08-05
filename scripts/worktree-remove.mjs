#!/usr/bin/env node
// Removes an issue worktree only after preserving its implementation records.
// Git's worktree inventory is the authority for both target selection and the
// primary checkout that receives files copied back from a linked worktree.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fail, getErrorMessage, parseWorktreeList, runGit } from './lib/worktree.mjs';

const USAGE = 'Usage: node scripts/worktree-remove.mjs <issue-number|worktree-path> [--force] [--with-branch]';
const ISSUE_NUMBER = /^[1-9]\d*$/;

function parseArguments(args) {
  const [target, ...flags] = args;
  const validFlags = new Set(['--force', '--with-branch']);

  if (
    target === undefined
    || flags.some((flag) => !validFlags.has(flag))
    || new Set(flags).size !== flags.length
  ) {
    return undefined;
  }

  return {
    target,
    force: flags.includes('--force'),
    withBranch: flags.includes('--with-branch'),
  };
}

function selectWorktree(target, worktrees) {
  if (ISSUE_NUMBER.test(target)) {
    const issueBranch = new RegExp(`^issues/${target}(?:-[a-z0-9][a-z0-9-]*)?$`);
    const matches = worktrees.filter((worktree) => worktree.branch !== undefined && issueBranch.test(worktree.branch));

    if (matches.length === 0) {
      throw new Error(`No worktree matches issue ${target}.`);
    }

    if (matches.length > 1) {
      throw new Error(`Multiple worktrees match issue ${target}; provide an explicit path.`);
    }

    const [match] = matches;
    if (match === undefined) {
      throw new Error(`No worktree matches issue ${target}.`);
    }

    return match;
  }

  const requestedPath = resolve(target);
  const match = worktrees.find((worktree) => resolve(worktree.path) === requestedPath);

  if (match === undefined) {
    throw new Error(`No worktree matches path ${target}.`);
  }

  return match;
}

// Only ordinary files are copied. Ignoring symlinks prevents a worktree from
// turning record preservation into an unexpected read outside its own tree.
function copyMissingFiles(sourceDirectory, destinationDirectory, category, categoryRoot = sourceDirectory) {
  if (!existsSync(sourceDirectory)) {
    return;
  }

  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = resolve(sourceDirectory, entry.name);
    const destinationPath = resolve(destinationDirectory, entry.name);

    if (entry.isDirectory()) {
      copyMissingFiles(sourcePath, destinationPath, category, categoryRoot);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const recordName = relative(categoryRoot, sourcePath);
    if (existsSync(destinationPath)) {
      console.log(`Skipped existing ${category} file: ${recordName}`);
      continue;
    }

    mkdirSync(resolve(destinationPath, '..'), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    console.log(`Copied ${category} file: ${recordName}`);
  }
}

function preserveIssueRecords(worktree, mainWorktree) {
  copyMissingFiles(
    resolve(worktree.path, '.claude', 'logs'),
    resolve(mainWorktree.path, '.claude', 'logs'),
    'log',
  );
  copyMissingFiles(
    resolve(worktree.path, '.claude', 'todos'),
    resolve(mainWorktree.path, '.claude', 'todos'),
    'todo',
  );
}

function isDirty(worktreePath) {
  return runGit(['-C', worktreePath, 'status', '--porcelain']).trim() !== '';
}

function resolveCurrentWorktree() {
  return runGit(['rev-parse', '--show-toplevel']).trim();
}

function removeWorktree(worktreePath, force) {
  const args = ['worktree', 'remove'];
  if (force) {
    args.push('--force');
  }
  args.push(worktreePath);
  execFileSync('git', args, { stdio: 'inherit' });
}

function removeBranch(branch, force) {
  execFileSync('git', ['branch', force ? '-D' : '-d', branch], { stdio: 'inherit' });
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    fail('worktree-remove', USAGE);
    return;
  }

  const worktrees = parseWorktreeList();
  const [mainWorktree] = worktrees;
  if (mainWorktree === undefined) {
    throw new Error('Git did not report a main worktree.');
  }

  const targetWorktree = selectWorktree(parsed.target, worktrees);
  if (resolve(targetWorktree.path) === resolve(mainWorktree.path)) {
    fail('worktree-remove', `Refusing to remove the main worktree: ${mainWorktree.path}`);
    return;
  }

  if (resolve(targetWorktree.path) === resolve(resolveCurrentWorktree())) {
    fail('worktree-remove', `Refusing to remove the worktree containing this command. Run from the main checkout: ${mainWorktree.path}`);
    return;
  }

  if (parsed.withBranch && targetWorktree.branch === undefined) {
    fail('worktree-remove', `Worktree ${targetWorktree.path} has no local branch to delete.`);
    return;
  }

  if (!parsed.force && isDirty(targetWorktree.path)) {
    fail('worktree-remove', `Worktree is dirty: ${targetWorktree.path}. Re-run with --force to remove it.`);
    return;
  }

  preserveIssueRecords(targetWorktree, mainWorktree);
  removeWorktree(targetWorktree.path, parsed.force);

  if (parsed.withBranch && targetWorktree.branch !== undefined) {
    removeBranch(targetWorktree.branch, parsed.force);
  }

  console.log(`Removed worktree: ${targetWorktree.path}`);
}

try {
  main();
} catch (error) {
  fail('worktree-remove', getErrorMessage(error));
}
