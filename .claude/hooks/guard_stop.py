#!/usr/bin/env python3
"""Stop hook: keep the /implement flow moving while steps remain.

The orchestrating agent handles background-task completion notifications
(e.g. Codex delegations) as ordinary turns; without a gate it may end the
turn right there and the 17-step flow stalls until a human nudges it.
While the current branch's state file has incomplete steps, this hook
answers the Stop event with {"decision": "block"} and names the next step,
re-anchoring the agent to the flow.

Scope and escape hatches:
- fires only when the current branch matches issues/<N> or issues/<N>-<slug>
  AND .claude/impl/issue-<N>.state exists (grammar shared with guard_git.py
  and guard_phase.py); any other branch or a detached HEAD passes through
- a session with live background work (teammate, subagent, background shell;
  Stop input `background_tasks`, v2.1.145+) may stop. Completion notifications
  can be lost while the host is suspended, so `watch_progress.py` is the
  independent watchdog backstop that eventually re-wakes an idle lead. This
  still keeps orchestrator sessions that share the branch with an implementing
  teammate from being blocked into implementing that teammate's job itself.
- `paused=true` in the state file -> allow the stop and reset the stall
  counter (intentional pause; remove the line to resume with a fresh budget)
- stall protection: .claude/impl/.guard-stop-issue-<N>.json records a
  progress digest; after MAX_STALLED_BLOCKS consecutive blocks with no
  progress the stop is allowed until progress resumes. The digest covers
  everything a working flow touches — state, todos, plan, review verdicts,
  implementation logs, and the git working tree — so only a genuinely stuck
  agent exhausts the budget. It counts only PROGRESS_ARTIFACT_SUFFIXES in the
  review and log directories, because a delegated agent's transcript is
  streamed into the review directory by the caller and would otherwise make
  every blocked turn look like progress (#210). The counter is scoped to the
  session id and persisted atomically, failing open (allow the stop) when it
  cannot be recorded.
- absolute ceiling: the same sidecar records MAX_TOTAL_BLOCKS worth of blocks
  that no amount of progress resets, so a defect in progress detection can no
  longer remove the bound. Claude Code's own consecutive-block cap
  (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, default 8) is an additional outer backstop
  there; Codex CLI has none, which is why this ceiling lives in the guard.
- kill switch: AMBERCAST_GUARD_STOP=0 disables the hook entirely

Branch evidence deliberately distinguishes detached state from unavailable policy
evidence. The shared Claude boundary remains fail-open, while the Codex adapter
observes policy probes and terminates safely when evidence is ambiguous. Evidence
required to establish repository progress cannot be empty.
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

MAX_STALLED_BLOCKS = 3

# Absolute ceiling that a moving progress digest cannot clear. MAX_STALLED_BLOCKS
# only bounds a *stationary* flow, so any defect in progress detection removes
# the bound entirely — which is what happened in issue #210: the delegation's own
# transcript sat inside the digested set, the digest moved every turn, and the
# stall counter reset 2,019 times (5h21m, 442,176,708 input tokens). This counter
# is never reset by progress; only pausing, finishing, or a different session
# starts a fresh budget. Codex CLI has no outer backstop of its own
# (openai/codex#37937 open; --max-turns, #12336, closed as not planned), so on
# that path this is the only ceiling. Kept far above MAX_STALLED_BLOCKS because a
# long healthy flow legitimately ends many turns while steps remain.
MAX_TOTAL_BLOCKS = 100

# Artifacts that represent real flow progress in the digested directories.
# An allowlist on purpose: a delegated agent's transcript is streamed into
# .claude/impl/issue-<N>-reviews/ by the *caller* (`codex exec --json` redirected
# there, `-o <file>` written there), so it grows on every blocked turn no matter
# how the model is sandboxed. Under an allowlist an unrecognised file can only
# make the guard give up earlier, never loop longer; a denylist would let the
# next transcript naming convention reintroduce issue #210.
PROGRESS_ARTIFACT_SUFFIXES = (".md",)

# Ordered step keys of the /implement flow with the one-line description used
# in the block reason. Must stay in sync with .claude/skills/implement/SKILL.md.
STEPS = [
    ("step01_issue", "create/record the GitHub issue"),
    ("step02_branch", "create the issues/<N> branch or stack layers"),
    ("step03_plan", "write the implementation plan"),
    ("step04_plan_review", "run the 7-perspective plan review"),
    ("step05_plan_revised", "fold review findings into the plan"),
    ("step06_scaffold", "create empty skeletons for every planned file"),
    ("step07_docs", "write all comments/JSDoc before any logic"),
    ("step08_docs_review", "review the commented skeletons"),
    ("step09_tests", "implement the failing test suite"),
    ("step10_tests_review", "review tests against the comment spec"),
    ("step11_code", "implement until the suite is green, then refactor"),
    ("step12_code_review", "review the implementation"),
    ("step13_push", "push the branch / stack"),
    ("step14_pr", "open the PR(s)"),
    ("step15_ci", "make CI green on every PR"),
    ("step16_coderabbit", "address the CodeRabbit review"),
    ("step17_merged", "merge via GitHub / gh stack merge"),
]

BRANCH_RE = re.compile(r"issues/([0-9]+)(?:-[a-z0-9]+)*")

# Statuses that prove a listed background task is finished. Anything else —
# including an unknown or missing status — counts as live, because merely
# being listed means the session is waiting on it.
TERMINAL_TASK_STATUSES = {
    "completed", "failed", "cancelled", "canceled", "killed", "done", "error",
}

# Task types whose completion re-invokes the session, i.e. delegated work
# it is legitimately waiting on. `shell` is included because background
# shells re-invoke on exit and are this repository's Codex delegation
# vehicle — but a never-ending shell (dev server, tail -f) would idle the
# flow forever, so SKILL.md forbids parking those mid-flow. A monitor
# watches indefinitely and cannot promise a completion wake-up, and an
# unknown type must not lift the guard (schema drift would otherwise
# silently disable it), so neither is listed.
DELEGATED_TASK_TYPES = {
    "teammate", "subagent", "workflow", "cloud session", "mcp task", "shell",
}


def _normalize_task_type(value):
    """Normalize task-type spellings before comparing them to the allowlist."""
    return " ".join(
        str(value or "").lower().replace("_", " ").replace("-", " ").split()
    )


def has_live_background(tasks):
    """True when the session is waiting on live delegated background work.

    Claude Code v2.1.145+ passes `background_tasks` in the Stop input
    precisely so hooks can distinguish "session is done" from "session is
    paused waiting for background work to wake it back up". A session with
    live delegated work (teammate, subagent, workflow, background shell)
    may stop. A completion notification normally re-wakes it, but suspension
    can lose that notification; watch_progress.py independently detects the
    resulting lack of progress. Without this allowance, an orchestrator
    sharing the branch with an implementing teammate would be blocked into
    doing the teammate's job itself.
    """
    if not isinstance(tasks, list):
        return False
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if _normalize_task_type(task.get("type")) not in DELEGATED_TASK_TYPES:
            continue
        status = str(task.get("status") or "").strip().lower()
        if status not in TERMINAL_TASK_STATUSES:
            return True
    return False


def issue_from_branch(branch):
    """Return the issue number encoded by a valid flow branch, if any."""
    m = BRANCH_RE.fullmatch(branch)
    return m.group(1) if m else None


def is_done(state, key):
    """Return whether a state file marks the named implementation step done."""
    return bool(re.search(rf"^{key}=done\s*$", state, re.M))


def is_paused(state):
    """Return whether a state file explicitly permits the flow to pause."""
    return bool(re.search(r"^paused=true\s*$", state, re.M))


def first_incomplete(state):
    """Return the earliest unfinished flow step and its human-facing description."""
    for key, desc in STEPS:
        if not is_done(state, key):
            return key, desc
    return None


def last_completed(state):
    """Last step of the contiguous completed prefix.

    Gapped states (a later step marked done while an earlier one is not)
    must not be reported as "last completed" — that would contradict the
    "next step" guidance, which always points at the first gap.
    """
    last = None
    for key, _ in STEPS:
        if not is_done(state, key):
            break
        last = key
    return last


def sidecar_path(proj, issue):
    """Return the per-issue stall-counter path inside this worktree."""
    return os.path.join(proj, ".claude", "impl", f".guard-stop-issue-{issue}.json")


def verified_impl_directory(proj):
    """Return the physical implementation-state directory when it is safe.

    State and stall bookkeeping share this parent, so accepting a symlink at
    the boundary would redirect reads, atomic replacements, and cleanup outside
    the worktree. A missing directory retains the ordinary no-state behavior;
    an existing path must resolve to its literal directory beneath the physical
    repository root.
    """
    root = os.path.realpath(proj)
    impl = os.path.join(root, ".claude", "impl")
    if not os.path.lexists(impl):
        return None
    if os.path.islink(impl) or not os.path.isdir(impl):
        raise ValueError("invalid implementation state directory")
    physical = os.path.realpath(impl)
    if physical != impl or os.path.commonpath((root, physical)) != root:
        raise ValueError("invalid implementation state directory")
    return impl


def _hash_file(h, path):
    """Add file content, or an empty marker when the artifact is unavailable."""
    try:
        with open(path, "rb") as f:
            h.update(f.read())
    except OSError:
        pass
    h.update(b"\0")


def _hash_dir_listing(h, directory):
    """Add directory metadata without reading append-mostly artifact content."""
    # Name + size + mtime is enough of a signal for append-mostly artifacts
    # (review verdicts, implementation logs) without hashing their content.
    # Only PROGRESS_ARTIFACT_SUFFIXES are digested: a delegation transcript
    # shares these directories and would otherwise count as progress (#210).
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(PROGRESS_ARTIFACT_SUFFIXES):
            continue
        try:
            st = os.stat(os.path.join(directory, name))
        except OSError:
            continue
        h.update(f"{name}:{st.st_size}:{st.st_mtime_ns}".encode())
    h.update(b"\0")


def _git_stdout(proj, args):
    """Run a bounded Git query and return empty bytes when it cannot complete."""
    # A guard hook must not hang or crash on a broken git: bound every call
    # and treat any failure as "no output" so the hook stays fail-open.
    try:
        res = subprocess.run(
            ["git", "-C", proj, *args],
            capture_output=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return b""
    return res.stdout if res.returncode == 0 else b""


def _hash_git(h, proj):
    """Add the Git changes that constitute implementation-flow progress."""
    # Tracked-file edits show up in the diff against HEAD; brand-new files
    # show up as untracked paths, hashed with their stat so ongoing edits to
    # them keep counting as progress. Outside a git repo these commands fail
    # and contribute nothing, which is fine — the flow always runs in one.
    for args in (["rev-parse", "HEAD"], ["diff", "HEAD"]):
        h.update(_git_stdout(proj, args))
        h.update(b"\0")
    out = _git_stdout(proj, ["ls-files", "--others", "--exclude-standard"])
    for line in out.decode(errors="replace").splitlines():
        # .claude/ artifacts (state, todos, plan, logs) are already hashed
        # explicitly above — and the stall sidecar lives there too, so
        # including them here would let the guard's own bookkeeping count
        # as progress and defeat the stall detection.
        if line.startswith(".claude/"):
            continue
        try:
            st = os.stat(os.path.join(proj, line))
        except OSError:
            continue
        h.update(f"{line}:{st.st_size}:{st.st_mtime_ns}".encode())
    h.update(b"\0")


def progress_hash(proj, issue):
    """Digest of everything that moves while the flow makes real progress."""
    h = hashlib.sha256()
    impl = os.path.join(proj, ".claude", "impl")
    _hash_file(h, os.path.join(impl, f"issue-{issue}.state"))
    _hash_file(h, os.path.join(impl, f"issue-{issue}-plan.md"))
    for path in sorted(
        glob.glob(os.path.join(proj, ".claude", "todos", f"issue-{issue}-*.md"))
    ):
        _hash_file(h, path)
    _hash_dir_listing(h, os.path.join(impl, f"issue-{issue}-reviews"))
    _hash_dir_listing(h, os.path.join(proj, ".claude", "logs"))
    _hash_git(h, proj)
    return h.hexdigest()


def _counter(value):
    """Read a persisted counter, treating anything but a non-negative int as 0.

    The sidecar is an ordinary file in a directory agents write to, so a bad
    value must never buy extra blocks: `int(-100)` would allow 200 more blocks
    before MAX_TOTAL_BLOCKS is reached, and a large enough negative would
    remove the ceiling outright. `type(...) is int` rather than isinstance() so
    that booleans, which are ints in Python, do not count either.
    """
    return value if type(value) is int and value >= 0 else 0


def _load_sidecar(side):
    """Load a valid stall-counter sidecar, treating malformed data as absent."""
    try:
        with open(side, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, ValueError):
        return {}
    return prev if isinstance(prev, dict) else {}


def _persist_sidecar(side, payload):
    """Atomically store stall state, failing open when durable storage is unavailable."""
    # Atomic replace: never truncate through a symlink, never leave partial
    # JSON for a concurrent reader.
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(
            dir=os.path.dirname(side), prefix=".guard-stop-tmp-"
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, side)
        return True
    except OSError:
        if tmp is not None:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def _remove_sidecar(side):
    """Remove stale stall state without making cleanup failures observable."""
    try:
        os.remove(side)
    except OSError:
        pass


def evaluate(proj, branch, session_id=""):
    """Return the Stop block payload, or None to allow the stop.

    Updates the stall-protection sidecar as a side effect: the counter grows
    on every block, and resets when the progress digest moves, when the
    session changes, or when the flow is paused.
    """
    issue = issue_from_branch(branch)
    if issue is None:
        return None

    try:
        impl = verified_impl_directory(proj)
    except (OSError, ValueError):
        return None
    if impl is None:
        return None

    state_path = os.path.join(impl, f"issue-{issue}.state")
    try:
        with open(state_path, encoding="utf-8", errors="replace") as f:
            state = f.read()
    except OSError:
        return None

    side = os.path.join(impl, f".guard-stop-issue-{issue}.json")

    if is_paused(state):
        _remove_sidecar(side)
        return None

    nxt = first_incomplete(state)
    if nxt is None:
        _remove_sidecar(side)
        return None

    digest = progress_hash(proj, issue)
    prev = _load_sidecar(side)
    blocks = 0
    total = 0
    if prev.get("session_id", "") == session_id:
        total = _counter(prev.get("total_blocks", 0))
        if prev.get("progress_sha256") == digest:
            blocks = _counter(prev.get("consecutive_blocks", 0))

    if blocks >= MAX_STALLED_BLOCKS:
        # Stalled: the agent was pushed back repeatedly without the flow
        # advancing, so something needs a human. Let the stop through.
        return None

    if total >= MAX_TOTAL_BLOCKS:
        # The session has been pushed back this many times in total, however
        # much the progress digest moved in between. Progress detection itself
        # is no longer trustworthy here, so stop blocking rather than risk the
        # unbounded loop of #210.
        return None

    persisted = _persist_sidecar(
        side,
        {
            "progress_sha256": digest,
            "consecutive_blocks": blocks + 1,
            "total_blocks": total + 1,
            "session_id": session_id,
        },
    )
    if not persisted:
        # Without a durable counter the backoff could never advance and the
        # block would repeat forever — fail open instead.
        return None

    key, desc = nxt
    last = last_completed(state)
    reason = (
        f"/implement flow for issue {issue} is not finished: "
        f"last completed step is {last or 'none'}; next step is {key} ({desc}). "
        "Re-read .claude/skills/implement/SKILL.md and continue the flow now. "
        "To pause intentionally, append `paused=true` to "
        f".claude/impl/issue-{issue}.state."
    )
    return {"decision": "block", "reason": reason}


def current_branch(proj):
    """Return the symbolic branch for a worktree, allowing detached HEAD to pass."""
    try:
        result = subprocess.run(
            ["git", "-C", proj, "symbolic-ref", "--quiet", "--short", "HEAD"],
            capture_output=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    branch = result.stdout.decode(errors="replace").strip()
    if result.returncode == 0 and branch:
        return branch
    if result.returncode == 1 and not branch:
        return None
    return None


def main():
    """Emit a Stop block only while the active issue flow has work remaining."""
    try:
        try:
            data = json.load(sys.stdin)
        except Exception:
            return 0
        if not isinstance(data, dict):
            return 0
        if os.environ.get("AMBERCAST_GUARD_STOP") == "0":
            return 0
        if has_live_background(data.get("background_tasks")):
            return 0
        proj = (
            data.get("cwd")
            or os.environ.get("CLAUDE_PROJECT_DIR")
            or os.getcwd()
        )
        worktree_root = _git_stdout(proj, ["rev-parse", "--show-toplevel"])
        if worktree_root:
            proj = worktree_root.decode(errors="replace").strip() or proj
        branch = current_branch(proj)
        if not branch:
            return 0
        payload = evaluate(proj, branch, str(data.get("session_id") or ""))
        if payload is not None:
            print(json.dumps(payload))
        return 0
    except Exception:
        # Fail open: a broken guard must never crash the Stop event or trap
        # the agent — worst case we are back to the pre-hook behavior.
        return 0


if __name__ == "__main__":
    sys.exit(main())
