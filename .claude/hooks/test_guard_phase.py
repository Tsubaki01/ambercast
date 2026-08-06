#!/usr/bin/env python3
"""Tests for guard_phase.py's worktree ownership and edit gates."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

import guard_phase  # noqa: E402


def git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def init_repo(path: Path, branch: str) -> None:
    subprocess.run(
        ["git", "init", "-q", "-b", branch, str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    git(path, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit",
        "-q", "--allow-empty", "-m", "initial")


def write_state(proj: Path, issue: str, content: str) -> None:
    state = proj / ".claude" / "impl" / f"issue-{issue}.state"
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(content, encoding="utf-8")


class LinkedWorktreeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.main = self.root / "main"
        self.worktree = self.root / "issue-58"
        init_repo(self.main, "main")
        git(self.main, "worktree", "add", "-q", "-b", "issues/58", str(self.worktree))

    def tearDown(self):
        self._tmp.cleanup()

    def test_linked_worktree_file_resolves_to_its_own_worktree(self):
        path = self.worktree / "src" / "example.ts"
        path.parent.mkdir()
        self.assertEqual(
            guard_phase.resolve_owning_worktree(str(path), str(self.main)),
            os.path.realpath(self.worktree),
        )

    def test_main_checkout_file_resolves_to_main_checkout(self):
        path = self.main / "src" / "example.ts"
        path.parent.mkdir()
        self.assertEqual(
            guard_phase.resolve_owning_worktree(str(path), str(self.main)),
            os.path.realpath(self.main),
        )

    def test_path_outside_known_worktrees_uses_anchor_unchanged(self):
        path = self.root / "outside" / "src" / "example.ts"
        self.assertEqual(
            guard_phase.resolve_owning_worktree(str(path), str(self.main)),
            str(self.main),
        )

    def test_symlink_alias_into_worktree_resolves_real_worktree_root(self):
        worktree_src = self.worktree / "src"
        worktree_src.mkdir()
        alias = self.root / "alias"
        os.symlink(worktree_src, alias)
        path = alias / "example.ts"
        self.assertEqual(
            guard_phase.resolve_owning_worktree(str(path), str(self.main)),
            os.path.realpath(self.worktree),
        )

    def test_symlinked_file_into_worktree_resolves_real_worktree_root(self):
        worktree_src = self.worktree / "src"
        worktree_src.mkdir()
        target = worktree_src / "example.ts"
        target.touch()
        alias = self.root / "example-link.ts"
        os.symlink(target, alias)
        self.assertEqual(
            guard_phase.resolve_owning_worktree(str(alias), str(self.main)),
            os.path.realpath(self.worktree),
        )

    def test_linked_worktree_uses_its_own_state_file(self):
        path = self.worktree / "src" / "example.ts"
        path.parent.mkdir()
        with patch.dict(
            os.environ, {"CLAUDE_PROJECT_DIR": str(self.main)}, clear=False
        ):
            blocked = guard_phase.evaluate(str(path), {})
            self.assertIsNotNone(blocked)
            self.assertIn("missing state file", blocked[1])

            write_state(self.worktree, "58", "step01_issue=done\n")
            blocked = guard_phase.evaluate(str(path), {})
            self.assertIsNotNone(blocked)
            self.assertIn("step05_plan_revised", blocked[1])

            write_state(self.worktree, "58", "step05_plan_revised=done\n")
            self.assertIsNone(guard_phase.evaluate(str(path), {}))


class ExistingGateBehaviorTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name) / "repo"
        init_repo(self.proj, "issues/73")

    def tearDown(self):
        self._tmp.cleanup()

    def evaluate(self, relative_path: str):
        with patch.dict(
            os.environ, {"CLAUDE_PROJECT_DIR": str(self.proj)}, clear=False
        ):
            return guard_phase.evaluate(str(self.proj / relative_path), {})

    def test_missing_state_file_blocks_source_edits(self):
        result = self.evaluate("src/example.ts")
        self.assertIsNotNone(result)
        self.assertIn("missing state file", result[1])

    def test_step05_gate_blocks_source_edits(self):
        write_state(self.proj, "73", "step01_issue=done\n")
        result = self.evaluate("src/example.ts")
        self.assertIsNotNone(result)
        self.assertIn("step05_plan_revised", result[1])

    def test_step08_gate_blocks_test_edits(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        result = self.evaluate("tests/example.test.ts")
        self.assertIsNotNone(result)
        self.assertIn("step08_docs_review", result[1])

    def test_rebase_detached_head_uses_head_name(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        sha = git(self.proj, "rev-parse", "HEAD").stdout.strip()
        git(self.proj, "checkout", "-q", "--detach", sha)
        gitdir = Path(git(self.proj, "rev-parse", "--absolute-git-dir").stdout.strip())
        rebase = gitdir / "rebase-merge"
        rebase.mkdir()
        (rebase / "head-name").write_text("refs/heads/issues/73\n", encoding="utf-8")
        self.assertIsNone(self.evaluate("src/example.ts"))

    def test_files_outside_source_and_tests_are_not_blocked(self):
        self.assertIsNone(self.evaluate("README.md"))


if __name__ == "__main__":
    unittest.main()
