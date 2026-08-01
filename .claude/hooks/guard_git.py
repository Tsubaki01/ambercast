#!/usr/bin/env python3
"""PreToolUse hook (Bash): enforce the branch discipline of the /implement flow.

Blocks (exit 2):
- `git commit` / `git push` while the repository is on `main`
- `git commit` on any branch not named `issues/<N>` or `issues/<N>-<slug>`

Branch grammar: ASCII digits, slug words are lowercase alphanumerics joined
by single hyphens. Accepted: issues/12, issues/12-schema, issues/12-fix-login.
Rejected: issues/12-, issues/12--a, issues/12-A, unicode digits.

Everything else passes through (exit 0). Runs outside a work tree -> no-op.
"""
import json
import os
import re
import subprocess
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

command = (data.get("tool_input") or {}).get("command", "")
if not re.search(r"\bgit\b", command):
    sys.exit(0)

is_commit = re.search(r"\bgit\b[^|;&]*\bcommit\b", command)
is_push = re.search(r"\bgit\b[^|;&]*\bpush\b", command)
if not (is_commit or is_push):
    sys.exit(0)

# The branch is sampled BEFORE the command runs, so a compound command that
# switches branches and then commits would be judged against the wrong branch.
if re.search(r"\bgit\s+(checkout|switch)\b", command):
    print(
        "BLOCKED: branch switching and commit/push in one command hides the "
        "real target branch from this guard. Run the switch first, then "
        "commit/push as a separate command.",
        file=sys.stderr,
    )
    sys.exit(2)

proj = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
res = subprocess.run(
    ["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"],
    capture_output=True, text=True,
)
if res.returncode != 0:
    sys.exit(0)
branch = res.stdout.strip()

if branch == "main":
    print(
        "BLOCKED: commits/pushes on main are forbidden. "
        "Start the /implement flow and work on an issues/<N> branch.",
        file=sys.stderr,
    )
    sys.exit(2)

if is_commit and not re.fullmatch(r"issues/[0-9]+(?:-[a-z0-9]+)*", branch):
    print(
        f"BLOCKED: branch '{branch}' does not match issues/<N> or issues/<N>-<slug>. "
        "The /implement flow requires one branch per GitHub issue "
        "(stack layers use the issues/<N>-<slug> form).",
        file=sys.stderr,
    )
    sys.exit(2)

sys.exit(0)
