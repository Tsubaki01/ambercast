#!/usr/bin/env node
// Removes an issue worktree only after preserving its implementation records.
// Git's worktree inventory is the authority for both target selection and the
// primary checkout that receives files copied back from a linked worktree.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ensureTargetLocked, fail, getErrorMessage, isSameOrDescendant, isStrictDescendant, listWorktrees, resolveCwdRealpath, resolveMainWorktree, resolveReceptacle, runGit } from './lib/worktree.mjs';

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

// This helper creates `<receptacle>/.cleanup-lock` without recursion. Only
// EEXIST signals competing or stale cleanup; that refusal names the mutex,
// prints any `transaction.json` it contains, and instructs the operator to
// verify that no cleanup is running before deleting the mutex manually. Other
// creation failures, including EACCES, propagate as their own errors rather
// than being misreported as competition. The successful acquirer is its sole
// owner, so rejected competitors never release another invocation's mutex. A
// surviving journal is operator evidence, not crash recovery, in this
// single-OS-user tool. SIGKILL and OS crashes cannot run recovery, so a
// surviving mutex or journal after either stop is fail-closed operator evidence,
// not a recovery bug.
function acquireCleanupMutex(receptacle) {
  const mutex = resolve(receptacle, '.cleanup-lock');
  try {
    mkdirSync(mutex);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }

    let journal = '';
    try {
      journal = `\ntransaction.json: ${readFileSync(resolve(mutex, 'transaction.json'), 'utf8')}`;
    } catch {}
    throw new Error(`Cleanup mutex already exists: ${mutex}. Verify that no cleanup is running before deleting it manually.${journal}`);
  }

  return mutex;
}

// Only an acquirer whose operation restores the target's lock state releases
// `<receptacle>/.cleanup-lock`. Degraded outcomes retain the mutex and journal
// as operator evidence, while a failed release is reported to stderr.
function releaseCleanupMutex(mutex) {
  rmSync(mutex, { recursive: true });
}

// Validation checks the main worktree before receptacle containment
// so its specific refusal stays meaningful even when the receptacle is absent.
// It then realpaths the registered target and requires strict, not same-or-below,
// containment beneath the real receptacle; accepting the receptacle itself
// would turn a boundary check into a deletion target.
function validateTarget(targetWorktree, mainWorktree, receptacle) {
  if (resolve(targetWorktree.path) === resolve(mainWorktree.path)) {
    throw new Error(`Refusing to remove the main worktree: ${mainWorktree.path}`);
  }

  let targetPath;
  try {
    targetPath = realpathSync(targetWorktree.path);
  } catch (error) {
    throw new Error(`Unable to realpath worktree ${targetWorktree.path}: ${getErrorMessage(error)}`);
  }

  let receptaclePath;
  try {
    receptaclePath = realpathSync(receptacle);
  } catch (error) {
    throw new Error(`Unable to realpath worktree receptacle ${receptacle}: ${getErrorMessage(error)}`);
  }

  if (!isStrictDescendant(receptaclePath, targetPath)) {
    throw new Error(`Worktree is outside the managed receptacle: ${targetWorktree.path}`);
  }

  return targetPath;
}

