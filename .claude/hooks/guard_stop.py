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
- `paused=true` in the state file -> allow the stop (intentional pause;
  remove the line to resume)
- stall protection: .claude/impl/.guard-stop-issue-<N>.json records a
  progress hash over the state file and the issue's todo files; after
  MAX_STALLED_BLOCKS consecutive blocks with no hash change the stop is
  allowed until progress resumes (Claude Code's own consecutive-block cap,
  CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, remains the outer backstop)
- kill switch: AMBERCAST_GUARD_STOP=0 disables the hook entirely
"""
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

MAX_STALLED_BLOCKS = 3

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


def issue_from_branch(branch):
    m = BRANCH_RE.fullmatch(branch)
    return m.group(1) if m else None


def is_done(state, key):
    return bool(re.search(rf"^{key}=done\s*$", state, re.M))


def is_paused(state):
    return bool(re.search(r"^paused=true\s*$", state, re.M))


def first_incomplete(state):
    for key, desc in STEPS:
        if not is_done(state, key):
            return key, desc
    return None


def last_completed(state):
    last = None
    for key, _ in STEPS:
        if is_done(state, key):
            last = key
    return last


def sidecar_path(proj, issue):
    return os.path.join(proj, ".claude", "impl", f".guard-stop-issue-{issue}.json")


def progress_hash(proj, issue):
    # The state file and the issue's todo checklists are where every step of
    # real progress lands, so their combined content is the stall signal.
    h = hashlib.sha256()
    paths = [os.path.join(proj, ".claude", "impl", f"issue-{issue}.state")]
    paths += sorted(
        glob.glob(os.path.join(proj, ".claude", "todos", f"issue-{issue}-*.md"))
    )
    for path in paths:
        try:
            with open(path, "rb") as f:
                h.update(f.read())
        except OSError:
            continue
        h.update(b"\0")
    return h.hexdigest()


def evaluate(proj, branch):
    """Return the Stop block payload, or None to allow the stop.

    Updates the stall-protection sidecar as a side effect: the counter grows
    on every block without progress and resets when the progress hash moves.
    """
    issue = issue_from_branch(branch)
    if issue is None:
        return None

    state_path = os.path.join(proj, ".claude", "impl", f"issue-{issue}.state")
    try:
        with open(state_path, encoding="utf-8") as f:
            state = f.read()
    except OSError:
        return None

    if is_paused(state):
        return None

    side = sidecar_path(proj, issue)
    nxt = first_incomplete(state)
    if nxt is None:
        try:
            os.remove(side)
        except OSError:
            pass
        return None

    digest = progress_hash(proj, issue)
    blocks = 0
    try:
        with open(side, encoding="utf-8") as f:
            prev = json.load(f)
        if prev.get("progress_sha256") == digest:
            blocks = int(prev.get("consecutive_blocks", 0))
    except (OSError, ValueError, TypeError):
        blocks = 0

    if blocks >= MAX_STALLED_BLOCKS:
        # Stalled: the agent was pushed back repeatedly without the flow
        # advancing, so something needs a human. Let the stop through.
        return None

    try:
        with open(side, "w", encoding="utf-8") as f:
            json.dump(
                {"progress_sha256": digest, "consecutive_blocks": blocks + 1}, f
            )
    except OSError:
        pass

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
    res = subprocess.run(
        ["git", "-C", proj, "symbolic-ref", "--short", "HEAD"],
        capture_output=True, text=True,
    )
    return res.stdout.strip() if res.returncode == 0 else None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if os.environ.get("AMBERCAST_GUARD_STOP") == "0":
        return 0
    proj = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    branch = current_branch(proj)
    if not branch:
        return 0
    payload = evaluate(proj, branch)
    if payload is not None:
        print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
