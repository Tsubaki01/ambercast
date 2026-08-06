#!/usr/bin/env python3
"""Tests for guard_git.py's command-target and branch resolution."""
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import patch

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

import guard_git  # noqa: E402


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


class ResolveTargetDirTest(unittest.TestCase):
    def test_input_cwd_beats_project_dir(self):
        with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": "/project"}, clear=False):
            self.assertEqual(
                guard_git.resolve_target_dir({"cwd": "/cwd"}),
                "/cwd",
            )

    def test_project_dir_and_process_cwd_remain_fallbacks(self):
        with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": "/project"}, clear=False):
            self.assertEqual(
                guard_git.resolve_target_dir({}), "/project"
            )
        with patch.dict(os.environ, {}, clear=True), patch(
            "guard_git.os.getcwd", return_value="/process-cwd"
        ):
            self.assertEqual(
                guard_git.resolve_target_dir({}), "/process-cwd"
            )


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.main = self.root / "main"
        self.worktree = self.root / "issue-58"
        init_repo(self.main, "main")
        git(self.main, "worktree", "add", "-q", "-b", "issues/58", str(self.worktree))

    def tearDown(self):
        self._tmp.cleanup()

    def evaluate(self, command: str, cwd: Optional[Path] = None):
        with patch.dict(
            os.environ, {"CLAUDE_PROJECT_DIR": str(self.main)}, clear=False
        ):
            return guard_git.evaluate(command, {"cwd": str(cwd or self.main)})

    def test_main_checkout_commit_is_still_blocked(self):
        result = self.evaluate("git commit -m message")
        self.assertIsNotNone(result)
        self.assertIn("commits/pushes on main", result[1])

    def test_compound_branch_switch_and_commit_is_still_blocked(self):
        result = self.evaluate("git switch issues/58 && git commit -m message")
        self.assertIsNotNone(result)
        self.assertIn("branch switching and commit/push", result[1])

    def test_non_commit_push_and_non_git_commands_still_pass_through(self):
        self.assertIsNone(self.evaluate("git status"))
        self.assertIsNone(self.evaluate("echo unchanged"))

    def test_explicit_linked_worktree_falls_back_to_main_and_is_blocked(self):
        result = self.evaluate(f"git -C {self.worktree} commit -m message")
        self.assertIsNotNone(result)
        self.assertIn("commits/pushes on main", result[1])

    def test_leading_cd_linked_worktree_falls_back_to_main_and_is_blocked(self):
        result = self.evaluate(f"cd {self.worktree} && git commit -m message")
        self.assertIsNotNone(result)
        self.assertIn("commits/pushes on main", result[1])

    def test_input_cwd_linked_worktree_is_allowed(self):
        self.assertIsNone(self.evaluate("git commit -m message", self.worktree))

    def test_commit_metadata_reuse_flag_does_not_override_main_directory(self):
        # `-C` after `commit` is that subcommand's reuse-message flag, not
        # Git's global directory option. It must therefore retain main's
        # branch protection.
        result = self.evaluate("git commit -C HEAD")
        self.assertIsNotNone(result)
        self.assertIn("commits/pushes on main", result[1])

    def test_malformed_input_cwd_branch_is_blocked(self):
        invalid = self.root / "invalid"
        init_repo(invalid, "not-an-issue-branch")
        result = self.evaluate("git commit -m message", invalid)
        self.assertIsNotNone(result)
        self.assertIn("does not match issues/<N>", result[1])

    def test_git_timeout_fails_open(self):
        with patch(
            "guard_git.subprocess.run",
            side_effect=subprocess.TimeoutExpired("git", 5),
        ) as run:
            self.assertIsNone(self.evaluate("git commit -m message"))
        self.assertEqual(run.call_args.kwargs["timeout"], 5)


class MainTest(unittest.TestCase):
    def test_non_object_stdin_fails_open(self):
        with patch("guard_git.sys.stdin", io.StringIO("[]")):
            self.assertEqual(guard_git.main(), 0)

    def test_non_object_tool_input_fails_open(self):
        with patch("guard_git.sys.stdin", io.StringIO('{"tool_input": []}')), patch(
            "guard_git.evaluate"
        ) as evaluate:
            self.assertEqual(guard_git.main(), 0)
        evaluate.assert_not_called()

    def test_non_string_command_fails_open(self):
        with patch(
            "guard_git.sys.stdin", io.StringIO('{"tool_input": {"command": []}}')
        ), patch("guard_git.evaluate") as evaluate:
            self.assertEqual(guard_git.main(), 0)
        evaluate.assert_not_called()

    def test_non_string_cwd_fails_open(self):
        with patch(
            "guard_git.sys.stdin",
            io.StringIO('{"tool_input": {"command": "git commit"}, "cwd": []}'),
        ), patch("guard_git.evaluate") as evaluate:
            self.assertEqual(guard_git.main(), 0)
        evaluate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
