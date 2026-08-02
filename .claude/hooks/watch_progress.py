#!/usr/bin/env python3
"""asyncRewake watchdog: revive the /implement flow when teammates go idle.

Upstream Claude Code bug family (anthropics/claude-code#23415, closed stale
without a fix): an in-process teammate waiting on background work can go
idle and never be re-woken — no turn ever starts, so the Stop-hook guard
(guard_stop.py, which fires at turn end) cannot reach it. The only
documented mechanism that force-wakes an idle session is an asyncRewake
hook exiting with code 2, and a SendMessage from the lead reliably
re-engages an idle teammate ("idle rows are hidden, not stopped").

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
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import guard_stop  # noqa: E402

DEFAULT_INTERVAL_SEC = 60.0
DEFAULT_STALE_SEC = 720.0
DEFAULT_MAX_RUNTIME_SEC = 20000.0


def lock_path(proj, issue):
    return os.path.join(proj, ".claude", "impl", f".watchdog-issue-{issue}.pid")


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def acquire_lock(proj, issue):
    """Take the per-issue watchdog lock unless a live holder exists."""
    path = lock_path(proj, issue)
    try:
        with open(path, encoding="utf-8") as f:
            holder = int(f.read().strip())
        if _pid_alive(holder):
            return False
    except (OSError, ValueError):
        pass
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except OSError:
        return False
    return True


def release_lock(proj, issue):
    path = lock_path(proj, issue)
    try:
        with open(path, encoding="utf-8") as f:
            holder = f.read().strip()
        if holder == str(os.getpid()):
            os.remove(path)
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
        "be idle without a wake-up (upstream claude-code#23415). Check Codex "
        "jobs and teammate status, re-engage idle teammates by name via "
        "SendMessage (idle teammates are hidden, not stopped), then continue "
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
    try:
        return float(os.environ.get(name, ""))
    except (ValueError, TypeError):
        return default


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
                max_runtime=_env_float(
                    "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC",
                    DEFAULT_MAX_RUNTIME_SEC,
                ),
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
