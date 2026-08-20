#!/usr/bin/env python3
"""Adapt Ambercast flow completion to Codex's Stop protocol.

The manifest pins this adapter with the shared completion policy. An isolated
launcher injects a verified root and captured source bytes, and a fresh module
keeps policy execution independent of mutable paths and ambient imports. Stop
integrity failures terminate with a protocol warning instead of requesting a
continuation loop that damaged policy cannot safely resolve.

Repository ownership is verified before shared evaluation. A required
module-local subprocess proxy supervises branch and progress evidence, restores
the shared module unconditionally, and converts ambiguous evidence into a
non-secret terminating warning. The proxy is observational: shared evaluation
may persist its stall sidecar before a later probe outcome proves unusable. The
adapter does not invent rollback semantics for shared state; a later successful
evaluation reconciles through the canonical stall policy.

Codex has no Claude background-task bypass, so native subagent completion and
the ordinary shared state gates determine whether stopping is allowed. A stable
adapter session scope prevents turn identifiers from fragmenting stall
detection. Continuation guidance routes through the Codex skill without
rewriting canonical shared-workflow paths.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def _emit(payload: dict) -> int:
    print(json.dumps(payload, separators=(",", ":")))
    return 0


def _warning() -> int:
    return _emit(
        {
            "continue": False,
            "systemMessage": "Ambercast flow completion guard could not verify repository policy.",
        }
    )


def _effective_directory(data: dict) -> str:
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        raise ValueError("invalid cwd")
    effective = cwd
    if "tool_input" in data:
        tool_input = data["tool_input"]
        if not isinstance(tool_input, dict):
            raise ValueError("invalid tool input")
        if "workdir" in tool_input:
            workdir = tool_input["workdir"]
            if not isinstance(workdir, str) or not workdir:
                raise ValueError("invalid workdir")
            effective = workdir if os.path.isabs(workdir) else os.path.join(cwd, workdir)
            if not os.path.isdir(effective):
                raise ValueError("invalid workdir")
    return os.path.realpath(effective)


def _codex_reason(reason: str) -> str:
    rewritten = re.sub(
        r"(?<![A-Za-z0-9_./-])/implement flow\b",
        "$ambercast-implementation flow",
        reason,
    )
    return (
        rewritten
        + " Also re-read .agents/skills/ambercast-implementation/SKILL.md for Codex routing."
    )


def _stdout_bytes(result: object) -> bytes:
    stdout = result.stdout
    return stdout if isinstance(stdout, bytes) else str(stdout).encode()


class _StopProbeProxy:
    def __init__(self, real: object) -> None:
        self._real = real
        self.failed = False

    def _classify(self, argv: object, result: object) -> None:
        command = tuple(argv) if isinstance(argv, (list, tuple)) else ()
        output = _stdout_bytes(result).strip()
        if command[-4:] == ("symbolic-ref", "--quiet", "--short", "HEAD"):
            if not (
                (result.returncode == 0 and bool(output))
                or (result.returncode == 1 and not output)
            ):
                self.failed = True
        elif command[-2:] == ("rev-parse", "HEAD"):
            if result.returncode != 0 or not output:
                self.failed = True
        elif command[-2:] == ("diff", "HEAD") or command[-3:] == (
            "ls-files",
            "--others",
            "--exclude-standard",
        ):
            if result.returncode != 0:
                self.failed = True

    def run(self, argv: object, **kwargs: object) -> object:
        try:
            result = self._real.run(argv, **kwargs)
        except (OSError, subprocess.SubprocessError):
            self.failed = True
            raise
        self._classify(argv, result)
        return result

    def __getattr__(self, name: str) -> object:
        return getattr(self._real, name)


def verified_root() -> str:
    root = __ambercast_verified_root__
    if not isinstance(root, str) or not root:
        raise RuntimeError("verified root unavailable")
    return os.path.realpath(root)


def project_root(data: dict) -> str:
    effective = _effective_directory(data)
    result = subprocess.run(
        ["git", "-C", effective, "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    root = result.stdout.strip()
    if result.returncode != 0 or not root:
        raise RuntimeError("worktree root unavailable")
    return os.path.realpath(root)


def verified_impl_directory(root: str):
    """Bind shared state access to a physical directory in the verified root.

    A missing directory means no implementation state exists, while an
    existing non-directory or redirected path makes policy evidence ambiguous
    and must terminate before shared code can perform any state-side effect.
    """
    physical_root = os.path.realpath(root)
    impl = os.path.join(physical_root, ".claude", "impl")
    if not os.path.lexists(impl):
        return None
    if os.path.islink(impl) or not os.path.isdir(impl):
        raise ValueError("invalid implementation state directory")
    physical = os.path.realpath(impl)
    if physical != impl or os.path.commonpath((physical_root, physical)) != physical_root:
        raise ValueError("invalid implementation state directory")
    return impl


def load_shared_guard(root: str):
    import types

    if root != verified_root():
        return None
    shared = types.ModuleType("ambercast_shared_guard_stop")
    shared.__file__ = __ambercast_shared_path__
    exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, "exec"), shared.__dict__)
    return shared


def main() -> int:
    try:
        try:
            data = json.load(sys.stdin)
        except Exception:
            return _warning()
        if not isinstance(data, dict):
            return _warning()
        if os.environ.get("AMBERCAST_GUARD_STOP") == "0":
            return _emit({})

        root = project_root(data)
        if root != verified_root():
            return _warning()
        try:
            verified_impl_directory(root)
        except (OSError, ValueError):
            return _warning()
        shared = load_shared_guard(root)
        if (
            shared is None
            or not hasattr(shared, "current_branch")
            or not hasattr(shared, "evaluate")
            or not hasattr(shared, "subprocess")
        ):
            return _warning()

        original = shared.subprocess
        proxy = _StopProbeProxy(original)
        shared.subprocess = proxy
        try:
            branch = shared.current_branch(root)
            if proxy.failed:
                return _warning()
            if not branch:
                return _emit({})
            payload = shared.evaluate(root, branch, "")
            if proxy.failed:
                return _warning()
        finally:
            shared.subprocess = original
        if payload is None:
            return _emit({})
        if (
            not isinstance(payload, dict)
            or set(payload) != {"decision", "reason"}
            or payload.get("decision") != "block"
            or not isinstance(payload.get("reason"), str)
        ):
            return _warning()
        return _emit(
            {"decision": "block", "reason": _codex_reason(payload["reason"])}
        )
    except Exception:
        return _warning()


if __name__ == "__main__":
    raise SystemExit(main())
