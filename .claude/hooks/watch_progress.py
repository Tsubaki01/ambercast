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
An issue worktree polls its own progress digest. A primary checkout instead
discovers every active issue worktree and gives each target an independent
digest and stale deadline, keyed by `(realpath(worktree), branch)`, so activity
on one issue cannot mask another and stacked layers remain independent.
Once a target makes no progress for its stale window the hook exits 2,
force-waking the (possibly idle) lead with instructions to re-engage teammates
via SendMessage. It ends quietly (exit 0) when the relevant flow completes,
pauses, or disappears; a primary checkout likewise ends when there are no
active targets to supervise.

Both watchdog modes add the larger of each poll's monotonic delta and
nonnegative wall-clock delta. macOS pauses the monotonic source while a
machine sleeps, whereas wall time continues, so this detects an already-stale
flow directly after resume. Persisting the target's progress, observation, and
accumulated timing state lets a re-armed orchestrator retain this invariant
without trusting a process-local monotonic reading. A wall-clock rollback
never advances a single delta, but cannot erase earlier accumulated time.

Knobs (environment):
- AMBERCAST_WATCHDOG=0            kill switch
- AMBERCAST_WATCHDOG_INTERVAL_SEC     poll interval (default 60)
- AMBERCAST_WATCHDOG_STALE_SEC        no-progress window before the wake
                                      (default 720 = 12 min)
- AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC  process lifetime ceiling; on expiry
                                      it wakes once to re-arm (default
                                      20000, safely under the hook timeout)

A pidfile (.claude/impl/.watchdog-issue-<N>.pid) keeps one watchdog per
issue. The primary checkout uses its own `.watchdog-orchestrator.pid` lock and
a best-effort `.watchdog-orchestrator.json` sidecar. That sidecar remembers the
latest successful active-target snapshot separately from per-digest wake
backoff, atomically prunes targets no longer active, and resets a target's
backoff when its digest changes. Within one watcher process, a target omitted
by a successful list remains in memory until it returns or the watcher ends,
so a transient enumeration gap cannot reset its accumulated idle clock. An
interrupted worktree listing therefore cannot silently erase known work: a
known snapshot makes an initial listing failure wake immediately, while a
running watcher tolerates only three consecutive failures before it wakes. A
successful empty listing clears the snapshot and ends the watcher quietly.
"""
import errno
import fcntl
import json
import math
import os
import subprocess
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
ORCHESTRATOR_BACKOFF_SEC = (12 * 60, 24 * 60, 48 * 60, 60 * 60)
ORCHESTRATOR_SIDECAR_VERSION = 2
MAX_DISCOVERY_FAILURES = 3
LOCK_ACQUIRED = "acquired"
LOCK_CONTENDED = "contended"
LOCK_ERROR = "error"

# Open file descriptors of locks this process holds, keyed by lock path.
# flock ties the lock to the descriptor: the kernel releases it the moment
# the process dies, so a crashed watchdog can never wedge future arming.
_HELD_LOCKS = {}

# Orchestrator retry intervals start at the normal stale window, then apply the
# larger of that setting and the fixed 12/24/48/60-minute schedule after
# same-digest wakes. The v2 sidecar keeps only wall-readable observations and
# accumulated time: monotonic values are process-local and therefore reset when
# a fresh hook process is armed.


def lock_path(proj, issue):
    return os.path.join(proj, ".claude", "impl", f".watchdog-issue-{issue}.pid")


def orchestrator_lock_path(proj):
    return os.path.join(proj, ".claude", "impl", ".watchdog-orchestrator.pid")


def orchestrator_sidecar_path(proj):
    return os.path.join(proj, ".claude", "impl", ".watchdog-orchestrator.json")


def _acquire_lock_path(path):
    """Return a tri-state result for one non-blocking advisory lock attempt.

    A competing live watchdog is routine contention, while filesystem and
    flock errors make primary orchestration unknowable. Callers intentionally
    choose different policies for those two cases.
    """
    if path in _HELD_LOCKS:
        return LOCK_CONTENDED
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    except OSError:
        return LOCK_ERROR
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        try:
            os.close(fd)
        except OSError:
            pass
        if exc.errno in {errno.EACCES, errno.EAGAIN}:
            return LOCK_CONTENDED
        return LOCK_ERROR
    try:
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
    except OSError:
        pass
    _HELD_LOCKS[path] = fd
    return LOCK_ACQUIRED


def _release_lock_path(path):
    """Release only this process's descriptor while retaining the lock inode."""
    fd = _HELD_LOCKS.pop(path, None)
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass


