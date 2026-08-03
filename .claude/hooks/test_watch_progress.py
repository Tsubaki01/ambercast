#!/usr/bin/env python3
"""Tests for watch_progress.py (asyncRewake watchdog for the /implement flow).

Run from the repository root:
    python3 -m unittest discover -s .claude/hooks -p "test_watch_progress.py" -v
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

HOOKS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS_DIR))

import guard_stop  # noqa: E402
import watch_progress  # noqa: E402

ALL_DONE = "".join(f"{key}=done\n" for key, _ in guard_stop.STEPS)

PARTIAL = (
    "issue=13\n"
    "branch=issues/13\n"
    + "".join(f"{key}=done\n" for key, _ in guard_stop.STEPS[:9])
)


def write_state(proj: Path, issue: str, content: str) -> Path:
    impl = proj / ".claude" / "impl"
    impl.mkdir(parents=True, exist_ok=True)
    state = impl / f"issue-{issue}.state"
    state.write_text(content, encoding="utf-8")
    return state


class FakeClock:
    """Deterministic clock: sleep() advances time and runs an optional
    per-iteration callback so tests can mutate files mid-watch."""

    def __init__(self, on_sleep=None):
        self.t = 0.0
        self.sleeps = 0
        self.on_sleep = on_sleep

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps += 1
        self.t += seconds
        if self.on_sleep:
            self.on_sleep(self.sleeps)


class WatchLoopTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def watch(self, clock, interval=60, stale=720, max_runtime=20000):
        return watch_progress.watch(
            str(self.proj), "13",
            interval=interval, stale_after=stale, max_runtime=max_runtime,
            sleep_fn=clock.sleep, now_fn=clock.now,
        )

    def test_stale_flow_wakes_with_exit_2(self):
        write_state(self.proj, "13", PARTIAL)
        clock = FakeClock()
        code, message = self.watch(clock)
        self.assertEqual(code, 2)
        self.assertIn("issue 13", message)
        self.assertIn("step10_tests_review", message)
        self.assertIn("SendMessage", message)
        self.assertIn("23415", message)
        # Woke at the stale threshold, not the max-runtime ceiling.
        self.assertLess(clock.t, 20000)
        self.assertGreaterEqual(clock.t, 720)

    def test_progress_resets_the_stale_timer(self):
        state = write_state(self.proj, "13", PARTIAL)
        # 720s stale / 60s interval = wakes after 12 idle polls; progress at
        # poll 10 must push the wake past the naive deadline.
        def on_sleep(iteration):
            if iteration == 10:
                state.write_text(
                    PARTIAL + "step10_tests_review=done\n", encoding="utf-8"
                )
        clock = FakeClock(on_sleep)
        code, message = self.watch(clock)
        self.assertEqual(code, 2)
        self.assertGreaterEqual(clock.t, 600 + 720)
        self.assertIn("step11_code", message)

    def test_todo_change_counts_as_progress(self):
        write_state(self.proj, "13", PARTIAL)
        todos = self.proj / ".claude" / "todos"
        todos.mkdir(parents=True)
        todo = todos / "issue-13-x.md"
        todo.write_text("- [ ] a\n", encoding="utf-8")

        def on_sleep(iteration):
            if iteration == 10:
                todo.write_text("- [x] a\n", encoding="utf-8")
        clock = FakeClock(on_sleep)
        code, _ = self.watch(clock)
        self.assertEqual(code, 2)
        self.assertGreaterEqual(clock.t, 600 + 720)

    def test_flow_completion_ends_the_watch_quietly(self):
        state = write_state(self.proj, "13", PARTIAL)

        def on_sleep(iteration):
            if iteration == 3:
                state.write_text(ALL_DONE, encoding="utf-8")
        clock = FakeClock(on_sleep)
        code, message = self.watch(clock)
        self.assertEqual(code, 0)
        self.assertEqual(message, "")

    def test_pause_ends_the_watch_quietly(self):
        state = write_state(self.proj, "13", PARTIAL)

        def on_sleep(iteration):
            if iteration == 3:
                state.write_text(PARTIAL + "paused=true\n", encoding="utf-8")
        clock = FakeClock(on_sleep)
        code, _ = self.watch(clock)
        self.assertEqual(code, 0)

    def test_deleted_state_ends_the_watch_quietly(self):
        state = write_state(self.proj, "13", PARTIAL)

        def on_sleep(iteration):
            if iteration == 3:
                state.unlink()
        clock = FakeClock(on_sleep)
        code, _ = self.watch(clock)
        self.assertEqual(code, 0)

    def test_max_runtime_wakes_to_rearm_even_with_progress(self):
        state = write_state(self.proj, "13", PARTIAL)
        # Continuous progress: append to the state file on every poll so the
        # stale timer never fires; the max-runtime ceiling must still end
        # the watch with a re-arm wake.
        def on_sleep(iteration):
            with open(state, "a", encoding="utf-8") as f:
                f.write(f"# tick {iteration}\n")
        clock = FakeClock(on_sleep)
        code, message = self.watch(clock, max_runtime=600)
        self.assertEqual(code, 2)
        self.assertIn("re-arm", message)
        self.assertGreaterEqual(clock.t, 600)
        self.assertLess(clock.t, 1200)


class LockTest(unittest.TestCase):
    """The lock must be atomic (no check-then-write race), immune to pid
    reuse, and self-releasing when the holder dies — flock semantics."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name)
        (self.proj / ".claude" / "impl").mkdir(parents=True)

    def tearDown(self):
        for issue in ("13", "77"):
            watch_progress.release_lock(str(self.proj), issue)
        self._tmp.cleanup()

    def test_leftover_pidfile_from_dead_process_is_reacquired(self):
        # A pidfile left by a crashed watchdog holds no lock (the kernel
        # released it with the process) — even if its recorded pid has
        # been recycled by an unrelated live process.
        lock = Path(watch_progress.lock_path(str(self.proj), "13"))
        lock.write_text(str(os.getpid()), encoding="utf-8")
        self.assertTrue(watch_progress.acquire_lock(str(self.proj), "13"))
        self.assertEqual(lock.read_text(encoding="utf-8"), str(os.getpid()))

    def test_held_lock_is_respected_until_released(self):
        self.assertTrue(watch_progress.acquire_lock(str(self.proj), "13"))
        self.assertFalse(watch_progress.acquire_lock(str(self.proj), "13"))
        watch_progress.release_lock(str(self.proj), "13")
        self.assertTrue(watch_progress.acquire_lock(str(self.proj), "13"))

    def test_corrupt_pidfile_is_reacquired(self):
        lock = Path(watch_progress.lock_path(str(self.proj), "13"))
        lock.write_text("not a pid", encoding="utf-8")
        self.assertTrue(watch_progress.acquire_lock(str(self.proj), "13"))

    def test_concurrent_acquisition_has_exactly_one_winner(self):
        barrier = threading.Barrier(8, timeout=5)

        def attempt(_):
            barrier.wait()
            return watch_progress.acquire_lock(str(self.proj), "77")

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(8)))
        self.assertEqual(sum(results), 1)


