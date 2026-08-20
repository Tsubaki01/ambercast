#!/usr/bin/env python3
"""Adapt Codex edit events to Ambercast's shared phase policy.

The manifest pins this adapter and the shared guard as one executable trust
unit. An isolated launcher supplies verified roots and captured policy bytes;
loading those bytes into a fresh module prevents path replacement and ambient
imports from changing the reviewed decision logic. Local boundary code keeps
that trusted bundle dependency-closed.

All structured edit targets are collected, physicalized, deduplicated, and
required to remain inside the verified worktree before shared evaluation. The
adapter replaces the shared ownership resolver for the complete evaluation and
also anchors its environment as defense in depth, restoring both afterward.
One module-local subprocess proxy caches identical policy probes across targets
and treats missing or contradictory Git evidence as a whole-edit denial. This
preserves bounded work without weakening the shared guard's Claude-facing
failure direction or mutating the real subprocess module.

Malformed events, uncertain ownership, policy failures, and any blocked target
fail closed without reflecting untrusted input. Standalone recovery commands
are routed to the Codex entrypoint while repository path references remain
unchanged.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys


PATCH_PATH_RE = re.compile(
    r"^\*\*\* (?:Add File|Update File|Delete File|Move to):([^\r\n]*)\r?$",
    re.MULTILINE,
)


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


def _stdout_text(result: object) -> str:
    stdout = result.stdout
    if isinstance(stdout, bytes):
        return stdout.decode(errors="replace")
    return str(stdout)


class _CachedProbeProxy:
    def __init__(self, real: object) -> None:
        self._real = real
        self._cache: dict[tuple[object, ...], tuple[bool, object]] = {}
        self.failed = False

    def _classify(self, argv: object, result: object) -> None:
        command = tuple(argv) if isinstance(argv, (list, tuple)) else ()
        output = _stdout_text(result).strip()
        if command[-4:] == ("symbolic-ref", "--quiet", "--short", "HEAD"):
            if not (
                (result.returncode == 0 and bool(output))
                or (result.returncode == 1 and not output)
            ):
                self.failed = True
        elif command[-2:] in {
            ("rev-parse", "--git-dir"),
            ("rev-parse", "--absolute-git-dir"),
        }:
            if result.returncode != 0 or not output:
                self.failed = True

    def run(self, argv: object, **kwargs: object) -> object:
        frozen = tuple(argv) if isinstance(argv, (list, tuple)) else argv
        key = (
            frozen,
            kwargs.get("capture_output"),
            kwargs.get("text"),
            kwargs.get("timeout"),
        )
        if key not in self._cache:
            try:
                result = self._real.run(argv, **kwargs)
                self._cache[key] = (False, result)
            except (OSError, subprocess.SubprocessError) as error:
                self._cache[key] = (True, error)
        raised, outcome = self._cache[key]
        if raised:
            self.failed = True
            raise outcome
        self._classify(argv, outcome)
        return outcome

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
    shared = types.ModuleType("ambercast_shared_guard_phase")
    shared.__file__ = __ambercast_shared_path__
    exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, "exec"), shared.__dict__)
    return shared


def extract_paths(data: dict, root: str):
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        raise ValueError("invalid tool input")
    raw_paths: list[str] = []
    for field in ("file_path", "notebook_path"):
        if field not in tool_input:
            continue
        value = tool_input[field]
        if not isinstance(value, str) or not value.strip():
            raise ValueError("invalid target")
        raw_paths.append(value)
    if "command" in tool_input:
        command = tool_input["command"]
        if not isinstance(command, str):
            raise ValueError("invalid patch")
        for match in PATCH_PATH_RE.finditer(command):
            value = match.group(1).strip()
            if value:
                raw_paths.append(value)

    verified = verified_root()
    paths: list[str] = []
    seen: set[str] = set()
    for raw in raw_paths:
        if raw == "/dev/null":
            continue
        candidate = raw if os.path.isabs(raw) else os.path.join(root, raw)
        physical = os.path.realpath(candidate)
        try:
            inside = os.path.commonpath((verified, physical)) == verified
        except ValueError:
            inside = False
        if not inside:
            raise PermissionError("outside worktree")
        if physical not in seen:
            seen.add(physical)
            paths.append(physical)
    return paths


def main() -> int:
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or not isinstance(data.get("tool_input"), dict):
            return _block("BLOCKED: Ambercast phase guard received invalid input.")
        root = project_root(data)
        if root != verified_root():
            return _block("BLOCKED: Ambercast phase guard worktree mismatch.")
        try:
            paths = extract_paths(data, _effective_directory(data))
        except PermissionError:
            return _block("BLOCKED: edit target is outside the verified worktree.")
        if not paths:
            return _block("BLOCKED: edit input contained no recognizable target.")
        shared = load_shared_guard(root)
        if (
            shared is None
            or not hasattr(shared, "evaluate")
            or not hasattr(shared, "resolve_owning_worktree")
            or not hasattr(shared, "subprocess")
        ):
            return _block("BLOCKED: Ambercast shared phase policy failed to load.")

        original_resolver = shared.resolve_owning_worktree
        original_subprocess = shared.subprocess
        previous_project = os.environ.get("CLAUDE_PROJECT_DIR")
        proxy = _CachedProbeProxy(original_subprocess)
        shared.resolve_owning_worktree = lambda path, anchor: root
        shared.subprocess = proxy
        os.environ["CLAUDE_PROJECT_DIR"] = root
        blocked = None
        try:
            for path in paths:
                result = shared.evaluate(path, data)
                if blocked is None and result is not None:
                    blocked = result
        finally:
            shared.resolve_owning_worktree = original_resolver
            shared.subprocess = original_subprocess
            if previous_project is None:
                os.environ.pop("CLAUDE_PROJECT_DIR", None)
            else:
                os.environ["CLAUDE_PROJECT_DIR"] = previous_project
        if proxy.failed:
            return _block("BLOCKED: Ambercast phase policy probe failed.")
        if blocked is None:
            return 0
        exit_code, message = blocked
        print(_codex_message(message), file=sys.stderr)
        return int(exit_code)
    except PermissionError:
        return _block("BLOCKED: edit target is outside the verified worktree.")
    except Exception:
        return _block("BLOCKED: Ambercast phase guard failed safely.")


if __name__ == "__main__":
    raise SystemExit(main())