def acquire_lock(proj, issue):
    """Take the per-issue watchdog lock atomically (flock, non-blocking).

    flock removes the check-then-write race between two hook processes,
    is immune to pid reuse (the pidfile content is informational only),
    and self-releases when the holder dies.
    """
    return _acquire_lock_path(lock_path(proj, issue)) == LOCK_ACQUIRED


def release_lock(proj, issue):
    # The pidfile stays behind on purpose: reusing one path keeps every
    # contender flocking the same inode (removing it would let two
    # processes lock different inodes of the same path).
    _release_lock_path(lock_path(proj, issue))


def acquire_orchestrator_lock(proj):
    """Return the primary lock's acquired/contended/error result."""
    return _acquire_lock_path(orchestrator_lock_path(proj))


def release_orchestrator_lock(proj):
    """Release the primary-checkout-wide orchestrator lock."""
    _release_lock_path(orchestrator_lock_path(proj))


def _read_state(proj, issue):
    path = os.path.join(proj, ".claude", "impl", f"issue-{issue}.state")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


class WorktreeDiscoveryError(RuntimeError):
    """A listing cannot distinguish an empty worktree set from an outage."""


VALUELESS_WORKTREE_ATTRIBUTES = {"bare", "detached", "locked"}


def parse_worktree_porcelain(payload, nul):
    """Parse Git's record-oriented worktree output without shell splitting."""
    if isinstance(payload, bytes):
        try:
            payload = payload.decode("utf-8", errors="surrogateescape")
        except UnicodeError as exc:
            raise WorktreeDiscoveryError("unreadable worktree listing") from exc
    if not isinstance(payload, str):
        raise WorktreeDiscoveryError("invalid worktree listing")
    if not payload:
        # `git worktree list` always reports the primary worktree. Empty output
        # therefore means a broken command or transport, never an empty set.
        raise WorktreeDiscoveryError("empty worktree listing")
    separator = "\0\0" if nul else "\n\n"
    if not payload.endswith(separator):
        raise WorktreeDiscoveryError("truncated worktree listing")
    chunks = [chunk for chunk in payload.split(separator) if chunk]
    records = []
    paths = set()
    for chunk in chunks:
        fields = chunk.split("\0" if nul else "\n")
        record = {}
        for field in fields:
            if not field:
                continue
            key, sep, value = field.partition(" ")
            if key in record:
                raise WorktreeDiscoveryError("malformed worktree listing")
            if not sep and key not in VALUELESS_WORKTREE_ATTRIBUTES:
                raise WorktreeDiscoveryError("malformed worktree listing")
            record[key] = value
        path = record.get("worktree")
        if not path or path in paths:
            raise WorktreeDiscoveryError("malformed worktree listing")
        paths.add(path)
        branch = record.get("branch")
        if branch and branch.startswith("refs/heads/"):
            branch = branch[len("refs/heads/"):]
        elif branch:
            raise WorktreeDiscoveryError("malformed worktree branch")
        records.append({"path": path, "branch": branch})
    return records


