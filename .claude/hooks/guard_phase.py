#!/usr/bin/env python3
"""PreToolUse hook (Write/Edit): gate source and test edits on /implement progress.

Rules (exit 2 blocks the edit):
- src/ or test files may only be edited on an `issues/<N>` branch
- the branch's state file `.claude/impl/issue-<N>.state` must exist
- src/ and test edits require `step05_plan_revised=done` (plan reviewed & revised)
- test edits additionally require `step08_docs_review=done` (docs-first reviewed)

Files outside src/ and tests are never blocked.
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

path = (data.get("tool_input") or {}).get("file_path", "") or ""
proj = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
try:
    rel = os.path.relpath(os.path.abspath(path), os.path.abspath(proj))
except ValueError:
    sys.exit(0)
if rel.startswith(".."):
    sys.exit(0)

in_src = rel.startswith("src" + os.sep)
in_tests = rel.startswith("tests" + os.sep) or bool(
    re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", rel)
)
if not (in_src or in_tests):
    sys.exit(0)

res = subprocess.run(
    ["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"],
    capture_output=True, text=True,
)
if res.returncode != 0:
    sys.exit(0)
branch = res.stdout.strip()

m = re.fullmatch(r"issues/(\d+)", branch)
if not m:
    print(
        f"BLOCKED: source/test edits are only allowed on an issues/<N> branch "
        f"(current: {branch}). Start the /implement flow.",
        file=sys.stderr,
    )
    sys.exit(2)

state_path = os.path.join(proj, ".claude", "impl", f"issue-{m.group(1)}.state")
try:
    with open(state_path, encoding="utf-8") as f:
        state = f.read()
except FileNotFoundError:
    print(
        f"BLOCKED: missing state file {state_path}. "
        "Run /implement steps 1-5 before editing source.",
        file=sys.stderr,
    )
    sys.exit(2)


def done(key: str) -> bool:
    return bool(re.search(rf"^{key}=done\s*$", state, re.M))


if not done("step05_plan_revised"):
    print(
        "BLOCKED: plan review not complete (step05_plan_revised). "
        "Finish /implement steps 3-5 before touching src or tests.",
        file=sys.stderr,
    )
    sys.exit(2)

if in_tests and not done("step08_docs_review"):
    print(
        "BLOCKED: docs review not complete (step08_docs_review). "
        "Tests are written at step 9, after the docs-first review.",
        file=sys.stderr,
    )
    sys.exit(2)

sys.exit(0)
