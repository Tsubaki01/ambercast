#!/usr/bin/env python3
"""Tests for watch_progress.py (asyncRewake watchdog for the /implement flow).

Run from the repository root:
    python3 -m unittest discover -s .claude/hooks -p "test_watch_progress.py" -v
"""
import io
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
            sleep_fn=clock.sleep, monotonic_fn=clock.now, wall_fn=clock.now,
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

    def test_lock_acquisition_reports_operating_system_errors_separately(self):
        with mock.patch("watch_progress.os.makedirs", side_effect=OSError("read-only")):
            self.assertEqual(
                watch_progress._acquire_lock_path(str(self.proj / "broken.pid")),
                "error",
            )


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


class DualClock:
    """Virtual host clock that can suspend monotonic time or roll wall time back."""

    def __init__(self, wall_step=60, monotonic_step=60, on_sleep=None):
        self.wall = 0.0
        self.monotonic = 0.0
        self.wall_step = wall_step
        self.monotonic_step = monotonic_step
        self.sleeps = 0
        self.on_sleep = on_sleep

    def sleep(self, _seconds):
        self.sleeps += 1
        self.wall += self.wall_step
        self.monotonic += self.monotonic_step
        if self.on_sleep:
            self.on_sleep(self.sleeps)

    def wall_now(self):
        return self.wall

    def monotonic_now(self):
        return self.monotonic


def target(path: Path, branch: str, issue: str):
    return {"path": str(path), "branch": branch, "issue": issue}


