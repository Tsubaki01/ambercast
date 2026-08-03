#!/usr/bin/env python3
"""asyncRewake watchdog: revive the /implement flow when teammates go idle.

Upstream Claude Code bug family around teammates going idle and never
resuming (anthropics/claude-code#23415, tmux-backend inbox variant,
closed stale without a fix; #29163 duplicate; we hit an in-process
variant where a background completion never re-wakes the teammate): no
turn ever starts, so the Stop-hook guard (guard_stop.py, which fires at
turn end) cannot reach it. The only documented mechanism that
force-wakes an idle session is an asyncRewake hook exiting with code 2,
and a SendMessage from the lead re-engages an idle in-process teammate
("idle rows are hidden, not stopped") — empirically 100% here.

This script is registered as an async Stop hook with asyncRewake: true.
It outlives the turn that armed it: while the branch's flow stays active
it polls the same progress digest as guard_stop.py; once nothing moves
for the stale window it exits 2, force-waking the (possibly idle) lead
with instructions to re-engage teammates via SendMessage. It ends quietly
(exit 0) when the flow completes, pauses, or disappears.

Knobs (environment):
- AMBERCAST_WATCHDOG=0            kill switch
- AMBERCAST_WATCHDOG_INTERVAL_SEC     poll interval (default 60)
- AMBERCAST_WATCHDOG_STALE_SEC        no-progress window before the wake
                                      (default 720 = 12 min)
- AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC  process lifetime ceiling; on expiry
                                      it wakes once to re-arm (default
                                      20000, safely under the hook timeout)

A pidfile (.claude/impl/.watchdog-issue-<N>.pid) keeps one watchdog per
issue: every turn end tries to arm one, and extras yield to a live lock.
"""
import fcntl
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import guard_stop  # noqa: E402

DEFAULT_INTERVAL_SEC = 60.0
DEFAULT_STALE_SEC = 720.0
DEFAULT_MAX_RUNTIME_SEC = 20000.0
# Keep the process lifetime safely under the 21600s hook timeout so the
# re-arm wake always fires before the runner kills the process.
MAX_RUNTIME_CEILING_SEC = 21000.0

# Open file descriptors of locks this process holds, keyed by lock path.
# flock ties the lock to the descriptor: the kernel releases it the moment
# the process dies, so a crashed watchdog can never wedge future arming.
_HELD_LOCKS = {}


def lock_path(proj, issue):
    return os.path.join(proj, ".claude", "impl", f".watchdog-issue-{issue}.pid")


def acquire_lock(proj, issue):
    """Take the per-issue watchdog lock atomically (flock, non-blocking).

    flock removes the check-then-write race between two hook processes,
    is immune to pid reuse (the pidfile content is informational only),
    and self-releases when the holder dies.
    """
    path = lock_path(proj, issue)
    if path in _HELD_LOCKS:
        return False
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        return False
    try:
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
    except OSError:
        pass
    _HELD_LOCKS[path] = fd
    return True


def release_lock(proj, issue):
    # The pidfile stays behind on purpose: reusing one path keeps every
    # contender flocking the same inode (removing it would let two
    # processes lock different inodes of the same path).
    fd = _HELD_LOCKS.pop(lock_path(proj, issue), None)
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def _read_state(proj, issue):
    path = os.path.join(proj, ".claude", "impl", f"issue-{issue}.state")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def _stale_message(issue, elapsed, nxt):
    minutes = max(1, int(elapsed // 60))
    key, desc = nxt
    return (
        f"watchdog: /implement flow for issue {issue} has made no progress "
        f"for {minutes} minutes; next step is {key} ({desc}). Teammates may "
        "be idle without a wake-up (upstream claude-code#23415 family). "
        "Check Codex jobs and teammate status, re-engage idle teammates by "
        "name via SendMessage (idle teammates are hidden, not stopped); if "
        "one stays unresponsive, surface it to the maintainer. Then continue "
        "the flow. To pause intentionally, append `paused=true` to "
        f".claude/impl/issue-{issue}.state."
    )


def _rearm_message(issue):
    return (
        f"watchdog: max runtime reached while the /implement flow for issue "
        f"{issue} is still active and progressing. This wake only re-arms "
        "the watchdog — end the turn normally and a fresh watchdog will "
        "start at the next turn end."
    )


def watch(proj, issue, interval, stale_after, max_runtime,
          sleep_fn=time.sleep, now_fn=time.monotonic):
    """Poll the flow until it stalls, finishes, or the runtime expires.

    Returns (exit_code, message): (2, wake text) to force-wake the lead,
    (0, "") to end quietly. Injectable clock/sleep keep tests deterministic.
    """
    start = now_fn()
    last_change = start
    digest = guard_stop.progress_hash(proj, issue)
    while True:
        sleep_fn(interval)
        now = now_fn()

        # The checkout may have moved on (merge done, next issue). A
        # resolvable branch that no longer maps to the watched issue ends
        # the watch; an unresolvable one (detached HEAD mid-rebase, git
        # hiccup) is tolerated so a transient state cannot kill it.
        branch = guard_stop.current_branch(proj)
        if branch is not None and guard_stop.issue_from_branch(branch) != issue:
            return 0, ""

        state = _read_state(proj, issue)
        if state is None or guard_stop.is_paused(state):
            return 0, ""
        nxt = guard_stop.first_incomplete(state)
        if nxt is None:
            return 0, ""

        new_digest = guard_stop.progress_hash(proj, issue)
        if new_digest != digest:
            digest = new_digest
            last_change = now

        if now - last_change >= stale_after:
            return 2, _stale_message(issue, now - last_change, nxt)
        if now - start >= max_runtime:
            return 2, _rearm_message(issue)


def _env_float(name, default):
    """Env override, accepted only when finite and positive."""
    try:
        value = float(os.environ.get(name, ""))
    except (ValueError, TypeError):
        return default
    if not math.isfinite(value) or value <= 0:
        return default
    return value


def clamp_max_runtime(value):
    return min(value, MAX_RUNTIME_CEILING_SEC)


def main():
    try:
        try:
            data = json.load(sys.stdin)
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        if os.environ.get("AMBERCAST_WATCHDOG") == "0":
            return 0
        proj = (
            os.environ.get("CLAUDE_PROJECT_DIR")
            or data.get("cwd")
            or os.getcwd()
        )
        branch = guard_stop.current_branch(proj)
        if not branch:
            return 0
        issue = guard_stop.issue_from_branch(branch)
        if issue is None:
            return 0
        state = _read_state(proj, issue)
        if (
            state is None
            or guard_stop.is_paused(state)
            or guard_stop.first_incomplete(state) is None
        ):
            return 0

        if not acquire_lock(proj, issue):
            return 0
        try:
            code, message = watch(
                proj, issue,
                interval=_env_float(
                    "AMBERCAST_WATCHDOG_INTERVAL_SEC", DEFAULT_INTERVAL_SEC
                ),
                stale_after=_env_float(
                    "AMBERCAST_WATCHDOG_STALE_SEC", DEFAULT_STALE_SEC
                ),
                max_runtime=clamp_max_runtime(_env_float(
                    "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC",
                    DEFAULT_MAX_RUNTIME_SEC,
                )),
            )
        finally:
            release_lock(proj, issue)
        if message:
            print(message, file=sys.stderr)
        return code
    except Exception:
        # Fail open: a broken watchdog must never crash the Stop event or
        # spam wakes — worst case we are back to manual supervision.
        return 0


if __name__ == "__main__":
    sys.exit(main())
