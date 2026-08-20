#!/usr/bin/env python3
"""Adapt Codex shell events to Ambercast's shared Git policy.

The manifest pins this adapter together with the shared guard. An isolated
launcher injects the verified worktree identity and already-read policy bytes,
which this adapter executes in a fresh module so filesystem swaps and ambient
Python import paths cannot change the reviewed policy. Keeping the boundary
logic local avoids widening every trusted bundle with another executable.

Payload and effective-directory validation bind policy decisions to the
verified physical worktree and fail closed whenever ownership or policy
evidence is ambiguous. The shared guard deliberately absorbs some Git failures,
so a module-local subprocess proxy observes its safety-critical branch probe and
upgrades unusable evidence to a Codex denial without mutating the real standard
library module. Restoration is unconditional, and adapter diagnostics do not
expose untrusted inputs.

Shared recovery guidance is translated only at standalone command-token
boundaries. Repository paths retain their original spelling, preserving the
canonical shared workflow reference while routing Codex back through its own
entrypoint.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


def _block(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


def _effective_directory(data: dict) -> str:
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd or not os.path.isdir(cwd):
        raise ValueError("invalid cwd")
    tool_input = data.get("tool_input")
    if tool_input is not None and not isinstance(tool_input, dict):
        raise ValueError("invalid tool input")
    effective = cwd
    if isinstance(tool_input, dict) and "workdir" in tool_input:
        workdir = tool_input["workdir"]
        if not isinstance(workdir, str) or not workdir:
            raise ValueError("invalid workdir")
        effective = workdir if os.path.isabs(workdir) else os.path.join(cwd, workdir)
        if not os.path.isdir(effective):
            raise ValueError("invalid workdir")
    return os.path.realpath(effective)


def _codex_message(message: str) -> str:
    return re.sub(
        r"(?<![A-Za-z0-9_./-])/implement(?![A-Za-z0-9_/-])",
        "$ambercast-implementation",
        message,
    )


class _BranchProbeProxy:
    def __init__(self, real: object) -> None:
        self._real = real
        self.failed = False

    def run(self, *args: object, **kwargs: object) -> object:
        try:
            result = self._real.run(*args, **kwargs)
        except (OSError, subprocess.SubprocessError):
            self.failed = True
            raise
        stdout = result.stdout
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if result.returncode != 0 or not str(stdout).strip():
            self.failed = True
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


def load_shared_guard(root: str):
    import types

    if root != verified_root():
        return None
    shared = types.ModuleType("ambercast_shared_guard_git")
    shared.__file__ = __ambercast_shared_path__
    exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, "exec"), shared.__dict__)
    return shared


def main() -> int:
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return _block("BLOCKED: Ambercast Git guard received invalid input.")
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, dict):
            return _block("BLOCKED: Ambercast Git guard received invalid input.")
        command = tool_input.get("command")
        if not isinstance(command, str):
            return _block("BLOCKED: Ambercast Git guard received invalid input.")

        root = project_root(data)
        if root != verified_root():
            return _block("BLOCKED: Ambercast Git guard worktree mismatch.")
        shared = load_shared_guard(root)
        if shared is None or not hasattr(shared, "evaluate") or not hasattr(shared, "subprocess"):
            return _block("BLOCKED: Ambercast shared Git policy failed to load.")

        original = shared.subprocess
        proxy = _BranchProbeProxy(original)
        shared.subprocess = proxy
        shared_data = dict(data)
        shared_data["cwd"] = _effective_directory(data)
        try:
            result = shared.evaluate(command, shared_data)
        finally:
            shared.subprocess = original
        if proxy.failed:
            return _block("BLOCKED: Ambercast Git policy probe failed.")
        if result is None:
            return 0
        exit_code, message = result
        print(_codex_message(message), file=sys.stderr)
        return int(exit_code)
    except Exception:
        return _block("BLOCKED: Ambercast Git guard failed safely.")


if __name__ == "__main__":
    raise SystemExit(main())
