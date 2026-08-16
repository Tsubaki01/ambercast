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
                ("/cwd", "data.cwd"),
            )

    def test_project_dir_and_process_cwd_remain_fallbacks(self):
        with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": "/project"}, clear=False):
            self.assertEqual(
                guard_git.resolve_target_dir({}),
                ("/project", "CLAUDE_PROJECT_DIR"),
            )
        with patch.dict(os.environ, {}, clear=True), patch(
            "guard_git.os.getcwd", return_value="/process-cwd"
        ):
            self.assertEqual(
                guard_git.resolve_target_dir({}),
                ("/process-cwd", "process cwd"),
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
        self.assertIn("Resolved directory", result[1])
        self.assertIn("data.cwd", result[1])
        self.assertIn("Observed branch: main", result[1])
        self.assertIn("Do not retry", result[1])

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

    def test_quoted_prompt_prose_is_not_a_git_invocation(self):
        self.assertIsNone(
            self.evaluate('codex exec "git commit should be reviewed"')
        )
        self.assertIsNone(self.evaluate("echo 'git commit'"))

    def test_quoted_git_binary_and_absolute_path_are_real_invocations(self):
        self.assertIsNotNone(self.evaluate('"git" commit -m x'))
        self.assertIsNotNone(self.evaluate("/usr/bin/git push"))

    def test_environment_prefixes_do_not_hide_git_commit(self):
        self.assertIsNotNone(self.evaluate("env X=1 git commit -m x"))
        self.assertIsNotNone(self.evaluate("X=1 git commit -m x"))
        self.assertIsNotNone(self.evaluate("env -i X=1 git commit -m x"))

    def test_common_shell_wrappers_do_not_hide_git_operations(self):
        for command in (
            "command git commit -m x",
            "sudo git commit -m x",
            "sudo -n git commit -m x",
            "command -p git commit -m x",
            "nice git commit -m x",
            "time git push",
            "time -p git push",
            "command env X=1 git commit -m x",
            "sudo env X=1 git commit -m x",
            "env X=1 command git commit -m x",
        ):
            with self.subTest(command=command):
                self.assertIsNotNone(self.evaluate(command))

    def test_path_qualified_prefixes_cannot_bypass_branch_enforcement(self):
        # Prefix recognition must follow executable basename semantics, just as
        # the Git executable recognizer does. Each of these previously reached
        # main as an unclassified non-Git command.
        for command in (
            "/usr/bin/env X=1 git commit -m x",
            "/usr/bin/sudo git commit -m x",
            "/usr/bin/time git push",
            '/bin/bash -lc "git commit -m x"',
        ):
            with self.subTest(command=command):
                result = self.evaluate(command)
                self.assertIsNotNone(result)
                self.assertEqual(result[0], 2)

    def test_prefixes_and_operator_runs_reset_command_position(self):
        # Prefix parsers can stop at a separator. That separator must return
        # classification to command position even when shlex groups it as a
        # punctuation run rather than a canonical shell operator token.
        for command in (
            "env ; git commit -m x",
            "true |& git commit -m x",
            "case x in y) ;; esac; git commit -m x",
            "X=1 ; /usr/bin/env git push",
        ):
            with self.subTest(command=command):
                result = self.evaluate(command)
                self.assertIsNotNone(result)
                self.assertEqual(result[0], 2)

    def test_command_separators_and_git_global_options_are_lexed(self):
        for separator in (";", "&&", "||", "|", "&", "\n"):
            with self.subTest(separator=separator):
                self.assertIsNotNone(
                    self.evaluate(f"echo ready {separator} git -C /tmp commit -m x")
                )
        self.assertIsNotNone(self.evaluate("git --git-dir=/tmp commit -m x"))
        self.assertIsNotNone(self.evaluate("git -c core.editor=true commit -m x"))

    def test_exec_and_complex_shell_forms_cannot_hide_git_operations(self):
        for command in (
            "exec git commit -m x",
            "exec -a disguised-git git commit -m x",
            '/bin/sh -c "git commit -m x"',
            'bash -lc "git commit -m x"',
            '(git commit -m x)',
            'if git commit -m x; then :; fi',
            'while git commit -m x; do break; done',
        ):
            with self.subTest(command=command):
                self.assertIsNotNone(self.evaluate(command))

    def test_ambiguous_shell_evaluation_with_git_is_blocked_on_main(self):
        self.assertIsNotNone(self.evaluate("sh -c 'git commit -m x'"))
        self.assertIsNotNone(self.evaluate('echo "$(git commit -m x)"'))
        self.assertIsNotNone(self.evaluate("echo `git commit -m x`"))
        self.assertIsNotNone(self.evaluate("eval 'git commit -m x'"))
        self.assertIsNotNone(self.evaluate("git commit '"))

    def test_ambiguous_shell_evaluation_is_blocked_on_issue_branches_too(self):
        for command in (
            "sh -c 'git commit -m x'",
            "bash -xec 'git switch main && git commit -m x'",
            "git commit -m 'message $(date)'",
            "if git status; then echo git; fi",
        ):
            with self.subTest(command=command):
                result = self.evaluate(command, self.worktree)
                self.assertIsNotNone(result)
                self.assertIn("too complex to statically classify", result[1])
                self.assertIn("simple, single-command form", result[1])

    def test_non_git_branch_name_text_is_not_an_operation(self):
        self.assertIsNone(self.evaluate("echo issues/6-fix-commit-msg"))

    def test_trusted_data_cwd_pins_the_known_false_negative_direction(self):
        # Resolution is deliberately based on hook input, not the `-C` target.
        # This linked worktree is valid, so its issue branch permits a command
        # that Git itself would direct back at main.
        self.assertIsNone(
            self.evaluate(f"git -C {self.main} commit -m message", self.worktree)
        )

    def _assert_ambiguous(self, command, cwd=None):
        result = self.evaluate(command, cwd)
        self.assertIsNotNone(result)
        self.assertIn("too complex to statically classify", result[1])
        self.assertIn("simple, single-command form", result[1])

    def test_xargs_routed_git_commit_is_blocked(self):
        self._assert_ambiguous("xargs git commit -m x")

    def test_find_exec_routed_git_commit_is_blocked(self):
        for command in (
            "find . -exec git commit -m x ;",
            "find . -execdir git commit -m x ;",
        ):
            with self.subTest(command=command):
                self._assert_ambiguous(command)

    def test_timeout_routed_git_commit_is_blocked(self):
        self._assert_ambiguous("timeout 5 git commit -m x")

    def test_opaque_wrapper_chains_with_transparent_prefixes_are_blocked(self):
        for command in (
            "sudo find -exec git commit -m x ;",
            "env X=1 xargs git commit -m x",
        ):
            with self.subTest(command=command):
                self._assert_ambiguous(command)

    def test_opaque_wrappers_without_a_bare_git_token_pass_through(self):
        # "git" reaches _contains_git's raw substring check either way, but
        # shlex collapses each quoted phrase into one token containing a
        # space, which never equals the bare `git` executable token these
        # wrappers are scanned for.
        for command in (
            'xargs echo "git commit"',
            'find -name "git commit"',
        ):
            with self.subTest(command=command):
                self.assertIsNone(self.evaluate(command))

    def test_nohup_is_a_transparent_wrapper(self):
        # nohup must be classified as an ordinary commit (routed through the
        # normal branch check), not folded into the opaque-wrapper ambiguous
        # path -- its wrapped command's position is never in question.
        result = self.evaluate("nohup git commit -m x")
        self.assertIsNotNone(result)
        self.assertIn("commits/pushes on main", result[1])
        self.assertNotIn("too complex to statically classify", result[1])
        self.assertIsNone(self.evaluate("nohup git status"))

    def test_quoted_operator_lookalike_option_value_does_not_hide_routed_git(self):
        # A quoted ";" used as xargs' -I replacement string is, after shlex
        # strips quoting, indistinguishable in content from a real shell
        # operator. The scan must not let that stop it before reaching git.
        self._assert_ambiguous('xargs -I ";" -- git commit -m x')

    def test_chained_opaque_wrappers_are_blocked(self):
        self._assert_ambiguous("xargs timeout 5 git commit -m x")

    def test_opaque_wrapper_scan_does_not_stop_at_shell_operators(self):
        # The scan runs to the end of the token stream rather than stopping
        # at the next operator, so an opaque wrapper's own, unrelated
        # command followed by a real, separately-triggered git commit is
        # still caught -- checked on both main (where every classification
        # blocks, so the distinction would otherwise be invisible) and a
        # valid issue branch (where a `commit=True` classification would
        # instead pass, so this is where the trade-off is actually visible).
        command = "xargs echo hello && git commit -m x"
        self._assert_ambiguous(command)
        self._assert_ambiguous(command, self.worktree)

    def test_opaque_wrapper_filename_argument_is_blocked(self):
        # Accepted cost: the scan cannot distinguish a `git`-named search
        # target from a routed invocation without the rejected positional
        # re-lex, so a literal filename search is also blocked.
        self._assert_ambiguous("find . -name git")

    def test_opaque_wrapper_path_qualified_prefixes_cannot_bypass_detection(self):
        # Mirrors test_path_qualified_prefixes_cannot_bypass_branch_enforcement:
        # both the wrapper name and the routed git executable must be
        # recognized through a path prefix, not just a bare basename, since
        # OPAQUE_WRAPPER_COMMANDS membership and _is_git_executable both
        # normalize via _executable_basename.
        for command in (
            "/usr/bin/xargs git commit -m x",
            "xargs /usr/bin/git commit -m x",
        ):
            with self.subTest(command=command):
                self._assert_ambiguous(command)


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