class OrchestratorWatchTest(unittest.TestCase):
    """Primary-checkout supervision keeps every active issue independently live."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.proj = Path(self._tmp.name) / "primary"
        self.proj.mkdir()
        (self.proj / ".claude" / "impl").mkdir(parents=True)
        self.one = target(self.proj / "issue-118", "issues/118-alpha", "118")
        self.two = target(self.proj / "issue-118-b", "issues/118-beta", "118")
        self.other = target(self.proj / "issue-119", "issues/119-beta", "119")

    def tearDown(self):
        watch_progress.release_orchestrator_lock(str(self.proj))
        self._tmp.cleanup()

    def watch(self, discovery, clock, hashes=None, stale=120):
        hashes = hashes or {}
        return watch_progress.watch_orchestrator(
            str(self.proj), interval=60, stale_after=stale, max_runtime=10000,
            sleep_fn=clock.sleep, monotonic_fn=clock.monotonic_now,
            wall_fn=clock.wall_now, discover_fn=discovery,
            hash_fn=lambda path, issue: hashes.get((path, issue), "steady"),
        )

    def test_active_target_wakes_the_primary_with_its_issue_name(self):
        code, message = self.watch(lambda: [self.one], DualClock())
        self.assertEqual(code, 2)
        self.assertIn("issues/118-alpha", message)
        self.assertIn("gh pr list --json", message)
        self.assertIn("live state", message)

    def test_paused_and_completed_worktrees_are_excluded(self):
        paused = self.proj / "paused"
        complete = self.proj / "complete"
        write_state(paused, "20", "paused=true\nstep01_issue=done\n")
        write_state(complete, "21", ALL_DONE)
        records = [
            {"path": str(paused), "branch": "issues/20"},
            {"path": str(complete), "branch": "issues/21"},
        ]
        with mock.patch.object(watch_progress, "list_worktrees", return_value=records):
            self.assertEqual(watch_progress.discover_active_targets(str(self.proj)), [])

    def test_stack_layers_with_one_issue_number_are_independent_targets(self):
        code, message = self.watch(lambda: [self.one, self.two], DualClock())
        self.assertEqual(code, 2)
        self.assertIn("issues/118-alpha", message)
        self.assertIn("issues/118-beta", message)

    def test_progress_on_one_issue_does_not_mask_another_stale_target(self):
        hashes = {
            (self.one["path"], "118"): "one-v1",
            (self.other["path"], "119"): "two-v1",
        }

        def change_one(iteration):
            if iteration == 1:
                hashes[(self.one["path"], "118")] = "one-v2"

        code, message = self.watch(
            lambda: [self.one, self.other], DualClock(on_sleep=change_one), hashes
        )
        self.assertEqual(code, 2)
        self.assertIn("issues/119-beta", message)
        self.assertNotIn("issues/118-alpha", message)

    def test_disappearing_worktree_is_removed_and_empty_set_exits_quietly(self):
        calls = 0

        def discovery():
            nonlocal calls
            calls += 1
            return [self.one] if calls == 1 else []

        self.assertEqual(self.watch(discovery, DualClock()), (0, ""))

    def test_transient_target_disappearance_preserves_accumulated_idle_time(self):
        # A remains idle but is absent for one successful enumeration while B
        # stays live. Its in-memory clock must resume at the next poll so A
        # wakes with B at the original stale deadline, rather than after a
        # fresh stale window.
        calls = 0

        def discovery():
            nonlocal calls
            calls += 1
            if calls == 3:
                return [self.other]
            return [self.one, self.other]

        clock = DualClock()
        code, message = self.watch(discovery, clock, stale=180)
        self.assertEqual(code, 2)
        self.assertEqual(clock.sleeps, 3)
        self.assertIn(self.one["branch"], message)
        self.assertIn(self.other["branch"], message)

    def test_wall_clock_suspend_wakes_when_monotonic_clock_stops(self):
        code, _ = self.watch(
            lambda: [self.one], DualClock(wall_step=120, monotonic_step=0), stale=120
        )
        self.assertEqual(code, 2)

    def test_wall_clock_rollback_does_not_advance_idle_time(self):
        clock = DualClock(wall_step=-120, monotonic_step=60)
        code, _ = self.watch(lambda: [self.one], clock, stale=120)
        self.assertEqual(code, 2)
        self.assertGreaterEqual(clock.monotonic, 120)

    def test_rollback_then_suspension_accumulates_each_safe_clock_delta(self):
        clock = DualClock(wall_step=-120, monotonic_step=60)

        def suspend_after_rollback(iteration):
            if iteration == 1:
                clock.wall_step = 120
                clock.monotonic_step = 0

        clock.on_sleep = suspend_after_rollback
        code, _ = self.watch(lambda: [self.one], clock, stale=180)
        self.assertEqual(code, 2)
        self.assertEqual(clock.sleeps, 2)

    def test_orchestrator_lock_contention_yields_to_the_first_watchdog(self):
        self.assertEqual(
            watch_progress.acquire_orchestrator_lock(str(self.proj)), "acquired"
        )
        self.assertEqual(
            watch_progress.acquire_orchestrator_lock(str(self.proj)), "contended"
        )

    def test_remembered_target_and_initial_discovery_failure_fail_awake(self):
        sidecar = self.proj / ".claude" / "impl" / ".watchdog-orchestrator.json"
        sidecar.write_text(json.dumps({
            "version": 2,
            "activeTargets": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "steady", "lastProgressWall": 0,
                "lastObservedWall": 0, "idleSeconds": 0,
            }],
            "backoff": [],
        }), encoding="utf-8")

        def unavailable():
            raise watch_progress.WorktreeDiscoveryError("git unavailable")

        code, message = self.watch(unavailable, DualClock())
        self.assertEqual(code, 2)
        self.assertIn("cannot supervise", message)

    def test_backoff_schedule_caps_and_digest_progress_resets_it(self):
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 0), 900)
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 1), 900)
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 2), 24 * 60)
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 3), 48 * 60)
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 4), 60 * 60)
        self.assertEqual(watch_progress.orchestrator_stale_after(900, 99), 60 * 60)
        self.assertEqual(watch_progress.orchestrator_stale_after(3600, 1), 3600)
        self.assertEqual(watch_progress.orchestrator_stale_after(3600, 99), 3600)
        self.assertEqual(
            watch_progress.orchestrator_stale_after(720, 1), 12 * 60
        )

        sidecar = self.proj / ".claude" / "impl" / ".watchdog-orchestrator.json"
        sidecar.write_text(json.dumps({
            "version": 2,
            "activeTargets": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "old", "lastProgressWall": 1,
                "lastObservedWall": 1, "idleSeconds": 9999,
            }],
            "backoff": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "old", "lastWakeWall": 1,
                "backoffIdleSeconds": 9999, "unchangedWakeCount": 4,
            }],
        }), encoding="utf-8")
        hashes = {(self.one["path"], "118"): "new"}
        code, _ = self.watch(lambda: [self.one], DualClock(), hashes, stale=60)
        self.assertEqual(code, 2)
        persisted = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(persisted["backoff"][0]["digest"], "new")
        self.assertEqual(persisted["backoff"][0]["unchangedWakeCount"], 1)

    def test_unknown_initial_discovery_failure_fails_awake(self):
        def unavailable():
            raise watch_progress.WorktreeDiscoveryError("git unavailable")

        code, message = self.watch(unavailable, DualClock())
        self.assertEqual(code, 2)
        self.assertIn("cannot supervise", message)

    def test_same_digest_rearm_preserves_the_remaining_backoff_only(self):
        sidecar = self.proj / ".claude" / "impl" / ".watchdog-orchestrator.json"
        sidecar.write_text(json.dumps({
            "version": 2,
            "activeTargets": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "steady", "lastProgressWall": 0,
                "lastObservedWall": 1000, "idleSeconds": 1120,
            }],
            "backoff": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "steady", "lastWakeWall": 0,
                "backoffIdleSeconds": 0, "unchangedWakeCount": 2,
            }],
        }), encoding="utf-8")
        clock = DualClock()
        clock.wall = 23 * 60
        code, _ = self.watch(lambda: [self.one], clock, stale=120)
        self.assertEqual(code, 2)
        self.assertEqual(clock.sleeps, 1)

    def test_digest_change_resets_persisted_progress_and_backoff(self):
        sidecar = self.proj / ".claude" / "impl" / ".watchdog-orchestrator.json"
        sidecar.write_text(json.dumps({
            "version": 2,
            "activeTargets": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "old", "lastProgressWall": 1,
                "lastObservedWall": 1, "idleSeconds": 9999,
            }],
            "backoff": [{
                "path": self.one["path"], "branch": self.one["branch"],
                "digest": "old", "lastWakeWall": 1,
                "backoffIdleSeconds": 9999, "unchangedWakeCount": 4,
            }],
        }), encoding="utf-8")
        clock = DualClock()
        clock.wall = 1000
        hashes = {(self.one["path"], "118"): "new"}
        code, _ = self.watch(lambda: [self.one], clock, hashes, stale=120)
        self.assertEqual(code, 2)
        self.assertEqual(clock.sleeps, 2)
        persisted = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(persisted["activeTargets"][0]["digest"], "new")
        self.assertEqual(persisted["activeTargets"][0]["lastProgressWall"], 1000)
        self.assertEqual(persisted["backoff"][0]["unchangedWakeCount"], 1)

    def test_one_target_wake_does_not_reset_another_targets_rearm_timer(self):
        hashes = {
            (self.one["path"], "118"): "one-v1",
            (self.other["path"], "119"): "other-v1",
        }

        def progress_other(iteration):
            if iteration == 1:
                hashes[(self.other["path"], "119")] = "other-v2"

        first_clock = DualClock(on_sleep=progress_other)
        code, message = self.watch(
            lambda: [self.one, self.other], first_clock, hashes, stale=120
        )
        self.assertEqual(code, 2)
        self.assertIn(self.one["branch"], message)
        self.assertNotIn(self.other["branch"], message)

        rearmed_clock = DualClock()
        rearmed_clock.wall = 180
        rearmed_clock.monotonic = 180
        code, message = self.watch(
            lambda: [self.other], rearmed_clock, hashes, stale=180
        )
        self.assertEqual(code, 2)
        self.assertIn(self.other["branch"], message)
        self.assertEqual(rearmed_clock.sleeps, 1)

    def test_sidecar_write_failure_warns_without_suppressing_the_wake(self):
        stderr = io.StringIO()
        with mock.patch("watch_progress.persist_orchestrator_sidecar", return_value=False), \
             mock.patch("watch_progress.sys.stderr", stderr):
            code, _ = self.watch(lambda: [self.one], DualClock(), stale=120)
        self.assertEqual(code, 2)
        self.assertIn("sidecar persistence failed", stderr.getvalue())

    def test_three_transient_discovery_failures_are_tolerated_then_wake(self):
        calls = 0

        def discovery():
            nonlocal calls
            calls += 1
            if calls == 1:
                return [self.one]
            raise watch_progress.WorktreeDiscoveryError("temporary failure")

        code, message = self.watch(discovery, DualClock(), stale=9999)
        self.assertEqual(code, 2)
        self.assertIn("cannot supervise", message)
        self.assertEqual(calls, 5)

    def test_malformed_sidecar_is_ignored_as_an_unknown_snapshot(self):
        sidecar = self.proj / ".claude" / "impl" / ".watchdog-orchestrator.json"
        sidecar.write_text("not json", encoding="utf-8")
        self.assertEqual(watch_progress.load_orchestrator_sidecar(str(self.proj)), {
            "version": 2, "activeTargets": [], "backoff": [],
        })


class WorktreeParsingTest(unittest.TestCase):
    def test_nul_porcelain_records_and_plain_fallback_are_parsed(self):
        nul = (
            b"worktree /primary\0HEAD a\0branch refs/heads/main\0\0"
            b"worktree /issue path\0HEAD b\0branch refs/heads/issues/12-x\0\0"
        )
        plain = (
            "worktree /primary\nHEAD a\nbranch refs/heads/main\n\n"
            "worktree /issue path\nHEAD b\nbranch refs/heads/issues/12-x\n\n"
        )
        expected = [
            {"path": "/primary", "branch": "main"},
            {"path": "/issue path", "branch": "issues/12-x"},
        ]
        self.assertEqual(watch_progress.parse_worktree_porcelain(nul, nul=True), expected)
        self.assertEqual(watch_progress.parse_worktree_porcelain(plain, nul=False), expected)

    def test_valueless_metadata_attributes_are_accepted(self):
        payload = (
            b"worktree /primary\0HEAD a\0branch refs/heads/main\0bare\0\0"
            b"worktree /detached\0HEAD b\0detached\0locked\0\0"
            b"worktree /locked\0HEAD c\0branch refs/heads/issues/12\0"
            b"locked maintenance\0\0"
        )
        self.assertEqual(watch_progress.parse_worktree_porcelain(payload, nul=True), [
            {"path": "/primary", "branch": "main"},
            {"path": "/detached", "branch": None},
            {"path": "/locked", "branch": "issues/12"},
        ])

    def test_empty_porcelain_is_a_discovery_failure(self):
        for payload in (b"", ""):
            with self.subTest(payload=payload):
                with self.assertRaises(watch_progress.WorktreeDiscoveryError):
                    watch_progress.parse_worktree_porcelain(payload, nul=True)

    def test_malformed_or_duplicate_porcelain_is_a_discovery_failure(self):
        for raw in (
            b"worktree /primary\0branch refs/heads/main",
            b"worktree /one\0branch refs/heads/main\0\0worktree /one\0branch refs/heads/main\0\0",
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(watch_progress.WorktreeDiscoveryError):
                    watch_progress.parse_worktree_porcelain(raw, nul=True)


class OrchestratorMainTest(unittest.TestCase):
    def test_primary_main_with_an_active_target_arms_orchestrator_mode(self):
        stderr = io.StringIO()
        with mock.patch("watch_progress.guard_stop.current_branch", return_value="main"), \
             mock.patch("watch_progress.is_primary_checkout", return_value=True), \
             mock.patch("watch_progress.acquire_orchestrator_lock", return_value="acquired"), \
             mock.patch("watch_progress.release_orchestrator_lock"), \
             mock.patch("watch_progress.watch_orchestrator", return_value=(2, "issue wake")) as watch, \
             mock.patch("watch_progress.sys.stdin", io.StringIO("{}")), \
             mock.patch("watch_progress.sys.stderr", stderr):
            self.assertEqual(watch_progress.main(), 2)
        watch.assert_called_once()

    def test_primary_orchestrator_setup_exception_fails_awake(self):
        stderr = io.StringIO()
        with mock.patch("watch_progress.guard_stop.current_branch", return_value="main"), \
             mock.patch("watch_progress.is_primary_checkout", side_effect=RuntimeError("boom")), \
             mock.patch("watch_progress.sys.stdin", io.StringIO("{}")), \
             mock.patch("watch_progress.sys.stderr", stderr):
            self.assertEqual(watch_progress.main(), 2)
        self.assertIn("verify orchestration state manually", stderr.getvalue())

    def test_primary_discovery_failure_fails_awake_without_a_sidecar(self):
        stderr = io.StringIO()
        with mock.patch("watch_progress.guard_stop.current_branch", return_value="main"), \
             mock.patch(
                 "watch_progress.is_primary_checkout",
                 side_effect=watch_progress.WorktreeDiscoveryError("unavailable"),
             ), \
             mock.patch("watch_progress.sys.stdin", io.StringIO("{}")), \
             mock.patch("watch_progress.sys.stderr", stderr):
            self.assertEqual(watch_progress.main(), 2)
        self.assertIn("cannot supervise", stderr.getvalue())

    def test_primary_lock_contention_is_quiet_but_lock_error_fails_awake(self):
        for outcome, expected in (("contended", 0), ("error", 2)):
            with self.subTest(outcome=outcome):
                stderr = io.StringIO()
                with mock.patch("watch_progress.guard_stop.current_branch", return_value="main"), \
                     mock.patch("watch_progress.is_primary_checkout", return_value=True), \
                     mock.patch("watch_progress.acquire_orchestrator_lock", return_value=outcome), \
                     mock.patch("watch_progress.watch_orchestrator", return_value=(2, "should not run")) as watch, \
                     mock.patch("watch_progress.sys.stdin", io.StringIO("{}")), \
                     mock.patch("watch_progress.sys.stderr", stderr):
                    self.assertEqual(watch_progress.main(), expected)
                watch.assert_not_called()
                if outcome == "error":
                    self.assertIn("lock", stderr.getvalue())


class PerIssueDualClockTest(unittest.TestCase):
    def test_per_issue_watch_wakes_after_suspend_wall_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp)
            write_state(proj, "13", PARTIAL)
            clock = DualClock(wall_step=120, monotonic_step=0)
            code, _ = watch_progress.watch(
                str(proj), "13", interval=60, stale_after=120, max_runtime=9999,
                sleep_fn=clock.sleep, monotonic_fn=clock.monotonic_now,
                wall_fn=clock.wall_now,
            )
        self.assertEqual(code, 2)

    def test_per_issue_rollback_then_suspension_keeps_earlier_idle_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp)
            write_state(proj, "13", PARTIAL)
            clock = DualClock(wall_step=-120, monotonic_step=60)

            def suspend_after_rollback(iteration):
                if iteration == 1:
                    clock.wall_step = 120
                    clock.monotonic_step = 0

            clock.on_sleep = suspend_after_rollback
            code, _ = watch_progress.watch(
                str(proj), "13", interval=60, stale_after=180, max_runtime=9999,
                sleep_fn=clock.sleep, monotonic_fn=clock.monotonic_now,
                wall_fn=clock.wall_now,
            )
        self.assertEqual(code, 2)
        self.assertEqual(clock.sleeps, 2)


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