class EnvFloatTest(unittest.TestCase):
    def test_invalid_overrides_fall_back_to_default(self):
        for raw in ("0", "-5", "nan", "inf", "-inf", "abc", ""):
            with self.subTest(raw=raw):
                with mock.patch.dict(os.environ, {"WD_TEST_VAR": raw}):
                    self.assertEqual(
                        watch_progress._env_float("WD_TEST_VAR", 60.0), 60.0
                    )

    def test_valid_override_is_used(self):
        with mock.patch.dict(os.environ, {"WD_TEST_VAR": "0.05"}):
            self.assertEqual(
                watch_progress._env_float("WD_TEST_VAR", 60.0), 0.05
            )

    def test_missing_override_uses_default(self):
        os.environ.pop("WD_TEST_VAR", None)
        self.assertEqual(watch_progress._env_float("WD_TEST_VAR", 60.0), 60.0)

    def test_max_runtime_is_clamped_under_the_hook_timeout(self):
        # A max runtime above the hook timeout would let the runner kill
        # the process before its re-arm wake ever fires.
        self.assertEqual(
            watch_progress.clamp_max_runtime(
                watch_progress.MAX_RUNTIME_CEILING_SEC + 1
            ),
            watch_progress.MAX_RUNTIME_CEILING_SEC,
        )
        self.assertEqual(watch_progress.clamp_max_runtime(600.0), 600.0)

    def test_ceiling_keeps_a_margin_under_the_configured_hook_timeout(self):
        # Drift guard: if someone changes the Stop-hook timeout in
        # settings.json or the ceiling constant, the re-arm wake must
        # still fire before the runner kills the process.
        settings = json.loads(
            (HOOKS_DIR.parent / "settings.json").read_text(encoding="utf-8")
        )
        entries = [
            hook
            for group in settings["hooks"]["Stop"]
            for hook in group["hooks"]
            if "watch_progress.py" in hook.get("command", "")
        ]
        self.assertEqual(len(entries), 1)
        self.assertTrue(entries[0].get("async"))
        self.assertTrue(entries[0].get("asyncRewake"))
        self.assertGreaterEqual(
            entries[0]["timeout"] - watch_progress.MAX_RUNTIME_CEILING_SEC,
            300,
        )