// Self-removal is refused after resolving the current directory so symlinked
// and nested invocations cannot delete the tree that executes this command.
function guardSelfRemoval(targetWorktree, mainWorktree, targetPath) {
  const cwd = resolveCwdRealpath();
  if (!cwd.ok) {
    throw new Error(`Refusing to remove ${targetWorktree.path}: unable to resolve the current directory: ${cwd.error.message}`);
  }

  if (isSameOrDescendant(targetPath, cwd.path)) {
    throw new Error(`Refusing to remove the worktree containing this command. Run from the main checkout: ${mainWorktree.path}`);
  }
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

// Dirtiness is evaluated before copy-back. A non-forced refusal must leave the
// primary checkout untouched, including its implementation records, instead of
// partially preserving a rejected tree.
function isDirty(worktreePath) {
  return runGit(['-C', worktreePath, 'status', '--porcelain']).trim() !== '';
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

// Refreshing the inventory under the mutex prevents stale target and lock data
// from defining a transaction. Once recovery is armed before the first
// mutation, one catch covers every synchronous failure through branch removal.
// It retains the mutex by default and releases it only after full success or a
// confirmed locked terminal state, so degraded outcomes remain operator
// evidence in this single-user tool with no automatic crash recovery.
function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    fail('worktree-remove', USAGE);
    return;
  }

  const preMutexWorktrees = listWorktrees();
  const mainPath = resolveMainWorktree(preMutexWorktrees);
  const receptacle = resolveReceptacle(mainPath);
  mkdirSync(receptacle, { recursive: true });
  const cleanupMutex = acquireCleanupMutex(receptacle);
  let releaseMutex = true;

  try {
    const worktrees = listWorktrees();
    const mainWorktree = { path: resolveMainWorktree(worktrees) };
    const targetWorktree = selectWorktree(parsed.target, worktrees);
    const targetPath = validateTarget(targetWorktree, mainWorktree, receptacle);
    guardSelfRemoval(targetWorktree, mainWorktree, targetPath);

    if (parsed.withBranch && targetWorktree.branch === undefined) {
      throw new Error(`Worktree ${targetWorktree.path} has no local branch to delete.`);
    }

    if (!parsed.force && isDirty(targetWorktree.path)) {
      throw new Error(`Worktree is dirty: ${targetWorktree.path}. Re-run with --force to remove it.`);
    }

    preserveIssueRecords(targetWorktree, mainWorktree);
    const originalLock = targetWorktree.locked;
    let phase = 'pre-unlock';
    const writeJournal = () => writeFileSync(resolve(cleanupMutex, 'transaction.json'), JSON.stringify({ target: targetWorktree.path, originalLock: originalLock ?? null, phase }));
    writeJournal();

    // Arm before the first mutation so an unlock or journal failure cannot
    // inherit the declaration-time releasable default by accident.
    releaseMutex = false;
    try {
      if (originalLock !== undefined) {
        runGit(['worktree', 'unlock', targetWorktree.path]);
      }
      phase = 'unlocked';
      writeJournal();

      removeWorktree(targetWorktree.path, parsed.force);

      phase = 'removed';
      writeJournal();
      if (parsed.withBranch && targetWorktree.branch !== undefined) {
        removeBranch(targetWorktree.branch, parsed.force);
      }

      console.log(`Removed worktree: ${targetWorktree.path}`);
      releaseMutex = true;
    } catch (primaryError) {
      // One catch preserves the primary failure while recovery classifies fresh
      // identity evidence instead of inferring a terminal state from its wording.
      const recovery = ensureTargetLocked({
        targetPath: targetWorktree.path,
        expectedBranch: targetWorktree.branch,
        originalLock,
      });
      releaseMutex = recovery.state === 'locked';

      if (recovery.state === 'locked') {
        phase = 'relocked';
        try {
          writeJournal();
        } catch (journalError) {
          // A confirmed lock remains releasable even when its journal update
          // fails, so both independent errors remain visible to the operator.
          throw new Error(`${getErrorMessage(primaryError)}; ${recovery.detail}; failed to update transaction journal: ${getErrorMessage(journalError)}`);
        }
      }

      // The primary command already identifies its failed subcommand, while
      // recovery contributes the only additional terminal-state context needed.
      throw new Error(`${getErrorMessage(primaryError)}; ${recovery.detail}.`);
    }
  } finally {
    if (releaseMutex) {
      try {
        releaseCleanupMutex(cleanupMutex);
      } catch (error) {
        console.error(`worktree-remove: Failed to release cleanup mutex ${cleanupMutex}: ${getErrorMessage(error)}`);
      }
    }
  }
}

try {
  main();
} catch (error) {
  fail('worktree-remove', getErrorMessage(error));
}
