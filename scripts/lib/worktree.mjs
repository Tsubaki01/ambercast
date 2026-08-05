import { execFileSync } from 'node:child_process';

// Both worktree commands must interpret Git's porcelain inventory in precisely
// the same way, so shared process and parsing behaviour lives in this module.
export function fail(toolName, message) {
  console.error(`${toolName}: ${message}`);
  process.exitCode = 1;
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

export function parseWorktreeList() {
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
