#!/usr/bin/env python3
"""Tests for guard_stop.py (Stop hook: keep the /implement flow moving).

Run from the repository root:
    python3 -m unittest discover -s .claude/hooks -p "test_*.py" -v
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_last_completed_is_contiguous_prefix_end(self):
        # A gap must not report a later step as "last completed": that would
        # contradict the "next step" guidance in the block reason.
        state = "step01_issue=done\nstep04_plan_review=done\n"
        self.assertEqual(guard_stop.last_completed(state), "step01_issue")

    def test_last_completed_full_prefix(self):
        self.assertEqual(
            guard_stop.last_completed(ISSUE13_PARTIAL), "step09_tests"
        )

    def test_last_completed_empty(self):
        self.assertIsNone(guard_stop.last_completed("issue=13\n"))

    def test_paused_detection(self):
        self.assertTrue(guard_stop.is_paused("issue=13\npaused=true\n"))
        self.assertFalse(guard_stop.is_paused("issue=13\npaused=false\n"))
        self.assertFalse(guard_stop.is_paused("issue=13\n"))


class CurrentBranchProbeTest(unittest.TestCase):
    def setUp(self):
        self.root = "/tmp/ambercast-symbolic-root"
        self.expected = [
            "git", "-C", self.root, "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]

    def probe(self, outcome):
        if isinstance(outcome, BaseException):
            side_effect = outcome
            return_value = None
        else:
            side_effect = None
            return_value = outcome
        with patch(
            "guard_stop.subprocess.run",
            side_effect=side_effect,
            return_value=return_value,
        ) as run:
            branch = guard_stop.current_branch(self.root)
        run.assert_called_once_with(self.expected, capture_output=True, timeout=5)
        return branch

    def test_rc0_requires_a_nonempty_branch(self):
        attached = subprocess.CompletedProcess(self.expected, 0, b"issues/13\n", b"")
        empty = subprocess.CompletedProcess(self.expected, 0, b"", b"")
        self.assertEqual(self.probe(attached), "issues/13")
        self.assertIsNone(self.probe(empty))

    def test_rc1_with_empty_stdout_is_the_only_detached_outcome(self):
        detached = subprocess.CompletedProcess(self.expected, 1, b"", b"")
        self.assertIsNone(self.probe(detached))

    def test_every_other_rc_exception_or_nonempty_failure_has_no_branch(self):
        outcomes = [
            subprocess.CompletedProcess(self.expected, 1, b"issues/13\n", b""),
            subprocess.CompletedProcess(self.expected, 2, b"", b""),
            subprocess.CompletedProcess(self.expected, 128, b"main\n", b""),
            subprocess.TimeoutExpired(self.expected, 5),
            OSError("git unavailable"),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__, value=outcome):
                self.assertIsNone(self.probe(outcome))


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)

    def tearDown(self):
        impl = self.proj / ".claude" / "impl"
        if impl.exists():
            os.chmod(impl, 0o700)
        self._tmp.cleanup()

    def side(self) -> Path:
        return Path(guard_stop.sidecar_path(str(self.proj), "13"))

    def test_non_issue_branch_allows_stop(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "main"))

    def test_missing_state_file_allows_stop(self):
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

    def test_symlinked_impl_parent_cannot_persist_incomplete_flow_state(self):
        with tempfile.TemporaryDirectory() as outside_raw:
            outside = Path(outside_raw)
            state = outside / "issue-13.state"
            state.write_text(ISSUE13_PARTIAL, encoding="utf-8")
            (self.proj / ".claude").mkdir()
            os.symlink(outside, self.proj / ".claude" / "impl")
            before = {path.name: path.read_bytes() for path in outside.iterdir()}

            self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

            after = {path.name: path.read_bytes() for path in outside.iterdir()}
            self.assertEqual(after, before)
            self.assertNotIn(".guard-stop-issue-13.json", after)

    def test_symlinked_impl_parent_cannot_remove_paused_or_completed_sidecar(self):
        for state_text in (ISSUE13_PARTIAL + "paused=true\n", ALL_DONE):
            with self.subTest(state=state_text):
                with tempfile.TemporaryDirectory() as outside_raw:
                    outside = Path(outside_raw)
                    (outside / "issue-13.state").write_text(
                        state_text, encoding="utf-8"
                    )
                    side = outside / ".guard-stop-issue-13.json"
                    side.write_text('{"precious": true}', encoding="utf-8")
                    impl = self.proj / ".claude" / "impl"
                    impl.parent.mkdir(exist_ok=True)
                    os.symlink(outside, impl)
                    try:
                        self.assertIsNone(
                            guard_stop.evaluate(str(self.proj), "issues/13")
                        )
                        self.assertEqual(
                            side.read_text(encoding="utf-8"), '{"precious": true}'
                        )
                    finally:
                        impl.unlink()

    def test_paused_allows_stop(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL + "paused=true\n")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

    def test_pause_resets_an_exhausted_stall_counter(self):
        # Pausing must clear the sidecar; otherwise resuming an issue whose
        # counter was already exhausted would leave the guard disabled.
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        for _ in range(3):
            self.assertIsNotNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        write_state(self.proj, "13", ISSUE13_PARTIAL + "paused=true\n")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertFalse(self.side().exists())
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertEqual(
            json.loads(self.side().read_text())["consecutive_blocks"], 1
        )

    def test_all_done_allows_stop_and_removes_sidecar(self):
        write_state(self.proj, "13", ALL_DONE)
        self.side().parent.mkdir(parents=True, exist_ok=True)
        self.side().write_text("{}", encoding="utf-8")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertFalse(self.side().exists())

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
            side = json.loads(self.side().read_text())
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
        self.assertEqual(
            json.loads(self.side().read_text())["consecutive_blocks"], 1
        )

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
        self.assertIsNotNone(guard_stop.evaluate(str(self.proj), branch))

    def test_plan_file_change_counts_as_progress(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        plan = self.proj / ".claude" / "impl" / "issue-13-plan.md"
        plan.write_text("# plan\n", encoding="utf-8")
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        plan.write_text("# plan\n## review outcomes\n", encoding="utf-8")
        self.assertIsNotNone(guard_stop.evaluate(str(self.proj), branch))

    def test_log_activity_counts_as_progress(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        logs = self.proj / ".claude" / "logs"
        logs.mkdir(parents=True)
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        (logs / "2026-08-03_guard.md").write_text("progress\n", encoding="utf-8")
        self.assertIsNotNone(guard_stop.evaluate(str(self.proj), branch))

    def test_source_edit_in_git_repo_counts_as_progress(self):
        subprocess.run(
            ["git", "init", "-q", "-b", "issues/13", str(self.proj)],
            check=True, capture_output=True,
        )
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch))
        src = self.proj / "src"
        src.mkdir()
        (src / "schema.ts").write_text("export const x = 1;\n", encoding="utf-8")
        self.assertIsNotNone(guard_stop.evaluate(str(self.proj), branch))

    def test_new_session_resets_the_stall_counter(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        branch = "issues/13"
        for _ in range(3):
            guard_stop.evaluate(str(self.proj), branch, session_id="s1")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), branch, session_id="s1"))
        payload = guard_stop.evaluate(str(self.proj), branch, session_id="s2")
        self.assertIsNotNone(payload)
        self.assertEqual(
            json.loads(self.side().read_text())["consecutive_blocks"], 1
        )

    def test_corrupted_sidecar_is_rebuilt(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.side().parent.mkdir(parents=True, exist_ok=True)
        self.side().write_text("not json", encoding="utf-8")
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertEqual(
            json.loads(self.side().read_text())["consecutive_blocks"], 1
        )

    def test_non_object_json_sidecar_is_rebuilt(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.side().parent.mkdir(parents=True, exist_ok=True)
        self.side().write_text("[]", encoding="utf-8")
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertEqual(
            json.loads(self.side().read_text())["consecutive_blocks"], 1
        )

    def test_invalid_utf8_state_does_not_crash(self):
        impl = self.proj / ".claude" / "impl"
        impl.mkdir(parents=True)
        (impl / "issue-13.state").write_bytes(
            b"step01_issue=done\n\xff\xfe garbage\n"
        )
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertIn("step02_branch", payload["reason"])

    @unittest.skipIf(os.geteuid() == 0, "permission checks are void as root")
    def test_unwritable_sidecar_dir_fails_open(self):
        # If the stall counter cannot be durably recorded, the local backoff
        # could never advance — so the guard must allow the stop instead.
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        impl = self.proj / ".claude" / "impl"
        os.chmod(impl, 0o500)
        try:
            self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        finally:
            os.chmod(impl, 0o700)

    def test_symlinked_sidecar_target_is_not_truncated(self):
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        target = self.proj / "target.json"
        target.write_text('{"precious": true}', encoding="utf-8")
        self.side().parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, self.side())
        payload = guard_stop.evaluate(str(self.proj), "issues/13")
        self.assertIsNotNone(payload)
        self.assertEqual(target.read_text(encoding="utf-8"), '{"precious": true}')
        self.assertFalse(os.path.islink(self.side()))


class HasLiveBackgroundTest(unittest.TestCase):
    """A session waiting on live background work may stop: the completion
    notification re-wakes it. This is how an orchestrator sharing the branch
    with an implementing teammate idles without being blocked."""

    def test_running_delegated_task_is_live(self):
        for task_type in ("teammate", "subagent", "workflow", "cloud session",
                          "MCP task", "shell", "Cloud_Session", "mcp-task"):
            with self.subTest(type=task_type):
                self.assertTrue(
                    guard_stop.has_live_background(
                        [{"id": "t1", "type": task_type, "status": "running"}]
                    )
                )

    def test_unknown_status_on_delegated_task_counts_as_live(self):
        # A listed delegated task without an explicitly terminal status is
        # still being waited on.
        self.assertTrue(
            guard_stop.has_live_background(
                [{"type": "teammate", "status": "pending"}]
            )
        )
        self.assertTrue(guard_stop.has_live_background([{"type": "subagent"}]))

    def test_persistent_or_unknown_types_are_not_live(self):
        # A monitor watches indefinitely and cannot promise a completion
        # wake-up; unknown or missing types stay conservative so schema
        # drift cannot silently disable the guard.
        self.assertFalse(
            guard_stop.has_live_background(
                [{"type": "monitor", "status": "running"}]
            )
        )
        self.assertFalse(
            guard_stop.has_live_background(
                [{"type": "laser", "status": "running"}]
            )
        )
        self.assertFalse(guard_stop.has_live_background([{"status": "running"}]))
        self.assertFalse(guard_stop.has_live_background([{"id": "t1"}]))

    def test_terminal_statuses_are_not_live(self):
        for status in ("completed", "failed", "cancelled", "canceled",
                       "killed", "done", "error", "COMPLETED", " Done "):
            with self.subTest(status=status):
                self.assertFalse(
                    guard_stop.has_live_background(
                        [{"type": "teammate", "status": status}]
                    )
                )

    def test_mixed_list_is_live_when_any_delegated_task_is(self):
        self.assertTrue(
            guard_stop.has_live_background(
                [{"type": "teammate", "status": "completed"},
                 {"type": "shell", "status": "running"}]
            )
        )

    def test_empty_or_malformed_input_is_not_live(self):
        self.assertFalse(guard_stop.has_live_background([]))
        self.assertFalse(guard_stop.has_live_background(None))
        self.assertFalse(guard_stop.has_live_background("oops"))
        self.assertFalse(guard_stop.has_live_background({"status": "running"}))
        self.assertFalse(guard_stop.has_live_background([1, "x", None]))


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
        for stdin in ("not json", "[]", "null", "42", '"str"', ""):
            with self.subTest(stdin=stdin):
                res = self._run_hook(stdin, {})
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

    def test_live_background_task_allows_stop(self):
        # Orchestrator case: same branch, incomplete steps, but a teammate is
        # still working — the guard must let this session idle.
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({
                    "hook_event_name": "Stop",
                    "background_tasks": [
                        {"id": "t1", "type": "teammate", "status": "running"}
                    ],
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_terminal_background_tasks_still_block(self):
        # The original stall pattern: the delegated work finished, nothing is
        # running, steps remain — the guard must push the agent back in.
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({
                    "hook_event_name": "Stop",
                    "background_tasks": [
                        {"id": "t1", "type": "teammate", "status": "completed"}
                    ],
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(res.returncode, 0)
            payload = json.loads(res.stdout)
            self.assertEqual(payload["decision"], "block")

    def test_persistent_monitor_does_not_lift_the_guard(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({
                    "hook_event_name": "Stop",
                    "background_tasks": [
                        {"id": "m1", "type": "monitor", "status": "running"}
                    ],
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(res.returncode, 0)
            payload = json.loads(res.stdout)
            self.assertEqual(payload["decision"], "block")

    def test_guard_re_engages_after_delegated_work_finishes(self):
        # Lifecycle: blocked stops seed the stall counter; a live-teammate
        # stop passes through without touching the sidecar; once the work
        # is finished the guard re-engages and the counter resumes.
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            base = {"hook_event_name": "Stop"}
            for _ in range(2):
                res = self._run_hook(
                    json.dumps(base), {"CLAUDE_PROJECT_DIR": proj}
                )
                self.assertEqual(
                    json.loads(res.stdout)["decision"], "block"
                )
            side = Path(guard_stop.sidecar_path(proj, "7"))
            before = side.read_text(encoding="utf-8")
            res = self._run_hook(
                json.dumps({
                    **base,
                    "background_tasks": [
                        {"id": "t1", "type": "teammate", "status": "running"}
                    ],
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(res.stdout.strip(), "")
            self.assertEqual(side.read_text(encoding="utf-8"), before)
            res = self._run_hook(
                json.dumps({
                    **base,
                    "background_tasks": [
                        {"id": "t1", "type": "teammate", "status": "completed"}
                    ],
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(json.loads(res.stdout)["decision"], "block")
            self.assertEqual(
                json.loads(side.read_text(encoding="utf-8"))
                ["consecutive_blocks"],
                3,
            )

    def test_malformed_background_tasks_still_block(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({
                    "hook_event_name": "Stop",
                    "background_tasks": "oops",
                }),
                {"CLAUDE_PROJECT_DIR": proj},
            )
            self.assertEqual(res.returncode, 0)
            payload = json.loads(res.stdout)
            self.assertEqual(payload["decision"], "block")

    def test_incomplete_flow_blocks_via_stdout_json(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop", "session_id": "s1"}),
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

    def test_input_cwd_wins_over_project_dir(self):
        with self._git_repo("main") as main:
            main_path = Path(main)
            subprocess.run(
                [
                    "git", "-C", main, "-c", "user.email=test@example.com",
                    "-c", "user.name=Test", "commit", "-q", "--allow-empty",
                    "-m", "initial",
                ],
                check=True,
                capture_output=True,
            )
            with tempfile.TemporaryDirectory() as root:
                worktree = Path(root) / "issues-7"
                subprocess.run(
                    [
                        "git", "-C", main, "worktree", "add", "-q", "-b",
                        "issues/7", str(worktree),
                    ],
                    check=True,
                    capture_output=True,
                )
                write_state(worktree, "7", "step01_issue=done\n")
                stdin = json.dumps({"hook_event_name": "Stop", "cwd": str(worktree)})
                with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(main_path)}), patch(
                    "guard_stop.sys.stdin", new=io.StringIO(stdin)
                ), patch("guard_stop.sys.stdout", new=io.StringIO()) as stdout:
                    self.assertEqual(guard_stop.main(), 0)
                    payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["decision"], "block")
                self.assertIn("issue 7", payload["reason"])

    def test_input_cwd_subdirectory_uses_worktree_state_file(self):
        with self._git_repo("main") as main:
            main_path = Path(main)
            subprocess.run(
                [
                    "git", "-C", main, "-c", "user.email=test@example.com",
                    "-c", "user.name=Test", "commit", "-q", "--allow-empty",
                    "-m", "initial",
                ],
                check=True,
                capture_output=True,
            )
            with tempfile.TemporaryDirectory() as root:
                worktree = Path(root) / "issues-7"
                subprocess.run(
                    [
                        "git", "-C", main, "worktree", "add", "-q", "-b",
                        "issues/7", str(worktree),
                    ],
                    check=True,
                    capture_output=True,
                )
                cwd = worktree / "src"
                cwd.mkdir()
                write_state(worktree, "7", "step01_issue=done\n")
                stdin = json.dumps({"hook_event_name": "Stop", "cwd": str(cwd)})
                with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(main_path)}), patch(
                    "guard_stop.sys.stdin", new=io.StringIO(stdin)
                ), patch("guard_stop.sys.stdout", new=io.StringIO()) as stdout:
                    self.assertEqual(guard_stop.main(), 0)
                    payload = json.loads(stdout.getvalue())
                self.assertEqual(payload["decision"], "block")
                self.assertIn("issue 7", payload["reason"])

    def test_non_git_directory_passes_through(self):
        with tempfile.TemporaryDirectory() as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop", "cwd": proj}), {}
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_detached_head_passes_through(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            git = ["git", "-C", proj]
            subprocess.run(
                [*git, "-c", "user.email=t@t", "-c", "user.name=t",
                 "commit", "-q", "--allow-empty", "-m", "init"],
                check=True, capture_output=True,
            )
            sha = subprocess.run(
                [*git, "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            subprocess.run(
                [*git, "checkout", "-q", sha], check=True, capture_output=True
            )
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop"}),
                {"CLAUDE_PROJECT_DIR": proj},
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")

    def test_missing_git_executable_fails_open(self):
        with tempfile.TemporaryDirectory() as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run_hook(
                json.dumps({"hook_event_name": "Stop", "cwd": proj}),
                {"PATH": "/nonexistent"},
            )
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()


class ProgressArtifactDigestTest(unittest.TestCase):
    """The progress digest must ignore a delegation's own transcript.

    Regression for issue #210: `codex exec --json` and `-o <file>` stream into
    `.claude/impl/issue-<N>-reviews/`, so every blocked turn grew a file inside
    the digested set, the digest moved, and the stall counter reset forever.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)
        self.reviews = self.proj / ".claude" / "impl" / "issue-13-reviews"
        self.reviews.mkdir(parents=True)
        self.logs = self.proj / ".claude" / "logs"
        self.logs.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def digest(self):
        return guard_stop.progress_hash(str(self.proj), "13")

    def test_review_verdict_counts_as_progress(self):
        before = self.digest()
        (self.reviews / "step10-review.md").write_text("approve", encoding="utf-8")
        self.assertNotEqual(self.digest(), before)

    def test_implementation_log_counts_as_progress(self):
        before = self.digest()
        (self.logs / "2026-08-28_issue-13.md").write_text("log", encoding="utf-8")
        self.assertNotEqual(self.digest(), before)

    def test_growing_a_delegation_jsonl_is_not_progress(self):
        transcript = self.reviews / "step10.jsonl"
        transcript.write_text('{"turn":1}\n', encoding="utf-8")
        before = self.digest()
        transcript.write_text('{"turn":1}\n{"turn":2}\n', encoding="utf-8")
        self.assertEqual(self.digest(), before)

    def test_creating_a_delegation_jsonl_is_not_progress(self):
        before = self.digest()
        (self.reviews / "step10.jsonl").write_text('{"turn":1}\n', encoding="utf-8")
        self.assertEqual(self.digest(), before)

    def test_growing_the_last_message_file_is_not_progress(self):
        last = self.reviews / "step10b.msg.txt"
        last.write_text("partial", encoding="utf-8")
        before = self.digest()
        last.write_text("partial, then more", encoding="utf-8")
        self.assertEqual(self.digest(), before)

    def test_transcript_in_the_logs_directory_is_not_progress(self):
        before = self.digest()
        (self.logs / "delegation.jsonl").write_text("{}\n", encoding="utf-8")
        self.assertEqual(self.digest(), before)

    def test_unrecognised_artifact_is_not_progress(self):
        """Allowlist, not denylist: an unknown file may only make the guard
        give up earlier, never loop longer."""
        before = self.digest()
        (self.reviews / "scratch.bin").write_bytes(b"\x00\x01")
        self.assertEqual(self.digest(), before)

    def test_incident_replay_reaches_the_stall_ceiling(self):
        """The exact #210 shape: a transcript grows on every blocked turn."""
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        transcript = self.reviews / "step10.jsonl"
        blocked = 0
        for turn in range(1, 12):
            transcript.write_text("x" * turn * 100, encoding="utf-8")
            os.utime(transcript, (turn, turn))
            if guard_stop.evaluate(str(self.proj), "issues/13") is None:
                break
            blocked += 1
        self.assertEqual(blocked, guard_stop.MAX_STALLED_BLOCKS)


