#!/usr/bin/env python3
"""Tests for guard_phase.py's worktree ownership and edit gates."""
import io
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

    def test_worktree_resolution_timeout_uses_anchor(self):
        path = self.worktree / "src" / "example.ts"
        with patch(
            "guard_phase.subprocess.run",
            side_effect=subprocess.TimeoutExpired("git", 5),
        ) as run:
            self.assertEqual(
                guard_phase.resolve_owning_worktree(str(path), str(self.main)),
                str(self.main),
            )
        self.assertEqual(run.call_args.kwargs["timeout"], 5)

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

    def test_singular_test_helpers_and_fixtures_follow_step08_gate(self):
        paths = ("test/helpers/browser.ts", "test/fixtures/session.json")
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        for path in paths:
            with self.subTest(path=path, phase="before-step08"):
                result = self.evaluate(path)
                self.assertIsNotNone(result)
                self.assertIn("step08_docs_review", result[1])

        write_state(
            self.proj,
            "73",
            "step05_plan_revised=done\nstep08_docs_review=done\n",
        )
        for path in paths:
            with self.subTest(path=path, phase="after-step08"):
                self.assertIsNone(self.evaluate(path))

    def test_rebase_detached_head_uses_head_name(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        sha = git(self.proj, "rev-parse", "HEAD").stdout.strip()
        git(self.proj, "checkout", "-q", "--detach", sha)
        gitdir = Path(git(self.proj, "rev-parse", "--absolute-git-dir").stdout.strip())
        rebase = gitdir / "rebase-merge"
        rebase.mkdir()
        (rebase / "head-name").write_text("refs/heads/issues/73\n", encoding="utf-8")
        self.assertIsNone(self.evaluate("src/example.ts"))

    def test_real_detached_head_without_rebase_metadata_blocks(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        sha = git(self.proj, "rev-parse", "HEAD").stdout.strip()
        git(self.proj, "checkout", "-q", "--detach", sha)

        blocked = self.evaluate("src/example.ts")

        self.assertIsNotNone(blocked)
        self.assertIn("detached HEAD outside a rebase", blocked[1])

    def test_symbolic_ref_uses_exact_argv_and_nonempty_attached_branch(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        expected = [
            "git", "-C", str(self.proj), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        runs = [
            subprocess.CompletedProcess([], 0, ".git\n", ""),
            subprocess.CompletedProcess(expected, 0, "issues/73\n", ""),
        ]
        with patch(
            "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
        ), patch("guard_phase.subprocess.run", side_effect=runs) as run:
            self.assertIsNone(guard_phase.evaluate(str(path), {}))

        self.assertEqual(run.call_args_list[1].args[0], expected)
        self.assertEqual(len(run.call_args_list), 2)

    def test_only_rc1_with_empty_stdout_enters_detached_rebase_recovery(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        gitdir = Path(git(self.proj, "rev-parse", "--absolute-git-dir").stdout.strip())
        rebase = gitdir / "rebase-merge"
        rebase.mkdir()
        (rebase / "head-name").write_text("refs/heads/issues/73\n", encoding="utf-8")
        expected = [
            "git", "-C", str(self.proj), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        runs = [
            subprocess.CompletedProcess([], 0, ".git\n", ""),
            subprocess.CompletedProcess(expected, 1, "", ""),
            subprocess.CompletedProcess([], 0, str(gitdir), ""),
        ]
        with patch(
            "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
        ), patch("guard_phase.subprocess.run", side_effect=runs) as run:
            self.assertIsNone(guard_phase.evaluate(str(path), {}))

        self.assertEqual(run.call_args_list[1].args[0], expected)
        self.assertEqual(len(run.call_args_list), 3)

    def test_invalid_symbolic_ref_outcomes_fail_open_without_detached_recovery(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        expected = [
            "git", "-C", str(self.proj), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        cases = [
            subprocess.CompletedProcess(expected, 0, "", ""),
            subprocess.CompletedProcess(expected, 1, "issues/73\n", ""),
            subprocess.CompletedProcess(expected, 2, "", ""),
            subprocess.TimeoutExpired(expected, 5),
            OSError("git unavailable"),
        ]
        for outcome in cases:
            with self.subTest(outcome=type(outcome).__name__, value=outcome):
                runs = [subprocess.CompletedProcess([], 0, ".git\n", ""), outcome]
                if isinstance(outcome, subprocess.CompletedProcess) and outcome.returncode:
                    runs.append(subprocess.CompletedProcess([], 0, str(self.proj / ".git"), ""))
                with patch(
                    "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
                ), patch("guard_phase.subprocess.run", side_effect=runs) as run:
                    blocked = guard_phase.evaluate(str(path), {})

                self.assertIsNone(blocked)
                self.assertEqual(run.call_args_list[1].args[0], expected)
                self.assertEqual(len(run.call_args_list), 2)

    def test_required_git_dir_probe_failures_fail_open_with_exact_argv(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        expected = ["git", "-C", str(self.proj), "rev-parse", "--git-dir"]
        fallback = subprocess.CompletedProcess([], 0, "issues/73\n", "")
        outcomes = [
            subprocess.CompletedProcess(expected, 0, "", ""),
            subprocess.CompletedProcess(expected, 2, ".git\n", ""),
            subprocess.TimeoutExpired(expected, 5),
            OSError("git unavailable"),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__, value=outcome):
                with patch(
                    "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
                ), patch(
                    "guard_phase.subprocess.run", side_effect=[outcome, fallback]
                ) as run:
                    self.assertIsNone(guard_phase.evaluate(str(path), {}))
                self.assertEqual(run.call_args_list[0].args[0], expected)
                self.assertEqual(run.call_args_list[0].kwargs["timeout"], 5)
                self.assertEqual(len(run.call_args_list), 1)

    def test_required_absolute_git_dir_failures_fail_open_with_exact_argv(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        branch_argv = [
            "git", "-C", str(self.proj), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        expected = [
            "git", "-C", str(self.proj), "rev-parse", "--absolute-git-dir",
        ]
        prefix = [
            subprocess.CompletedProcess([], 0, ".git\n", ""),
            subprocess.CompletedProcess(branch_argv, 1, "", ""),
        ]
        outcomes = [
            subprocess.CompletedProcess(expected, 0, "", ""),
            subprocess.CompletedProcess(expected, 2, ".git\n", ""),
            subprocess.TimeoutExpired(expected, 5),
            OSError("git unavailable"),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__, value=outcome):
                with patch(
                    "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
                ), patch(
                    "guard_phase.subprocess.run", side_effect=[*prefix, outcome]
                ) as run:
                    self.assertIsNone(guard_phase.evaluate(str(path), {}))
                self.assertEqual(run.call_args_list[2].args[0], expected)
                self.assertEqual(run.call_args_list[2].kwargs["timeout"], 5)
                self.assertEqual(len(run.call_args_list), 3)

    def test_invalid_absolute_git_dir_fails_open_without_head_name_lookup(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        path = self.proj / "src" / "example.ts"
        git_dir_argv = ["git", "-C", str(self.proj), "rev-parse", "--git-dir"]
        branch_argv = [
            "git", "-C", str(self.proj), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        absolute_git_dir_argv = [
            "git", "-C", str(self.proj), "rev-parse", "--absolute-git-dir",
        ]
        runs = [
            subprocess.CompletedProcess(git_dir_argv, 0, ".git\n", ""),
            subprocess.CompletedProcess(branch_argv, 1, "", ""),
            subprocess.CompletedProcess(absolute_git_dir_argv, 1, "", ""),
        ]
        with patch(
            "guard_phase.resolve_owning_worktree", return_value=str(self.proj)
        ), patch("guard_phase.subprocess.run", side_effect=runs) as run, patch(
            "builtins.open", wraps=open
        ) as file_open:
            blocked = guard_phase.evaluate(str(path), {})

        self.assertIsNone(blocked)
        self.assertEqual(run.call_args_list[2].args[0], absolute_git_dir_argv)
        self.assertFalse(
            any(
                call.args and str(call.args[0]).endswith("head-name")
                for call in file_open.call_args_list
            )
        )
        for call in run.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 5)

    def test_files_outside_source_and_tests_are_not_blocked(self):
        self.assertIsNone(self.evaluate("README.md"))

    def test_git_timeout_allows_source_edit_at_shared_fail_open_boundary(self):
        write_state(self.proj, "73", "step05_plan_revised=done\n")
        with patch(
            "guard_phase.subprocess.run",
            side_effect=subprocess.TimeoutExpired("git", 5),
        ) as run:
            self.assertIsNone(self.evaluate("src/example.ts"))
        for call in run.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 5)


class MainTest(unittest.TestCase):
    def test_non_object_stdin_fails_open(self):
        with patch("guard_phase.sys.stdin", io.StringIO("[]")):
            self.assertEqual(guard_phase.main(), 0)

    def test_non_object_tool_input_fails_open(self):
        with patch("guard_phase.sys.stdin", io.StringIO('{"tool_input": []}')), patch(
            "guard_phase.evaluate"
        ) as evaluate:
            self.assertEqual(guard_phase.main(), 0)
        evaluate.assert_not_called()

    def test_non_string_path_fails_open(self):
        with patch(
            "guard_phase.sys.stdin", io.StringIO('{"tool_input": {"file_path": []}}')
        ), patch("guard_phase.evaluate") as evaluate:
            self.assertEqual(guard_phase.main(), 0)
        evaluate.assert_not_called()

    def test_empty_path_fails_open(self):
        with patch(
            "guard_phase.sys.stdin", io.StringIO('{"tool_input": {}}')
        ), patch("guard_phase.evaluate") as evaluate:
            self.assertEqual(guard_phase.main(), 0)
        evaluate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
