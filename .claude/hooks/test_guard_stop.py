#!/usr/bin/env python3
"""Tests for guard_stop.py (Stop hook: keep the /implement flow moving).

Run from the repository root:
    python3 -m unittest discover -s .claude/hooks -p "test_*.py" -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

import guard_stop  # noqa: E402

ALL_DONE = "".join(f"{key}=done\n" for key, _ in guard_stop.STEPS)

ISSUE13_PARTIAL = (
    "issue=13\n"
    "branch=issues/13-ir-schema\n"
    "layers=ir-schema,ir-determinism\n"
    + "".join(f"{key}=done\n" for key, _ in guard_stop.STEPS[:9])
)


def write_state(proj: Path, issue: str, content: str) -> Path:
    impl = proj / ".claude" / "impl"
    impl.mkdir(parents=True, exist_ok=True)
    state = impl / f"issue-{issue}.state"
    state.write_text(content, encoding="utf-8")
    return state


class IssueFromBranchTest(unittest.TestCase):
    def test_plain_issue_branch(self):
        self.assertEqual(guard_stop.issue_from_branch("issues/13"), "13")

    def test_stack_layer_branch(self):
        self.assertEqual(guard_stop.issue_from_branch("issues/13-ir-schema"), "13")

    def test_multi_word_slug(self):
        self.assertEqual(guard_stop.issue_from_branch("issues/12-fix-login"), "12")

    def test_main_is_not_an_issue_branch(self):
        self.assertIsNone(guard_stop.issue_from_branch("main"))

    def test_trailing_hyphen_rejected(self):
        self.assertIsNone(guard_stop.issue_from_branch("issues/12-"))

    def test_double_hyphen_rejected(self):
        self.assertIsNone(guard_stop.issue_from_branch("issues/12--a"))

    def test_uppercase_slug_rejected(self):
        self.assertIsNone(guard_stop.issue_from_branch("issues/12-A"))


class StepQueriesTest(unittest.TestCase):
    def test_empty_state_starts_at_step01(self):
        key, _ = guard_stop.first_incomplete("issue=13\n")
        self.assertEqual(key, "step01_issue")

    def test_partial_state_points_at_next_step(self):
        key, _ = guard_stop.first_incomplete(ISSUE13_PARTIAL)
        self.assertEqual(key, "step10_tests_review")

    def test_all_done_returns_none(self):
        self.assertIsNone(guard_stop.first_incomplete(ALL_DONE))

    def test_gap_returns_first_missing_step(self):
        state = "step01_issue=done\nstep02_branch=done\nstep04_plan_review=done\n"
        key, _ = guard_stop.first_incomplete(state)
        self.assertEqual(key, "step03_plan")

    def test_done_requires_exact_lowercase_value(self):
        self.assertIsNone(guard_stop.first_incomplete(ALL_DONE))
        state = ALL_DONE.replace("step09_tests=done", "step09_tests=DONE")
        key, _ = guard_stop.first_incomplete(state)
        self.assertEqual(key, "step09_tests")

    def test_trailing_whitespace_tolerated(self):
        state = "step01_issue=done   \n"
        key, _ = guard_stop.first_incomplete(state)
        self.assertEqual(key, "step02_branch")

    def test_last_completed_with_gap(self):
        state = "step01_issue=done\nstep04_plan_review=done\n"
        self.assertEqual(guard_stop.last_completed(state), "step04_plan_review")

    def test_last_completed_empty(self):
        self.assertIsNone(guard_stop.last_completed("issue=13\n"))

    def test_paused_detection(self):
        self.assertTrue(guard_stop.is_paused("issue=13\npaused=true\n"))
        self.assertFalse(guard_stop.is_paused("issue=13\npaused=false\n"))
        self.assertFalse(guard_stop.is_paused("issue=13\n"))


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_non_issue_branch_allows_stop(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "main"))

    def test_missing_state_file_allows_stop(self):
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

    def test_paused_allows_stop(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL + "paused=true\n")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

    def test_all_done_allows_stop_and_removes_sidecar(self):
        write_state(self.proj, "13", ALL_DONE)
        side = Path(guard_stop.sidecar_path(str(self.proj), "13"))
        side.write_text("{}", encoding="utf-8")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertFalse(side.exists())

    def test_incomplete_state_blocks_with_next_step(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        payload = guard_stop.evaluate(str(self.proj), "issues/13-ir-schema")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["decision"], "block")
        self.assertIn("issue 13", payload["reason"])
        self.assertIn("step10_tests_review", payload["reason"])
        self.assertIn("step09_tests", payload["reason"])
        self.assertIn("SKILL.md", payload["reason"])
        self.assertIn("paused=true", payload["reason"])

    def test_stall_counter_blocks_three_times_then_allows(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        for expected_blocks in (1, 2, 3):
            payload = guard_stop.evaluate(str(self.proj), branch)
            self.assertIsNotNone(payload, f"block #{expected_blocks} expected")
            side = json.loads(
                Path(guard_stop.sidecar_path(str(self.proj), "13")).read_text()
            )
            self.assertEqual(side["consecutive_blocks"], expected_blocks)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        # Still stalled: later stops keep passing through until progress resumes.
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))

    def test_progress_resets_the_stall_counter(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        write_state(self.proj, "13", ISSUE13_PARTIAL + "step10_tests_review=done\n")
        payload = guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNotNone(payload)
        self.assertIn("step11_code", payload["reason"])
        side = json.loads(
            Path(guard_stop.sidecar_path(str(self.proj), "13")).read_text()
        )
        self.assertEqual(side["consecutive_blocks"], 1)

    def test_todo_file_change_counts_as_progress(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        todos = self.proj / ".claude" / "todos"
        todos.mkdir(parents=True)
        todo = todos / "issue-13-ir-schema.md"
        todo.write_text("- [ ] L6. implement schema.ts\n", encoding="utf-8")
        branch = "issues/13"
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        todo.write_text("- [x] L6. implement schema.ts\n", encoding="utf-8")
        payload = guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNotNone(payload)

    def test_corrupted_sidecar_is_rebuilt(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        side = Path(guard_stop.sidecar_path(str(self.proj), "13"))
        side.parent.mkdir(parents=True, exist_ok=True)
        side.write_text("not json", encoding="utf-8")
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertEqual(json.loads(side.read_text())["consecutive_blocks"], 1)


class EndToEndTest(unittest.TestCase):
    """Run the hook as Claude Code does: a subprocess fed JSON on stdin."""

    HOOK = str(HOOKS_DIR / "guard_stop.py")

    def _git_repo(self, branch: str) -> tempfile.TemporaryDirectory:
        tmp = tempfile.TemporaryDirectory()
        subprocess.run(
            ["git", "init", "-q", "-b", branch, tmp.name],
            check=True, capture_output=True,
        )
        return tmp

    def _run_hook(self, stdin: str, env_extra: dict) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, self.HOOK],
            input=stdin, env=env, capture_output=True, text=True, timeout=30,
        )

    def test_invalid_stdin_exits_zero_silently(self):
        res = self._run_hook("not json", {})
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_kill_switch_disables_the_guard(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop"}),
                {"CLAUDE_PROJECT_DIR": proj, "AMBERCAST_GUARD_STOP": "0"},
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_incomplete_flow_blocks_via_stdout_json(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop"}),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(res.returncode, 0)
            payload = json.loads(res.stdout)
            self.assertEqual(payload["decision"], "block")
            self.assertIn("step02_branch", payload["reason"])
            side = Path(guard_stop.sidecar_path(proj, "7"))
            self.assertTrue(side.exists())

    def test_non_issue_branch_passes_through(self):
        with self._git_repo("main") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop"}),
                {"CLAUDE_PROJECT_DIR": proj},
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_cwd_from_input_when_project_dir_unset(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop", "cwd": proj}), {}
            )
            self.assertEqual(res.returncode, 0)
            payload = json.loads(res.stdout)
            self.assertEqual(payload["decision"], "block")

    def test_non_git_directory_passes_through(self):
        with tempfile.TemporaryDirectory() as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop", "cwd": proj}), {}
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