class AbsoluteBlockCeilingTest(unittest.TestCase):
    """A ceiling that a moving progress digest cannot clear.

    MAX_STALLED_BLOCKS only bounds a *stationary* flow, so any defect in
    progress detection removes the bound entirely. Codex CLI has no outer
    backstop of its own (openai/codex#37937 open, #12336 closed as not
    planned), so on that path this is the only ceiling.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.plan = self.proj / ".claude" / "impl" / "issue-13-plan.md"

    def tearDown(self):
        self._tmp.cleanup()

    def side(self) -> Path:
        return Path(guard_stop.sidecar_path(str(self.proj), "13"))

    def block_with_fresh_progress(self, session_id=""):
        """One blocked turn whose progress digest always looks different."""
        self.plan.write_text(str(os.urandom(8)), encoding="utf-8")
        return guard_stop.evaluate(str(self.proj), "issues/13", session_id)

    def test_total_blocks_is_recorded(self):
        self.block_with_fresh_progress()
        self.block_with_fresh_progress()
        self.assertEqual(json.loads(self.side().read_text())["total_blocks"], 2)

    def test_moving_digest_never_clears_the_absolute_ceiling(self):
        for _ in range(guard_stop.MAX_TOTAL_BLOCKS):
            self.assertIsNotNone(self.block_with_fresh_progress())
        self.assertIsNone(
            self.block_with_fresh_progress(),
            "a digest that moves every turn must not defeat the absolute ceiling",
        )

    def test_ceiling_stays_closed_once_reached(self):
        for _ in range(guard_stop.MAX_TOTAL_BLOCKS + 1):
            self.block_with_fresh_progress()
        for _ in range(3):
            self.assertIsNone(self.block_with_fresh_progress())

    def test_consecutive_ceiling_still_applies_first(self):
        """A stationary flow must still stop at the much lower stall ceiling."""
        for _ in range(guard_stop.MAX_STALLED_BLOCKS):
            self.assertIsNotNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))

    def test_pause_resets_the_absolute_ceiling(self):
        for _ in range(guard_stop.MAX_TOTAL_BLOCKS + 1):
            self.block_with_fresh_progress()
        write_state(self.proj, "13", ISSUE13_PARTIAL + "paused=true\n")
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertFalse(self.side().exists())
        write_state(self.proj, "13", ISSUE13_PARTIAL)
        self.assertIsNotNone(self.block_with_fresh_progress())

    def test_completed_flow_resets_the_absolute_ceiling(self):
        for _ in range(guard_stop.MAX_TOTAL_BLOCKS + 1):
            self.block_with_fresh_progress()
        write_state(self.proj, "13", ALL_DONE)
        self.assertIsNone(guard_stop.evaluate(str(self.proj), "issues/13"))
        self.assertFalse(self.side().exists())

    def test_a_different_session_starts_a_fresh_budget(self):
        for _ in range(guard_stop.MAX_TOTAL_BLOCKS + 1):
            self.block_with_fresh_progress("session-a")
        self.assertIsNone(self.block_with_fresh_progress("session-a"))
        self.assertIsNotNone(self.block_with_fresh_progress("session-b"))

    def test_malformed_total_is_treated_as_zero(self):
        self.block_with_fresh_progress()
        side = self.side()
        data = json.loads(side.read_text())
        data["total_blocks"] = "not-a-number"
        side.write_text(json.dumps(data), encoding="utf-8")
        self.assertIsNotNone(self.block_with_fresh_progress())
        self.assertEqual(json.loads(side.read_text())["total_blocks"], 1)

    def test_absolute_ceiling_is_far_above_the_stall_ceiling(self):
        self.assertGreater(guard_stop.MAX_TOTAL_BLOCKS, guard_stop.MAX_STALLED_BLOCKS * 10)