class EndToEndTest(unittest.TestCase):
    """Run the watchdog as Claude Code does: a subprocess fed JSON on stdin,
    with tiny intervals injected through the environment."""

    HOOK = str(HOOKS_DIR / "watch_progress.py")

    def _git_repo(self, branch: str) -> tempfile.TemporaryDirectory:
        tmp = tempfile.TemporaryDirectory()
        subprocess.run(
            ["git", "init", "-q", "-b", branch, tmp.name],
            check=True, capture_output=True,
        )
        return tmp

    def _env(self, proj, extra=None):
        env = {k: v for k, v in os.environ.items()
               if k != "CLAUDE_PROJECT_DIR"}
        env.update({
            "CLAUDE_PROJECT_DIR": proj,
            "AMBERCAST_WATCHDOG_INTERVAL_SEC": "0.05",
            "AMBERCAST_WATCHDOG_STALE_SEC": "0.3",
            "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC": "10",
        })
        env.update(extra or {})
        return env

    def _run(self, proj, extra_env=None, stdin='{"hook_event_name":"Stop"}'):
        return subprocess.run(
            [sys.executable, self.HOOK],
            input=stdin, env=self._env(proj, extra_env),
            capture_output=True, text=True, timeout=30,
        )

    def test_stale_flow_exits_2_with_wake_message(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run(proj)
        self.assertEqual(res.returncode, 2)
        self.assertIn("watchdog", res.stderr)
        self.assertIn("step02_branch", res.stderr)
        self.assertEqual(res.stdout.strip(), "")

    def test_kill_switch_exits_0(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run(proj, {"AMBERCAST_WATCHDOG": "0"})
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stderr.strip(), "")

    def test_completed_flow_exits_0_immediately(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", ALL_DONE)
            res = self._run(proj)
        self.assertEqual(res.returncode, 0)

    def test_non_issue_branch_exits_0(self):
        with self._git_repo("main") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run(proj)
        self.assertEqual(res.returncode, 0)

    def test_invalid_stdin_is_tolerated(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            res = self._run(proj, stdin="not json")
        self.assertEqual(res.returncode, 2)
        self.assertIn("watchdog", res.stderr)

    def test_branch_switch_ends_the_watch_quietly(self):
        # The arming turn's issue branch may be left behind (merge done,
        # switch to main, next issue) while the watchdog still runs; it
        # must notice and bow out instead of waking with stale advice.
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            first = subprocess.Popen(
                [sys.executable, self.HOOK],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True,
                env=self._env(proj, {
                    "AMBERCAST_WATCHDOG_STALE_SEC": "20",
                    "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC": "20",
                }),
            )
            try:
                first.stdin.write('{"hook_event_name":"Stop"}')
                first.stdin.close()
                deadline = time.time() + 5
                lock = Path(watch_progress.lock_path(proj, "7"))
                while not lock.exists() and time.time() < deadline:
                    time.sleep(0.05)
                self.assertTrue(lock.exists(), "watchdog never locked")
                subprocess.run(
                    ["git", "-C", proj, "symbolic-ref", "HEAD",
                     "refs/heads/main"],
                    check=True, capture_output=True,
                )
                self.assertEqual(first.wait(timeout=10), 0)
                err = first.stderr.read()
                self.assertEqual(err.strip(), "")
            finally:
                first.terminate()
                first.wait(timeout=10)
                first.stdout.close()
                first.stderr.close()

    def test_second_instance_yields_to_a_live_lock(self):
        with self._git_repo("issues/7") as proj:
            write_state(Path(proj), "7", "step01_issue=done\n")
            first = subprocess.Popen(
                [sys.executable, self.HOOK],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True,
                env=self._env(proj, {
                    "AMBERCAST_WATCHDOG_STALE_SEC": "20",
                    "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC": "20",
                }),
            )
            try:
                first.stdin.write('{"hook_event_name":"Stop"}')
                first.stdin.close()
                deadline = time.time() + 5
                lock = Path(watch_progress.lock_path(proj, "7"))
                while not lock.exists() and time.time() < deadline:
                    time.sleep(0.05)
                self.assertTrue(lock.exists(), "first instance never locked")
                res = self._run(proj)
                self.assertEqual(res.returncode, 0)
                self.assertEqual(res.stderr.strip(), "")
            finally:
                first.terminate()
                first.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
