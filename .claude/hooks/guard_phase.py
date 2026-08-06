#!/usr/bin/env python3
"""PreToolUse hook (Write/Edit): gate source and test edits on /implement progress.

Rules (exit 2 blocks the edit):
- src/, bin/, or test files may only be edited on an `issues/<N>` branch or
  a stack layer `issues/<N>-<slug>` (same grammar as guard_git.py; all
  layers of an issue share the issue's state file). During a rebase
  (detached HEAD) the original branch is resolved from .git/rebase-*/head-name
- the branch's state file `.claude/impl/issue-<N>.state` must exist
- src/ and test edits require `step05_plan_revised=done` (plan reviewed & revised)
- test edits additionally require `step08_docs_review=done` (docs-first reviewed)

Files outside src/ and tests are never blocked.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def resolve_owning_worktree(path: str, anchor_proj: str) -> str:
    """Return Git's worktree root for an edited path, or the session anchor.

    Git owns both worktree membership and symlink resolution, so asking it
    from the edited file's directory avoids reproducing either concern in the
    hook. A path outside every working tree retains the existing anchor and
    therefore preserves the ordinary non-worktree behavior.
    """
    directory = os.path.dirname(os.path.realpath(path))
    try:
        result = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
        )
    except OSError:
        return anchor_proj
    root = result.stdout.strip()
    return root if result.returncode == 0 and root else anchor_proj


def evaluate(path: str, data: dict) -> tuple[int, str] | None:
    anchor_proj = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    proj = resolve_owning_worktree(path, anchor_proj)
    try:
        # Git reports its physical worktree root, including when the edit came
        # through a symlink alias. Compare the path in that same spelling so
        # the existing outside-project bailout remains an ownership check.
        rel = os.path.relpath(os.path.realpath(path), os.path.realpath(proj))
    except ValueError:
        return None
    if rel.startswith(".."):
        return None

    in_src = rel.startswith("src" + os.sep) or rel.startswith("bin" + os.sep)
    in_tests = rel.startswith("tests" + os.sep) or bool(
        re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", rel)
    )
    if not (in_src or in_tests):
        return None

    if subprocess.run(
        ["git", "-C", proj, "rev-parse", "--git-dir"],
        capture_output=True, text=True,
    ).returncode != 0:
        return None

    res = subprocess.run(
        ["git", "-C", proj, "symbolic-ref", "--short", "HEAD"],
        capture_output=True, text=True,
    )
    if res.returncode == 0:
        branch = res.stdout.strip()
    else:
        # Detached HEAD. Mid-rebase (gh stack rebase/sync) the flow is still on
        # a stack layer — recover the branch being rebased; otherwise block.
        # Resolve the git dir through git itself: in linked worktrees .git is a
        # file and rebase metadata lives in the worktree-specific git dir.
        gitdir = subprocess.run(
            ["git", "-C", proj, "rev-parse", "--absolute-git-dir"],
            capture_output=True, text=True,
        ).stdout.strip()
        branch = ""
        for d in ("rebase-merge", "rebase-apply"):
            try:
                with open(os.path.join(gitdir, d, "head-name"), encoding="utf-8") as f:
                    branch = f.read().strip().removeprefix("refs/heads/")
                break
            except OSError:
                continue
        if not branch:
            return (
                2,
                "BLOCKED: detached HEAD outside a rebase — source/test edits are "
                "only allowed on an issues/<N> branch. See /implement.",
            )

    m = re.fullmatch(r"issues/([0-9]+)(?:-[a-z0-9]+)*", branch)
    if not m:
        return (
            2,
            f"BLOCKED: source/test edits are only allowed on an issues/<N> branch "
            f"or a stack layer issues/<N>-<slug> (current: {branch}). "
            "Start the /implement flow.",
        )

    state_path = os.path.join(proj, ".claude", "impl", f"issue-{m.group(1)}.state")
    try:
        with open(state_path, encoding="utf-8") as f:
            state = f.read()
    except FileNotFoundError:
        return (
            2,
            f"BLOCKED: missing state file {state_path}. "
            "Run /implement steps 1-5 before editing source.",
        )

    def done(key: str) -> bool:
        return bool(re.search(rf"^{key}=done\s*$", state, re.M))

    if not done("step05_plan_revised"):
        return (
            2,
            "BLOCKED: plan review not complete (step05_plan_revised). "
            "Finish /implement steps 3-5 before touching src or tests.",
        )

    if in_tests and not done("step08_docs_review"):
        return (
            2,
            "BLOCKED: docs review not complete (step08_docs_review). "
            "Tests are written at step 9, after the docs-first review.",
        )

    return None


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    ti = data.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    result = evaluate(path, data)
    if result is None:
        return 0

    exit_code, message = result
    print(message, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
