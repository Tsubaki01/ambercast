#!/usr/bin/env python3
"""PreToolUse hook (Bash): enforce the branch discipline of the /implement flow.

Blocks (exit 2):
- `git commit` / `git push` while the repository is on `main`
- `git commit` on any branch not named `issues/<N>` or `issues/<N>-<slug>`

Branch grammar: ASCII digits, slug words are lowercase alphanumerics joined
by single hyphens. Accepted: issues/12, issues/12-schema, issues/12-fix-login.
Rejected: issues/12-, issues/12--a, issues/12-A, unicode digits.

Everything else passes through (exit 0). Runs outside a work tree -> no-op.

Directory resolution deliberately selects the first available trusted
execution-context value (`data["cwd"]`, then `CLAUDE_PROJECT_DIR`, then the
hook process's own cwd); it never derives a directory from shell command text.
The hook still reads command text separately, elsewhere, to classify commit,
push, and branch-switch operations -- but no command shape, a `-C <path>` flag,
a leading `cd`, or anything else, changes which directory this resolution
picks. Parsing command text cannot safely reproduce the combined Git and shell
grammars, so using a command-derived path for resolution would create a bypass
surface.

This does mean resolution cannot recover once its selected value is itself
wrong. A missing directory, or one outside a Git worktree, is still observable:
the branch probe below fails and the hook fails open. A directory that is
merely the *wrong* checkout -- the main checkout, or another session's
still-existing linked worktree -- is not: it is indistinguishable from the
intended checkout using only execution-context signals, since both are real,
valid checkouts of this repository. In that situation the branch check below
runs against the wrong checkout, and a command's `-C` cannot correct it: `-C`
only changes where *git* itself acts, never which directory the guard
evaluates. That asymmetry cuts both ways -- it can produce a false-positive
block on a correctly-checked-out directory, and, inversely, it can let the
guard approve a command whose `-C` (or shell cwd) actually targets a different
checkout than the one just evaluated. The former is judged the safer failure
mode; closing the latter would require trusting command text.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def resolve_target_dir(data: dict) -> str:
    """Return the trusted hook directory and its established fallbacks."""
    return data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


# Subcommand detection: hyphen guards keep branch names like
# issues/6-fix-commit-msg from being mistaken for a `commit` subcommand.
def has_git_sub(text, names):
    """Detect a Git subcommand without matching hyphenated branch-name text."""
    return bool(re.search(rf"\bgit\b[^|;&]*?(?<!-)\b(?:{names})\b(?!-)", text))


def evaluate(command: str, data: dict) -> tuple[int, str] | None:
    """Return a branch-policy block for a commit or push command, if needed."""
    if not re.search(r"\bgit\b", command):
        return None

    is_commit = has_git_sub(command, "commit")
    is_push = has_git_sub(command, "push")
    if not (is_commit or is_push):
        return None

    # The branch is sampled BEFORE the command runs, so a compound command that
    # switches branches and then commits would be judged against the wrong
    # branch. Standalone switches (no commit/push in the command) pass through.
    if has_git_sub(command, "checkout|switch"):
        return (
            2,
            "BLOCKED: branch switching and commit/push in one command hides the "
            "real target branch from this guard. Run the switch first, then "
            "commit/push as a separate command.",
        )

    proj = resolve_target_dir(data)
    try:
        res = subprocess.run(
            ["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    branch = res.stdout.strip()

    if branch == "main":
        return (
            2,
            "BLOCKED: commits/pushes on main are forbidden. "
            "Start the /implement flow and work on an issues/<N> branch.",
        )

    if is_commit and not re.fullmatch(r"issues/[0-9]+(?:-[a-z0-9]+)*", branch):
        return (
            2,
            f"BLOCKED: branch '{branch}' does not match issues/<N> or issues/<N>-<slug>. "
            "The /implement flow requires one branch per GitHub issue "
            "(stack layers use the issues/<N>-<slug> form).",
        )

    return None


def main() -> int:
    """Apply branch enforcement to hook input and emit a block message if needed."""
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0

    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command", "")
    if not isinstance(command, str):
        return 0
    if "cwd" in data and not isinstance(data["cwd"], str):
        return 0

    result = evaluate(command, data)
    if result is None:
        return 0

    exit_code, message = result
    print(message, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