def list_worktrees(proj):
    """List every worktree, retrying plain porcelain for old Git clients."""
    commands = (
        (["git", "-C", proj, "worktree", "list", "--porcelain", "-z"], True),
        (["git", "-C", proj, "worktree", "list", "--porcelain"], False),
    )
    errors = []
    for command, nul in commands:
        try:
            result = subprocess.run(command, capture_output=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as exc:
            errors.append(str(exc))
            continue
        if result.returncode:
            errors.append("git worktree list failed")
            continue
        try:
            return parse_worktree_porcelain(result.stdout, nul=nul)
        except WorktreeDiscoveryError as exc:
            errors.append(str(exc))
            break
    raise WorktreeDiscoveryError(errors[-1] if errors else "worktree listing failed")


def is_primary_checkout(proj):
    """Whether this directory is the first (primary) Git worktree."""
    records = list_worktrees(proj)
    return bool(records) and os.path.realpath(records[0]["path"]) == os.path.realpath(proj)


def _target_key(target):
    return os.path.realpath(target["path"]), target["branch"]


def discover_active_targets(proj):
    """Return only active issue flows discovered from actual worktree branches."""
    targets = []
    keys = set()
    for record in list_worktrees(proj):
        branch = record.get("branch")
        issue = guard_stop.issue_from_branch(branch) if branch else None
        if issue is None:
            continue
        path = os.path.realpath(record["path"])
        state = _read_state(path, issue)
        if (
            state is None
            or guard_stop.is_paused(state)
            or guard_stop.first_incomplete(state) is None
        ):
            continue
        target = {"path": path, "branch": branch, "issue": issue}
        key = _target_key(target)
        if key in keys:
            raise WorktreeDiscoveryError("duplicate active worktree")
        keys.add(key)
        targets.append(target)
    return targets


def _empty_orchestrator_sidecar():
    return {"version": ORCHESTRATOR_SIDECAR_VERSION, "activeTargets": [], "backoff": []}


def _finite_nonnegative(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def load_orchestrator_sidecar(proj):
    """Load only a complete, versioned primary-watchdog snapshot."""
    try:
        with open(orchestrator_sidecar_path(proj), encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError):
        return _empty_orchestrator_sidecar()
    if (
        not isinstance(payload, dict)
        or payload.get("version") != ORCHESTRATOR_SIDECAR_VERSION
        or not isinstance(payload.get("activeTargets"), list)
        or not isinstance(payload.get("backoff"), list)
    ):
        return _empty_orchestrator_sidecar()
    active = []
    backoff = []
    try:
        for item in payload["activeTargets"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item["path"], str)
                or not isinstance(item["branch"], str)
                or not isinstance(item["digest"], str)
                or not _finite_nonnegative(item["lastProgressWall"])
                or not _finite_nonnegative(item["lastObservedWall"])
                or not _finite_nonnegative(item["idleSeconds"])
            ):
                raise ValueError
            active.append(dict(item))
        for item in payload["backoff"]:
            if (
                not isinstance(item, dict)
                or not isinstance(item["path"], str)
                or not isinstance(item["branch"], str)
                or not isinstance(item["digest"], str)
                or not _finite_nonnegative(item["lastWakeWall"])
                or not _finite_nonnegative(item["backoffIdleSeconds"])
                or not isinstance(item["unchangedWakeCount"], int)
                or isinstance(item["unchangedWakeCount"], bool)
                or item["unchangedWakeCount"] < 0
            ):
                raise ValueError
            backoff.append(dict(item))
    except (KeyError, ValueError):
        return _empty_orchestrator_sidecar()
    return {"version": ORCHESTRATOR_SIDECAR_VERSION, "activeTargets": active, "backoff": backoff}


def persist_orchestrator_sidecar(proj, payload):
    """Atomically replace primary watchdog state without making I/O fatal."""
    try:
        os.makedirs(os.path.dirname(orchestrator_sidecar_path(proj)), exist_ok=True)
    except OSError:
        return False
    return guard_stop._persist_sidecar(orchestrator_sidecar_path(proj), payload)


def _persist_orchestrator_sidecar_or_warn(proj, payload):
    """Keep watching after best-effort persistence loses re-arm precision."""
    if not persist_orchestrator_sidecar(proj, payload):
        print(
            "watchdog warning: orchestrator sidecar persistence failed; "
            "a later re-arm may restart its backoff timing.",
            file=sys.stderr,
        )


def orchestrator_stale_after(stale_after, unchanged_wake_count):
    """Return the current per-target deadline after unchanged stale wakes."""
    if unchanged_wake_count <= 0:
        return stale_after
    schedule = ORCHESTRATOR_BACKOFF_SEC[
        min(unchanged_wake_count - 1, len(ORCHESTRATOR_BACKOFF_SEC) - 1)
    ]
    return max(stale_after, schedule)


def _clock_delta(now_monotonic, previous_monotonic, now_wall, previous_wall):
    """Return one rollback-safe elapsed increment across suspension.

    Accumulating increments, instead of comparing every poll to an old wall
    baseline, means a rollback cannot hide a later suspended interval while the
    wall clock climbs back to its original value.
    """
    return max(
        0.0,
        now_monotonic - previous_monotonic,
        max(0.0, now_wall - previous_wall),
    )


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


# Single-issue and orchestrator loops accept separate monotonic and wall clock
# callables. Keeping them injectable makes suspended-host and rollback
# cases deterministic without slow integration tests.
def watch(proj, issue, interval, stale_after, max_runtime, sleep_fn=time.sleep,
          monotonic_fn=time.monotonic, wall_fn=time.time):
    """Poll the flow until it stalls, finishes, or the runtime expires.

    Returns (exit_code, message): (2, wake text) to force-wake the lead,
    (0, "") to end quietly. Injectable clock/sleep keep tests deterministic.
    """
    start_monotonic = monotonic_fn()
    start_wall = wall_fn()
    last_poll_monotonic = start_monotonic
    last_poll_wall = start_wall
    idle = 0.0
    runtime = 0.0
    digest = guard_stop.progress_hash(proj, issue)
    while True:
        sleep_fn(interval)
        now_monotonic = monotonic_fn()
        now_wall = wall_fn()
        delta = _clock_delta(
            now_monotonic, last_poll_monotonic, now_wall, last_poll_wall
        )
        last_poll_monotonic = now_monotonic
        last_poll_wall = now_wall
        runtime += delta

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
            idle = 0.0
        else:
            idle += delta
        if idle >= stale_after:
            return 2, _stale_message(issue, idle, nxt)
        if runtime >= max_runtime:
            return 2, _rearm_message(issue)


def _orchestrator_error_message():
    return "watchdog error — verify orchestration state manually."


def _orchestrator_lock_message():
    return (
        "watchdog error — the orchestrator lock could not be acquired; "
        "verify orchestration state manually."
    )


def _orchestrator_listing_message():
    return (
        "watchdog: worktree listing failed and the orchestrator cannot supervise "
        "known active flows; verify orchestration state manually."
    )


def _orchestrator_stale_message(stale_targets):
    listed = ", ".join(
        f"{target['branch']} ({max(1, int(elapsed // 60))} minutes)"
        for target, elapsed in stale_targets
    )
    return (
        f"watchdog: active flows are stale: {listed}. Do not decide that no action "
        "is required from this notification alone; verify live state first. Run `gh "
        "pr list --json number,headRefName,isDraft,mergeable,mergeStateStatus,"
        "reviewDecision,statusCheckRollup,url` to inspect every open PR; use `gh pr "
        "checks` and unresolved review threads when needed. Directly inspect each "
        "worktree's `.claude/impl/issue-<N>.state` and `git status`. Re-engage each "
        "idle teammate by name with SendMessage; report a teammate that does not "
        "respond to the maintainer. To pause intentionally, append `paused=true` to "
        "that issue's state file."
    )


def _orchestrator_rearm_message():
    return (
        "watchdog: max runtime reached while orchestrator mode still has active "
        "flows. This wake re-arms the orchestrator watchdog at the next turn end."
    )


def _snapshot_payload(targets, states):
    active = []
    backoff = []
    for target in targets:
        path, branch = _target_key(target)
        state = states[(path, branch)]
        active.append({
            "path": path,
            "branch": branch,
            "digest": state["digest"],
            "lastProgressWall": state["lastProgressWall"],
            "lastObservedWall": state["lastObservedWall"],
            "idleSeconds": state["idleSeconds"],
        })
        if state["unchangedWakeCount"]:
            backoff.append({
                "path": path,
                "branch": branch,
                "digest": state["digest"],
                "lastWakeWall": state["lastWakeWall"],
                "backoffIdleSeconds": state["backoffIdleSeconds"],
                "unchangedWakeCount": state["unchangedWakeCount"],
            })
    return {
        "version": ORCHESTRATOR_SIDECAR_VERSION,
        "activeTargets": active,
        "backoff": backoff,
    }


def _initial_orchestrator_states(targets, monotonic, wall, hash_fn, previous):
    prior_active = {
        (os.path.realpath(item["path"]), item["branch"]): item
        for item in previous["activeTargets"]
    }
    prior_backoff = {
        (os.path.realpath(item["path"]), item["branch"]): item
        for item in previous["backoff"]
    }
    states = {}
    for target in targets:
        key = _target_key(target)
        digest = hash_fn(target["path"], target["issue"])
        prior_progress = prior_active.get(key)
        if prior_progress and prior_progress["digest"] == digest:
            gap = max(0.0, wall - prior_progress["lastObservedWall"])
            idle = prior_progress["idleSeconds"] + gap
            last_progress_wall = prior_progress["lastProgressWall"]
        else:
            gap = 0.0
            idle = 0.0
            last_progress_wall = wall
        prior_wake = prior_backoff.get(key)
        if prior_wake and prior_wake["digest"] == digest:
            count = prior_wake["unchangedWakeCount"]
            last_wake = prior_wake["lastWakeWall"]
            # The direct wall comparison carries a process gap when no poll
            # ran, while the accumulated value preserves rollback-safe time.
            backoff_idle = max(
                prior_wake["backoffIdleSeconds"] + gap,
                max(0.0, wall - last_wake),
            )
        else:
            count = 0
            last_wake = None
            backoff_idle = 0.0
        states[key] = {
            "digest": digest,
            "lastProgressMonotonic": monotonic,
            "lastProgressWall": last_progress_wall,
            "lastObservedMonotonic": monotonic,
            "lastObservedWall": wall,
            "idleSeconds": idle,
            "lastWakeWall": last_wake,
            "backoffIdleSeconds": backoff_idle,
            "unchangedWakeCount": count,
        }
    return states


def _advance_orchestrator_state(state, monotonic, wall):
    """Accumulate one target's safe elapsed increment and refresh its clocks."""
    delta = _clock_delta(
        monotonic, state["lastObservedMonotonic"], wall, state["lastObservedWall"]
    )
    state["lastObservedMonotonic"] = monotonic
    state["lastObservedWall"] = wall
    state["idleSeconds"] += delta
    if state["lastWakeWall"] is not None:
        state["backoffIdleSeconds"] += delta


def watch_orchestrator(proj, interval, stale_after, max_runtime,
                       sleep_fn=time.sleep, monotonic_fn=time.monotonic,
                       wall_fn=time.time, discover_fn=None,
                       hash_fn=guard_stop.progress_hash):
    """Watch each active worktree independently from the primary checkout."""
    discover_fn = discover_fn or (lambda: discover_active_targets(proj))
    previous = load_orchestrator_sidecar(proj)
    start_monotonic = monotonic_fn()
    start_wall = wall_fn()
    last_runtime_monotonic = start_monotonic
    last_runtime_wall = start_wall
    runtime = 0.0
    try:
        targets = discover_fn()
    except WorktreeDiscoveryError:
        return 2, _orchestrator_listing_message()
    if not targets:
        _persist_orchestrator_sidecar_or_warn(proj, _empty_orchestrator_sidecar())
        return 0, ""
    states = _initial_orchestrator_states(
        targets, start_monotonic, start_wall, hash_fn, previous
    )
    # The persisted snapshot intentionally contains only currently active
    # targets. Retaining omitted states in this process bridges a successful
    # but transient enumeration gap without resurrecting removed work after a
    # later re-arm.
    missing_states = {}
    _persist_orchestrator_sidecar_or_warn(proj, _snapshot_payload(targets, states))
    discovery_failures = 0
    while True:
        sleep_fn(interval)
        now_monotonic = monotonic_fn()
        now_wall = wall_fn()
        runtime += _clock_delta(
            now_monotonic, last_runtime_monotonic, now_wall, last_runtime_wall
        )
        last_runtime_monotonic = now_monotonic
        last_runtime_wall = now_wall
        try:
            targets = discover_fn()
        except WorktreeDiscoveryError:
            discovery_failures += 1
            if discovery_failures > MAX_DISCOVERY_FAILURES:
                return 2, _orchestrator_listing_message()
            continue
        discovery_failures = 0
        if not targets:
            _persist_orchestrator_sidecar_or_warn(proj, _empty_orchestrator_sidecar())
            return 0, ""

        active_keys = {_target_key(target) for target in targets}
        for key, state in states.items():
            if key not in active_keys:
                missing_states[key] = state
        next_states = {}
        for target in targets:
            key = _target_key(target)
            digest = hash_fn(target["path"], target["issue"])
            state = states.get(key)
            if state is None:
                state = missing_states.pop(key, None)
            if state is None:
                prior = _initial_orchestrator_states(
                    [target], now_monotonic, now_wall, hash_fn, previous
                )
                state = prior[key]
            elif state["digest"] != digest:
                state = dict(state)
                state.update({
                    "digest": digest,
                    "lastProgressMonotonic": now_monotonic,
                    "lastProgressWall": now_wall,
                    "lastObservedMonotonic": now_monotonic,
                    "lastObservedWall": now_wall,
                    "idleSeconds": 0.0,
                    "lastWakeWall": None,
                    "backoffIdleSeconds": 0.0,
                    "unchangedWakeCount": 0,
                })
            else:
                state = dict(state)
                _advance_orchestrator_state(state, now_monotonic, now_wall)
            next_states[key] = state
        states = next_states

        stale = []
        for target in targets:
            state = states[_target_key(target)]
            waiting = (
                state["backoffIdleSeconds"]
                if state["unchangedWakeCount"]
                else state["idleSeconds"]
            )
            if waiting >= orchestrator_stale_after(
                stale_after, state["unchangedWakeCount"]
            ):
                stale.append((target, state["idleSeconds"]))
        if stale:
            for target, _ in stale:
                state = states[_target_key(target)]
                state["lastWakeWall"] = now_wall
                state["backoffIdleSeconds"] = 0.0
                state["unchangedWakeCount"] += 1
            _persist_orchestrator_sidecar_or_warn(proj, _snapshot_payload(targets, states))
            return 2, _orchestrator_stale_message(stale)
        _persist_orchestrator_sidecar_or_warn(proj, _snapshot_payload(targets, states))
        if runtime >= max_runtime:
            return 2, _orchestrator_rearm_message()


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


def _watch_config():
    return {
        "interval": _env_float("AMBERCAST_WATCHDOG_INTERVAL_SEC", DEFAULT_INTERVAL_SEC),
        "stale_after": _env_float("AMBERCAST_WATCHDOG_STALE_SEC", DEFAULT_STALE_SEC),
        "max_runtime": clamp_max_runtime(_env_float(
            "AMBERCAST_WATCHDOG_MAX_RUNTIME_SEC", DEFAULT_MAX_RUNTIME_SEC,
        )),
    }


def _print_message(message):
    if message:
        print(message, file=sys.stderr)


def main():
    """Arm an issue watchdog or the primary-checkout orchestrator watchdog."""
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
        if issue is not None:
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
                code, message = watch(proj, issue, **_watch_config())
            finally:
                release_lock(proj, issue)
            _print_message(message)
            return code

        try:
            primary = is_primary_checkout(proj)
        except WorktreeDiscoveryError:
            _print_message(_orchestrator_listing_message())
            return 2
        except Exception:
            _print_message(_orchestrator_error_message())
            return 2
        if not primary:
            return 0
        lock_result = acquire_orchestrator_lock(proj)
        if lock_result == LOCK_CONTENDED:
            return 0
        if lock_result != LOCK_ACQUIRED:
            _print_message(_orchestrator_lock_message())
            return 2
        try:
            code, message = watch_orchestrator(proj, **_watch_config())
        except Exception:
            _print_message(_orchestrator_error_message())
            return 2
        finally:
            release_orchestrator_lock(proj)
        _print_message(message)
        return code
    except Exception:
        # Fail open: a broken watchdog must never crash the Stop event or
        # spam wakes — worst case we are back to manual supervision.
        return 0


if __name__ == "__main__":
    sys.exit(main())
