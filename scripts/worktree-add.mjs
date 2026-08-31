#!/usr/bin/env node
// Creates an isolated issue worktree without depending on one developer's
// checkout location. Git remains the authority for branch and worktree state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, formatLockReason, getErrorMessage, listWorktrees, resolveMainWorktree, resolveReceptacle, runGit } from './lib/worktree.mjs';

const USAGE = 'Usage: node scripts/worktree-add.mjs <issue-number> [slug] [--no-setup] [--owner <name>]';
const ISSUE_NUMBER = /^[1-9]\d*$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

function gitSucceeds(args) {
  try {
    runGit(args);
    return true;
  } catch {
    return false;
  }
}

// The parser accepts ownership metadata only when it has one unambiguous,
// non-flag value, defaulting an omitted owner to `unassigned`. Validation stays
// in the shared lock-reason formatter so every reason has the same grammar.
function parseArguments(args) {
  const positionals = [];
  let noSetup = false;
  let owner;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--no-setup') {
      if (noSetup) {
        return undefined;
      }

      noSetup = true;
      continue;
    }

    if (argument === '--owner') {
      if (owner !== undefined) {
        return undefined;
      }

      owner = args[index + 1];
      if (owner === undefined || owner.startsWith('--')) {
        return undefined;
      }

      index += 1;
      continue;
    }

    if (argument.startsWith('--')) {
      return undefined;
    }

    positionals.push(argument);
  }

  const [issue, slug, ...extra] = positionals;
  if (
    extra.length > 0
    || issue === undefined
    || !ISSUE_NUMBER.test(issue)
    || (slug !== undefined && !SLUG.test(slug))
  ) {
    return undefined;
  }

  if (owner !== undefined) {
    try {
      formatLockReason(issue, owner, '');
    } catch {
      return undefined;
    }
  }

  return { issue, slug, noSetup, owner };
}

// Branch creation remains a small boundary around Git because its two forms
// differ only in whether a pre-existing issue branch is attached or created
// from main; later lifecycle safety must not infer that state from the path.
function addWorktree(target, branch, branchExists) {
  if (branchExists) {
    execFileSync('git', ['worktree', 'add', target, branch], { stdio: 'inherit' });
    return;
  }

  execFileSync('git', ['worktree', 'add', target, '-b', branch, 'main'], { stdio: 'inherit' });
}

// Setup is intentionally separate from creation and locking. The main flow
// runs it only after Git records the worktree lock, so an agent cannot be
// assigned to a setup-failed worktree that is left movable by an earlier step.
function runSetup(target) {
  execFileSync('npm', ['ci'], { cwd: target, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: target, stdio: 'inherit' });
}

// A lock failure leaves the registered tree available only for controlled
// cleanup and prevents setup. Success output is delayed until setup completes,
// except when setup is explicitly skipped, so failed setup never resembles a
// ready-to-assign worktree.
function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed === undefined) {
    fail('worktree-add', USAGE);
    return;
  }

  const worktrees = listWorktrees();
  const mainWorktree = resolveMainWorktree(worktrees);
  const receptacle = resolveReceptacle(mainWorktree);
  const branch = parsed.slug === undefined ? `issues/${parsed.issue}` : `issues/${parsed.issue}-${parsed.slug}`;
  const directoryName = parsed.slug === undefined ? `issues-${parsed.issue}` : `issues-${parsed.issue}-${parsed.slug}`;
  const target = resolve(receptacle, directoryName);

  if (existsSync(target)) {
    fail('worktree-add', `Target directory already exists: ${target}`);
    return;
  }

  const branchExists = gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const checkedOut = worktrees.find((worktree) => worktree.branch === branch);
  if (checkedOut !== undefined) {
    fail('worktree-add', `Branch ${branch} is already checked out at ${checkedOut.path}.`);
    return;
  }

  mkdirSync(receptacle, { recursive: true });
  addWorktree(target, branch, branchExists);

  const lockReason = formatLockReason(parsed.issue, parsed.owner ?? 'unassigned', new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  try {
    runGit(['worktree', 'lock', '--reason', lockReason, target]);
  } catch (error) {
    fail('worktree-add', `lock failed — do NOT assign an agent to this worktree: ${getErrorMessage(error)}`);
    return;
  }

  if (parsed.noSetup || process.env.AMBERCAST_WT_SKIP_SETUP === '1') {
    console.log(`Created worktree: ${target}`);
    console.log(`Branch: ${branch}`);
    console.log(`Locked: ${lockReason}`);
    console.log(`Next: cd ${target}`);
    return;
  }

  try {
    runSetup(target);
  } catch (error) {
    fail('worktree-add', `Setup failed after creating ${target}: ${getErrorMessage(error)}`);
    console.error(`The worktree was kept. Re-run setup manually with: cd ${target} && npm ci && npm run build`);
    return;
  }

  console.log(`Created worktree: ${target}`);
  console.log(`Branch: ${branch}`);
  console.log(`Locked: ${lockReason}`);
  console.log(`Next: cd ${target}`);
}

try {
  main();
} catch (error) {
  fail('worktree-add', getErrorMessage(error));
}
