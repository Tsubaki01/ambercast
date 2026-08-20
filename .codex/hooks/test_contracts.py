#!/usr/bin/env python3
"""Declarative and trust-surface contracts for Ambercast's Codex harness.

Run with ``--print-digests`` to produce the only accepted re-pinning values.
The output is deliberately line-oriented so maintainers can paste literal
values into the reviewed hook manifest without parsing test diagnostics.
"""
from __future__ import annotations

import ast
import builtins
import hashlib
import io
import importlib.util
import json
import os
import pathlib
import py_compile
import re
import shlex
import shutil
import stat
import subprocess
import sys
import sysconfig
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


HOOKS = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HOOKS.parents[1]
BUNDLES = {
    "git": (".codex/hooks/guard_git.py", ".claude/hooks/guard_git.py"),
    "phase": (".codex/hooks/guard_phase.py", ".claude/hooks/guard_phase.py"),
    "stop": (".codex/hooks/guard_stop.py", ".claude/hooks/guard_stop.py"),
}
CANDIDATE_ERROR = "ERROR: invalid Ambercast hook candidate.\n"


def load_adapter_module(name: str) -> types.ModuleType:
    path = HOOKS / name
    spec = importlib.util.spec_from_file_location(f"contract_{name[:-3]}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invoke_adapter_main(module: types.ModuleType, payload: object) -> tuple[int, str, str]:
    stdout, stderr = io.StringIO(), io.StringIO()
    original_stdin = sys.stdin
    sys.stdin = io.StringIO(json.dumps(payload))
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = module.main()
    finally:
        sys.stdin = original_stdin
    return result, stdout.getvalue(), stderr.getvalue()


def bundle_digest(root: pathlib.Path, members: tuple[str, str]) -> str:
    """Hash the reviewed ordered relative-path and file-byte stream."""
    digest = hashlib.sha256()
    for relative in members:
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update((root / relative).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def all_digests(root: pathlib.Path = REPO_ROOT) -> dict[str, str]:
    return {name: bundle_digest(root, members) for name, members in BUNDLES.items()}


def candidate_root(value: str) -> pathlib.Path:
    """Validate the complete physical bundle root used by the re-pin CLI."""
    root = pathlib.Path(value)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError(CANDIDATE_ERROR)
    try:
        if not root.is_dir() or root.resolve(strict=True) != root:
            raise ValueError(CANDIDATE_ERROR)
        for members in BUNDLES.values():
            for relative in members:
                member = root / relative
                mode = member.lstat().st_mode
                if (
                    stat.S_ISLNK(mode)
                    or not stat.S_ISREG(mode)
                    or member.parent.resolve(strict=True) != member.parent
                    or not os.access(member, os.R_OK)
                ):
                    raise ValueError(CANDIDATE_ERROR)
    except (OSError, RuntimeError):
        raise ValueError(CANDIDATE_ERROR) from None
    return root


def print_digest_cli(argv: list[str]) -> int:
    try:
        if argv == ["--print-digests"]:
            root = REPO_ROOT
        elif len(argv) == 3 and argv[:2] == ["--print-digests", "--candidate-root"]:
            root = candidate_root(argv[2])
        else:
            raise ValueError(CANDIDATE_ERROR)
        digests = all_digests(root)
        output = "".join(
            f"{key}={digests[key]}\n" for key in ("git", "phase", "stop")
        )
    except (KeyError, OSError, RuntimeError, ValueError):
        sys.stderr.write(CANDIDATE_ERROR)
        return 2
    sys.stdout.write(output)
    return 0


def evidence_digest(directory: pathlib.Path) -> str:
    """Digest sorted recursive relative names and bytes, including empty files."""
    digest = hashlib.sha256()
    if not directory.exists():
        return digest.hexdigest()
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def require_exact_keys(mapping: dict, expected: set[str], context: str) -> None:
    actual = set(mapping)
    if actual != expected:
        raise ValueError(
            f"{context} keys differ: missing={sorted(expected - actual)} "
            f"unknown={sorted(actual - expected)}"
        )


def load_manifest() -> dict:
    return strict_json_loads(
        (REPO_ROOT / ".codex/hooks.json").read_text(encoding="utf-8")
    )


def strict_json_loads(text: str) -> object:
    """Reject duplicate JSON object names at every nesting level."""
    def object_from_pairs(pairs: list[tuple[str, object]]) -> dict:
        result: dict = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(text, object_pairs_hook=object_from_pairs)


def canonical_json_digest(value: object) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def executable_loading_violations(source: str) -> list[str]:
    """Return dynamic executable-loading forms outside the injected bundle ABI."""
    tree = ast.parse(source)
    parents = {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }
    scope_types = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)

    def enclosing_scope(node: ast.AST) -> ast.AST:
        current = parents.get(node)
        while current is not None and not isinstance(current, scope_types):
            current = parents.get(current)
        return current or tree

    def scope_chain(scope: ast.AST):
        current = scope
        while True:
            yield current
            if current is tree:
                return
            current = enclosing_scope(current)

    def binds_name(scope: ast.AST, name: str) -> bool:
        for node in ast.walk(scope):
            if enclosing_scope(node) is not scope:
                continue
            if (
                isinstance(node, ast.Name)
                and isinstance(node.ctx, (ast.Store, ast.Del))
                and node.id == name
            ):
                return True
            if isinstance(node, (ast.Global, ast.Nonlocal)) and name in node.names:
                return True
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == name
            ):
                return True
            if isinstance(node, ast.arg) and node.arg == name:
                return True
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    bound = alias.asname or (
                        alias.name.split(".", 1)[0]
                        if isinstance(node, ast.Import)
                        else alias.name
                    )
                    if bound in {name, "*"}:
                        return True
            if isinstance(node, ast.ExceptHandler) and node.name == name:
                return True
            match_as = getattr(ast, "MatchAs", None)
            if match_as is not None and isinstance(node, match_as) and node.name == name:
                return True
            match_star = getattr(ast, "MatchStar", None)
            if match_star is not None and isinstance(node, match_star) and node.name == name:
                return True
        return False

    def exact_shared_binding(scope: ast.AST, before: ast.Call) -> bool:
        if any(
            binds_name(candidate, builtin)
            for candidate in scope_chain(scope)
            for builtin in ("exec", "compile")
        ):
            return False
        type_imports = [
            node
            for node in ast.walk(scope)
            if (
                isinstance(node, ast.Import)
                and enclosing_scope(node) is scope
                and any(alias.name.split(".", 1)[0] == "types" for alias in node.names)
            )
        ]
        exact_types_import = (
            len(type_imports) == 1
            and parents.get(type_imports[0]) is scope
            and len(type_imports[0].names) == 1
            and type_imports[0].names[0].name == "types"
            and type_imports[0].names[0].asname is None
        )
        allowed_types_import = type_imports[0] if exact_types_import else None
        stores = [
            node
            for node in ast.walk(scope)
            if (
                isinstance(node, ast.Name)
                and isinstance(node.ctx, ast.Store)
                and node.id == "shared"
                and enclosing_scope(node) is scope
            )
        ]
        forbidden = [
            node
            for node in ast.walk(scope)
            if enclosing_scope(node) is scope
            and (
                isinstance(node, (ast.Global, ast.Nonlocal))
                and "shared" in node.names
                or isinstance(node, (ast.Import, ast.ImportFrom))
                and any((alias.asname or alias.name.split(".", 1)[0]) == "shared" for alias in node.names)
                or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == "shared"
                or isinstance(node, ast.arg)
                and node.arg == "shared"
            )
        ]
        types_forbidden = [
            node
            for node in ast.walk(scope)
            if enclosing_scope(node) is scope
            and (
                isinstance(node, ast.Name)
                and isinstance(node.ctx, (ast.Store, ast.Del))
                and node.id == "types"
                or isinstance(node, (ast.Global, ast.Nonlocal))
                and "types" in node.names
                or isinstance(node, ast.ImportFrom)
                and (node.module or "").split(".", 1)[0] == "types"
                or isinstance(node, (ast.Import, ast.ImportFrom))
                and node is not allowed_types_import
                and any(
                    (
                        alias.asname
                        or (
                            alias.name.split(".", 1)[0]
                            if isinstance(node, ast.Import)
                            else alias.name
                        )
                    )
                    in {"types", "*"}
                    for alias in node.names
                )
                or isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and node.name == "types"
                or isinstance(node, ast.arg)
                and node.arg == "types"
                or isinstance(node, ast.ExceptHandler)
                and node.name == "types"
                or getattr(ast, "MatchAs", ())
                and isinstance(node, getattr(ast, "MatchAs"))
                and node.name == "types"
                or getattr(ast, "MatchStar", ())
                and isinstance(node, getattr(ast, "MatchStar"))
                and node.name == "types"
                or isinstance(node, ast.Attribute)
                and isinstance(node.ctx, (ast.Store, ast.Del))
                and node.attr == "ModuleType"
                or isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in {"setattr", "delattr"}
                and len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and node.args[1].value == "ModuleType"
            )
        ]
        if len(stores) != 1 or forbidden or types_forbidden or not exact_types_import:
            return False
        target = stores[0]
        assignment = parents.get(target)
        if not (
            isinstance(assignment, ast.Assign)
            and parents.get(assignment) is scope
            and (type_imports[0].lineno, type_imports[0].col_offset)
            < (assignment.lineno, assignment.col_offset)
            and (assignment.lineno, assignment.col_offset)
            < (before.lineno, before.col_offset)
            and len(assignment.targets) == 1
            and assignment.targets[0] is target
            and isinstance(assignment.value, ast.Call)
            and not assignment.value.keywords
            and isinstance(assignment.value.func, ast.Attribute)
            and assignment.value.func.attr == "ModuleType"
            and isinstance(assignment.value.func.value, ast.Name)
            and assignment.value.func.value.id == "types"
        ):
            return False
        return True

    allowed_exec_ids: set[int] = set()
    allowed_compile_ids: set[int] = set()
    violations: list[str] = []
    if any(
        binds_name(scope, "__builtins__")
        for scope in ast.walk(tree)
        if isinstance(scope, scope_types)
    ):
        violations.append("dangerous __builtins__ binding")
    for call in (node for node in ast.walk(tree) if isinstance(node, ast.Call)):
        if not (isinstance(call.func, ast.Name) and call.func.id == "exec"):
            continue
        compile_call = call.args[0] if call.args else None
        valid = (
            len(call.args) == 2
            and not call.keywords
            and isinstance(compile_call, ast.Call)
            and isinstance(compile_call.func, ast.Name)
            and compile_call.func.id == "compile"
            and len(compile_call.args) == 3
            and not compile_call.keywords
            and isinstance(compile_call.args[0], ast.Name)
            and compile_call.args[0].id == "__ambercast_shared_bytes__"
            and isinstance(compile_call.args[1], ast.Name)
            and compile_call.args[1].id == "__ambercast_shared_path__"
            and isinstance(compile_call.args[2], ast.Constant)
            and compile_call.args[2].value == "exec"
            and isinstance(call.args[1], ast.Attribute)
            and call.args[1].attr == "__dict__"
            and isinstance(call.args[1].value, ast.Name)
            and call.args[1].value.id == "shared"
            and exact_shared_binding(enclosing_scope(call), call)
        )
        if valid:
            allowed_exec_ids.add(id(call))
            allowed_compile_ids.add(id(compile_call))
        else:
            violations.append("exec outside exact injected shared-byte scope")

    dangerous_roots = {"__builtins__", "builtins", "importlib", "operator", "runpy"}
    dangerous_attributes = {
        "__builtins__", "__class__", "__code__", "__delattr__",
        "__getattribute__", "__globals__", "__setattr__",
        "__import__", "__subclasses__", "compile", "eval", "exec",
        "attrgetter", "delattr", "import_module", "methodcaller", "modules",
        "run_module", "run_path", "setattr", "spec_from_file_location",
    }
    allowed_bundle_import_roots = {
        "__future__", "glob", "hashlib", "json", "os", "re", "shlex",
        "subprocess", "sys", "tempfile", "types",
    }
    allowed_adapter_import_roots = {
        "__future__", "json", "os", "re", "subprocess", "sys", "types",
    }
    allowed_sys_attributes = {"exit", "stderr", "stdin"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = {alias.name.split(".", 1)[0] for alias in node.names}
            if not roots <= allowed_bundle_import_roots or (
                allowed_exec_ids and not roots <= allowed_adapter_import_roots
            ) or any(
                alias.name.split(".", 1)[0] == "sys"
                and (alias.name != "sys" or alias.asname is not None)
                for alias in node.names
            ):
                violations.append("unapproved executable-loader import")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root not in allowed_bundle_import_roots or (
                allowed_exec_ids and root not in allowed_adapter_import_roots
            ) or root == "sys":
                violations.append("unapproved executable-loader from-import")
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in dangerous_roots | {
                "__import__", "delattr", "eval", "globals", "locals", "setattr", "vars",
            }:
                violations.append(f"dangerous executable-loader reference {node.id}")
            elif node.id == "sys":
                parent = parents.get(node)
                if not (
                    isinstance(parent, ast.Attribute)
                    and parent.value is node
                    and parent.attr in allowed_sys_attributes
                ):
                    violations.append("sys reference outside finite runtime interface")
            elif node.id == "exec":
                parent = parents.get(node)
                if not (isinstance(parent, ast.Call) and parent.func is node and id(parent) in allowed_exec_ids):
                    violations.append("exec reference outside exact injected subtree")
            elif node.id == "compile":
                parent = parents.get(node)
                if not (isinstance(parent, ast.Call) and parent.func is node and id(parent) in allowed_compile_ids):
                    violations.append("compile reference outside exact injected subtree")
            elif node.id == "getattr":
                parent = parents.get(node)
                if not (isinstance(parent, ast.Call) and parent.func is node):
                    violations.append("aliased getattr reflection")
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"setattr", "delattr"}
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value == "ModuleType"
        ):
            violations.append("dangerous ModuleType mutation")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr":
            owner = node.args[0] if node.args else None
            attribute = node.args[1] if len(node.args) > 1 else None
            safe_proxy_owner = (
                len(node.args) == 2
                and not node.keywords
                and isinstance(owner, ast.Attribute)
                and owner.attr == "_real"
                and isinstance(owner.value, ast.Name)
                and owner.value.id == "self"
                and isinstance(attribute, ast.Name)
                and attribute.id == "name"
            )
            if not safe_proxy_owner:
                violations.append("unsafe getattr reflection")
        elif isinstance(node, ast.Attribute):
            if (
                isinstance(node.value, ast.Name)
                and node.value.id == "sys"
                and node.attr not in allowed_sys_attributes
            ):
                violations.append("sys attribute outside finite runtime interface")
            elif (
                node.attr == "ModuleType"
                and isinstance(node.ctx, (ast.Store, ast.Del))
            ):
                violations.append("dangerous ModuleType mutation")
            elif node.attr == "__dict__":
                parent = parents.get(node)
                if not (
                    isinstance(parent, ast.Call)
                    and len(parent.args) == 2
                    and parent.args[1] is node
                    and id(parent) in allowed_exec_ids
                ):
                    violations.append("unsafe executable-globals attribute")
            elif node.attr in dangerous_attributes and not (
                node.attr == "compile"
                and isinstance(node.value, ast.Name)
                and node.value.id == "re"
            ):
                violations.append("dangerous executable-loader attribute")
        elif isinstance(node, ast.Subscript):
            key = node.slice
            if isinstance(key, ast.Constant) and key.value in dangerous_attributes:
                violations.append("dangerous executable-loader subscript")
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in {"__getattribute__", "__getitem__"}
        ):
            violations.append("unsafe reflective attribute access")
    return violations


def manifest_command(event: str, index: int = 0) -> str | None:
    manifest = load_manifest()
    groups = manifest.get("hooks", {}).get(event, [])
    if len(groups) <= index:
        return None
    hooks = groups[index].get("hooks", [])
    if len(hooks) != 1:
        return None
    command = hooks[0].get("command")
    return command if isinstance(command, str) else None


def yaml_interface(path: pathlib.Path) -> dict[str, str]:
    """Parse the intentionally flat quoted interface mapping without PyYAML."""
    values: dict[str, str] = {}
    allowed = {"display_name", "short_description", "default_prompt"}
    in_interface = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.strip() == "interface:":
            if in_interface:
                raise ValueError("duplicate interface YAML mapping")
            in_interface = True
            continue
        if not in_interface or not line.startswith("  "):
            raise ValueError(f"unknown top-level YAML shape: {line}")
        match = re.fullmatch(r'  ([a-z_]+):\s*"(.*)"', line)
        if not match:
            raise ValueError(f"unsupported interface YAML line: {line}")
        if match.group(1) not in allowed:
            raise ValueError(f"unknown interface YAML key: {match.group(1)}")
        if match.group(1) in values:
            raise ValueError(f"duplicate interface YAML key: {match.group(1)}")
        values[match.group(1)] = match.group(2)
    require_exact_keys(values, allowed, "openai.yaml interface")
    return values


def parse_agent_hooks_ci(text: str) -> dict[str, object]:
    """Parse the indentation-sensitive agent-hooks matrix and ordered steps."""
    significant: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), 1):
        prefix = line[: len(line) - len(line.lstrip(" \t"))]
        if "\t" in prefix:
            raise ValueError(f"tab indentation on CI line {number}")
        if line.strip() and not line.lstrip().startswith("#"):
            significant.append((len(prefix), line.strip()))

    def only_index(indent: int, content: str, start: int = 0, end: int | None = None) -> int:
        limit = len(significant) if end is None else end
        matches = [
            index for index in range(start, limit)
            if significant[index] == (indent, content)
        ]
        if len(matches) != 1:
            raise ValueError(f"CI requires one {content} at indent {indent}")
        return matches[0]

    def end_of(index: int) -> int:
        indent = significant[index][0]
        for cursor in range(index + 1, len(significant)):
            if significant[cursor][0] <= indent:
                return cursor
        return len(significant)

    triggers = only_index(0, "on:")
    only_index(2, "pull_request:", triggers + 1, end_of(triggers))
    jobs = only_index(0, "jobs:")
    job = only_index(2, "agent-hooks:", jobs + 1, end_of(jobs))
    job_end = end_of(job)
    direct_job_values = [
        content.split(":", 1)[1].strip()
        for indent, content in significant[job + 1 : job_end]
        if indent == 4 and content.startswith("runs-on:")
    ]
    if len(direct_job_values) != 1 or not direct_job_values[0].strip(" '\"[]{}"):
        raise ValueError("agent-hooks requires one nonempty runs-on")
    for indent, content in significant[job + 1 : job_end]:
        if indent == 4 and (
            content.startswith("if:") or content.startswith("continue-on-error:")
        ):
            raise ValueError("agent-hooks job cannot be disabled or suppress failure")
    strategy = only_index(4, "strategy:", job + 1, job_end)
    matrix = only_index(6, "matrix:", strategy + 1, end_of(strategy))
    version_entries = [
        content.split(":", 1)[1].strip()
        for indent, content in significant[matrix + 1 : end_of(matrix)]
        if indent == 8 and content.startswith("python-version:")
    ]
    if len(version_entries) != 1:
        raise ValueError("CI requires one strategy.matrix.python-version")
    try:
        versions = json.loads(version_entries[0])
    except (TypeError, ValueError) as error:
        raise ValueError("CI python-version must be an inline JSON list") from error
    if versions != ["3.9", "3.x"]:
        raise ValueError("CI python-version matrix differs")

    steps = only_index(4, "steps:", job + 1, job_end)
    step_end = end_of(steps)
    starts = [
        index for index in range(steps + 1, step_end)
        if significant[index][0] == 6 and significant[index][1].startswith("- ")
    ]
    blocks = [
        significant[start : starts[position + 1] if position + 1 < len(starts) else step_end]
        for position, start in enumerate(starts)
    ]

    def values(block: list[tuple[int, str]], key: str) -> list[str]:
        found: list[str] = []
        for position, (indent, content) in enumerate(block):
            item = content[2:] if position == 0 and content.startswith("- ") else content
            if indent in {6, 8} and item.startswith(key + ":"):
                found.append(item.split(":", 1)[1].strip())
        return found

    setup_indices = [
        index for index, block in enumerate(blocks)
        if any(value.startswith("actions/setup-python@") for value in values(block, "uses"))
    ]
    test_indices = [
        index for index, block in enumerate(blocks)
        if values(block, "run") == ["npm run test:agent-hooks"]
    ]
    if len(setup_indices) != 1 or len(test_indices) != 1:
        raise ValueError("CI requires one setup-python and one agent-hook test step")
    setup_index, test_index = setup_indices[0], test_indices[0]
    setup = blocks[setup_index]
    test = blocks[test_index]
    with_entries = [position for position, item in setup if position == 8 and item == "with:"]
    bindings = [
        item.split(":", 1)[1].strip()
        for position, item in setup
        if position == 10 and item.startswith("python-version:")
    ]
    if with_entries != [8] or bindings != ["${{ matrix.python-version }}"]:
        raise ValueError("setup-python must consume matrix.python-version")
    if values(test, "if") or values(test, "continue-on-error"):
        raise ValueError("agent-hook test step cannot be disabled or suppress failure")
    if setup_index >= test_index:
        raise ValueError("setup-python must precede agent-hook tests")
    return {
        "versions": versions,
        "runs_on": direct_job_values[0],
        "setup_step": setup_index,
        "test_step": test_index,
    }


def skill_frontmatter(text: str) -> dict[str, str]:
    """Parse the flat Skill frontmatter and reject duplicates or unknown keys."""
    if not text.startswith("---\n") or "\n---\n" not in text[4:]:
        raise ValueError("missing Skill frontmatter delimiters")
    block = text.split("---\n", 2)[1]
    values: dict[str, str] = {}
    allowed = {"name", "description"}
    for line in block.splitlines():
        match = re.fullmatch(r"([a-z_]+):\s+(.+)", line)
        if not match:
            raise ValueError(f"invalid Skill frontmatter line: {line}")
        key, value = match.groups()
        if key not in allowed:
            raise ValueError(f"unknown Skill frontmatter key: {key}")
        if key in values:
            raise ValueError(f"duplicate Skill frontmatter key: {key}")
        values[key] = value
    if set(values) != allowed:
        raise ValueError("Skill frontmatter must contain name and description")
    return values


def parse_toml(text: str) -> dict:
    """Parse the small scalar-only TOML surface used by Codex role files."""
    root: dict = {}
    current = root
    multiline_key: str | None = None
    multiline: list[str] = []
    seen_sections: set[str] = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if multiline_key is not None:
            if line == '"""':
                if multiline_key in current:
                    raise ValueError(f"duplicate TOML key: {multiline_key}")
                current[multiline_key] = "\n".join(multiline)
                multiline_key = None
                multiline = []
            else:
                multiline.append(raw_line)
            continue
        if not line or line.startswith("#"):
            continue
        section = re.fullmatch(r"\[([A-Za-z0-9_.-]+)\]", line)
        if section:
            if section.group(1) in seen_sections:
                raise ValueError(f"duplicate TOML section: {section.group(1)}")
            seen_sections.add(section.group(1))
            current = root
            for part in section.group(1).split("."):
                current = current.setdefault(part, {})
            continue
        match = re.fullmatch(r"([A-Za-z0-9_-]+)\s*=\s*(.*)", line)
        if not match:
            raise ValueError(f"unsupported TOML line: {raw_line}")
        key, raw_value = match.groups()
        if key in current:
            raise ValueError(f"duplicate TOML key: {key}")
        if raw_value == '"""':
            multiline_key = key
            continue
        if raw_value.startswith('"') and raw_value.endswith('"'):
            value: object = json.loads(raw_value)
        elif raw_value in {"true", "false"}:
            value = raw_value == "true"
        elif re.fullmatch(r"-?[0-9]+", raw_value):
            value = int(raw_value)
        else:
            raise ValueError(f"unsupported TOML scalar: {raw_value}")
        current[key] = value
    if multiline_key is not None:
        raise ValueError("unterminated TOML multiline string")
    return root


class DigestHelperTests(unittest.TestCase):
    class CountingStringIO(io.StringIO):
        def __init__(self) -> None:
            super().__init__()
            self.write_count = 0

        def write(self, value: str) -> int:
            self.write_count += 1
            return super().write(value)

    def copy_bundle(self, root: pathlib.Path) -> None:
        for members in BUNDLES.values():
            for relative in members:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(REPO_ROOT / relative, target)

    def run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(pathlib.Path(__file__).resolve()), *arguments],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_digest_abi_is_path_nul_bytes_nul_in_declared_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "a").write_bytes(b"first")
            (root / "b").write_bytes(b"second")
            expected = hashlib.sha256(
                b"a\0first\0" + b"b\0second\0"
            ).hexdigest()
            self.assertEqual(bundle_digest(root, ("a", "b")), expected)
            self.assertNotEqual(
                bundle_digest(root, ("b", "a")), expected, "bundle order is security relevant"
            )

    def test_digest_changes_with_member_path_or_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "one").write_bytes(b"same")
            (root / "two").write_bytes(b"same")
            one = bundle_digest(root, ("one", "two"))
            (root / "two").write_bytes(b"changed")
            self.assertNotEqual(bundle_digest(root, ("one", "two")), one)
            self.assertNotEqual(bundle_digest(root, ("two", "one")), one)

    def test_print_digests_is_exact_three_line_interface(self) -> None:
        result = self.run_cli("--print-digests")
        self.assertEqual(result.returncode, 0)
        expected = "".join(
            f"{name}={all_digests()[name]}\n" for name in ("git", "phase", "stop")
        )
        self.assertEqual(result.stdout, expected)
        self.assertEqual(result.stderr, "")

    def test_candidate_root_prints_only_complete_physical_bundle_digests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            self.copy_bundle(root)
            result = self.run_cli("--print-digests", "--candidate-root", str(root))
            expected = "".join(
                f"{name}={all_digests(root)[name]}\n"
                for name in ("git", "phase", "stop")
            )
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, expected, ""))

    def test_digest_cli_computes_once_then_emits_complete_output_in_one_write(self) -> None:
        digests = {name: str(index) * 64 for index, name in enumerate(BUNDLES, 1)}
        stdout = self.CountingStringIO()
        stderr = io.StringIO()
        with (
            mock.patch(__name__ + ".all_digests", return_value=digests) as calculate,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            result = print_digest_cli(["--print-digests"])
        self.assertEqual(result, 0)
        calculate.assert_called_once_with(REPO_ROOT)
        self.assertEqual(stdout.write_count, 1)
        self.assertEqual(
            stdout.getvalue(),
            "".join(f"{name}={digests[name]}\n" for name in ("git", "phase", "stop")),
        )
        self.assertEqual(stderr.getvalue(), "")

    def test_late_bundle_read_failure_never_emits_partial_digest_output(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        outcomes = ["1" * 64, "2" * 64, OSError("SECRET-LATE-READ")]
        with (
            mock.patch(__name__ + ".bundle_digest", side_effect=outcomes) as digest,
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            result = print_digest_cli(["--print-digests"])
        self.assertEqual(result, 2)
        self.assertEqual(digest.call_count, 3)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), CANDIDATE_ERROR)

    def test_candidate_root_rejects_invalid_usage_and_root_states_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary).resolve()
            valid = base / "valid"
            valid.mkdir()
            self.copy_bundle(valid)
            incomplete = base / "incomplete"
            incomplete.mkdir()
            self.copy_bundle(incomplete)
            (incomplete / BUNDLES["stop"][1]).unlink()
            plain_file = base / "file"
            plain_file.write_text("not a root", encoding="utf-8")
            alias = base / "alias"
            alias.symlink_to(valid, target_is_directory=True)
            cases = [
                ("--print-digests", "--candidate-root"),
                ("--print-digests", "--candidate-root", "relative"),
                ("--print-digests", "--candidate-root", str(base / "missing")),
                ("--print-digests", "--candidate-root", str(plain_file)),
                ("--print-digests", "--candidate-root", str(alias)),
                ("--print-digests", "--candidate-root", str(incomplete)),
                ("--unknown",),
            ]
            for arguments in cases:
                with self.subTest(arguments=arguments):
                    result = self.run_cli(*arguments)
                    self.assertEqual(
                        (result.returncode, result.stdout, result.stderr),
                        (2, "", CANDIDATE_ERROR),
                    )

    def test_candidate_root_rejects_symlink_and_nonregular_members_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary).resolve()
            for mode in ("symlink", "directory"):
                root = base / mode
                root.mkdir()
                self.copy_bundle(root)
                member = root / BUNDLES["git"][0]
                original = member.read_bytes()
                if mode == "symlink":
                    outside = base / "outside.py"
                    outside.write_bytes(original)
                    member.unlink()
                    member.symlink_to(outside)
                elif mode == "directory":
                    member.unlink()
                    member.mkdir()
                result = self.run_cli("--print-digests", "--candidate-root", str(root))
                self.assertEqual(
                    (result.returncode, result.stdout, result.stderr),
                    (2, "", CANDIDATE_ERROR),
                )

    @unittest.skipIf(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        "root can read mode-000 candidate members",
    )
    def test_candidate_root_rejects_unreadable_member_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            self.copy_bundle(root)
            member = root / BUNDLES["git"][0]
            member.chmod(0)
            try:
                result = self.run_cli("--print-digests", "--candidate-root", str(root))
            finally:
                member.chmod(0o600)
            self.assertEqual(
                (result.returncode, result.stdout, result.stderr),
                (2, "", CANDIDATE_ERROR),
            )

    def test_candidate_root_rejects_bundle_parent_symlink_escape_via_cli(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = pathlib.Path(temporary).resolve()
            root = base / "candidate"
            root.mkdir()
            self.copy_bundle(root)
            parent = root / ".codex/hooks"
            outside = base / "outside-hooks"
            shutil.copytree(parent, outside)
            shutil.rmtree(parent)
            parent.symlink_to(outside, target_is_directory=True)
            result = self.run_cli("--print-digests", "--candidate-root", str(root))
            self.assertEqual(
                (result.returncode, result.stdout, result.stderr),
                (2, "", CANDIDATE_ERROR),
            )

    def test_recursive_evidence_digest_detects_add_delete_and_in_place_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "reviews/nested").mkdir(parents=True)
            before_empty = evidence_digest(root)
            empty = root / "reviews/nested/empty.md"
            empty.touch()
            after_empty_add = evidence_digest(root)
            self.assertNotEqual(after_empty_add, before_empty)
            empty.write_bytes(b"now nonempty")
            after_empty_change = evidence_digest(root)
            self.assertNotEqual(after_empty_change, after_empty_add)
            artifact = root / "reviews/nested/verdict.md"
            artifact.write_bytes(b"verdict one")
            sibling = root / "reviews/other.md"
            sibling.write_bytes(b"other")
            before_delete = evidence_digest(root)
            sibling.unlink()
            after_delete = evidence_digest(root)
            self.assertNotEqual(after_delete, before_delete)
            artifact.write_bytes(b"verdict two")
            changed = evidence_digest(root)
            self.assertNotEqual(changed, after_delete)
            added_nested = root / "reviews/nested/deeper/new.md"
            added_nested.parent.mkdir()
            added_nested.write_bytes(b"new")
            self.assertNotEqual(evidence_digest(root), changed)


class ManifestContractTests(unittest.TestCase):
    def test_pinned_bundles_are_closed_over_repository_imports_and_stdlib_only(self) -> None:
        stdlib = pathlib.Path(sysconfig.get_paths()["stdlib"]).resolve()
        for name, members in BUNDLES.items():
            allowed = {(REPO_ROOT / relative).resolve() for relative in members}
            for relative in members:
                member = (REPO_ROOT / relative).resolve()
                tree = ast.parse(member.read_text(encoding="utf-8"), filename=relative)
                imports: list[tuple[str, int]] = []
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imports.extend((alias.name, 0) for alias in node.names)
                    elif isinstance(node, ast.ImportFrom):
                        imports.append((node.module or "", node.level))
                for imported, level in imports:
                    self.assertEqual(
                        level,
                        0,
                        f"{relative} uses an unpinned relative executable import",
                    )
                    root = imported.split(".", 1)[0]
                    candidates = [
                        (REPO_ROOT / f"{root}.py").resolve(),
                        (REPO_ROOT / root / "__init__.py").resolve(),
                        (member.parent / f"{root}.py").resolve(),
                        (member.parent / root / "__init__.py").resolve(),
                    ]
                    local = next((path for path in candidates if path.exists()), None)
                    if local is not None:
                        self.assertIn(
                            local,
                            allowed,
                            f"{relative} imports repository executable {local} "
                            f"outside ordered {name} bundle {members}",
                        )
                        continue
                    spec = importlib.util.find_spec(root)
                    self.assertIsNotNone(spec, f"{relative} imports non-stdlib {root}")
                    origin = None if spec is None else spec.origin
                    if origin in {"built-in", "frozen"} or root in sys.builtin_module_names:
                        continue
                    self.assertIsInstance(origin, str, f"{relative} imports non-stdlib {root}")
                    if not isinstance(origin, str):
                        continue
                    resolved = pathlib.Path(origin).resolve()
                    self.assertTrue(
                        resolved.is_relative_to(stdlib)
                        and "site-packages" not in resolved.parts,
                        f"{relative} imports non-stdlib {root} from {resolved}",
                    )

                self.assertEqual(
                    executable_loading_violations(member.read_text(encoding="utf-8")),
                    [],
                    f"{relative} dynamically loads executable code outside its pin",
                )

    def test_dynamic_import_and_exec_mutations_are_rejected_except_injected_bytes(self) -> None:
        rejected = [
            "__import__('repository_guard')",
            "import json\nimport pickle\nvalue = pickle.loads(payload)",
            "import pathlib\nvalue = pathlib.Path('.')",
            "import importlib\nimportlib.import_module('repository_guard')",
            "import importlib as loader\nloader.import_module('repository_guard')",
            "from importlib import import_module as loader\nloader('repository_guard')",
            "import importlib\nimportlib.util.spec_from_file_location('x', '/repo/x.py')",
            "import runpy\nrunpy.run_path('/repo/x.py')",
            "import runpy as runner\nrunner.run_path('/repo/x.py')",
            "from runpy import run_path as runner\nrunner('/repo/x.py')",
            "import builtins as safe\nsafe.__import__('repository_guard')",
            "from builtins import eval as evaluate\nevaluate(\"open('/repo/x.py').read()\")",
            "import builtins\ngetattr(builtins, '__import__')('repository_guard')",
            "getattr(__builtins__, 'eval')(\"__import__('repository_guard')\")",
            "__builtins__['eval'](\"__import__('repository_guard')\")",
            "import builtins\nbuiltins.__dict__['eval'](\"__import__('repository_guard')\")",
            "import builtins\nloader = builtins.__dict__['eval']\nloader(\"__import__('repository_guard')\")",
            "import builtins\nloader = builtins.__dict__['__import__']\nloader('repository_guard')",
            "import importlib\nloader = importlib.__dict__['import_module']\nloader('repository_guard')",
            "loader, ignored = (__builtins__['eval'], None)\nloader(\"__import__('repository_guard')\")",
            "(loader := __builtins__['eval'])(\"__import__('repository_guard')\")",
            "loaders = (__builtins__['eval'],)\nloaders[0](\"__import__('repository_guard')\")",
            "loaders = {'run': __builtins__['eval']}\nloaders['run'](\"__import__('repository_guard')\")",
            "import importlib\ngetattr(importlib, 'import_module')('repository_guard')",
            "eval(\"__import__('repository_guard')\")",
            "exec(open('/repo/x.py').read(), {})",
            "compile(open('/repo/x.py').read(), '/repo/x.py', 'exec')",
            "exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), foreign.__dict__)",
            "loader = __import__\nloader('repository_guard')",
            "import types\nshared = foreign\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nshared = types.ModuleType('x')\nshared = foreign\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nshared, other = (types.ModuleType('x'), None)\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\n(shared := types.ModuleType('x'))\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef load():\n global shared\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef outer():\n shared = types.ModuleType('x')\n def load():\n  nonlocal shared\n  exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nshared = types.ModuleType('x')\ndef load():\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import builtins as shared\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from types import ModuleType as shared\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)\nshared = types.ModuleType('x')",
            "shared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types as module_types\nshared = module_types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef load(types):\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntypes = SimpleNamespace(ModuleType=lambda name: sys)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntypes = foreign_factory\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntypes, other = (foreign_factory, None)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\n(types := foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntypes.ModuleType = foreign_factory\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nsetattr(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nalias = types\nsetter = setattr\nsetter(alias, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nalias = types\nremover = delattr\nremover(alias, 'ModuleType')\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nsetattr(sys.modules['builtins'], 'exec', foreign_exec)\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nsetattr(sys.modules['builtins'], 'compile', foreign_compile)\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nimport types\ngetattr(sys.modules['builtins'], 'setattr')(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\ngetattr(sys.modules['builtins'], 'setattr')(sys.modules['builtins'], 'exec', foreign_exec)\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\ngetattr(sys.modules['builtins'], 'setattr')(sys.modules['builtins'], 'compile', foreign_compile)\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nimport types\ngetattr(sys.modules['builtins'], 'delattr')(types, 'ModuleType')\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.attrgetter('setattr')(sys.modules['builtins'])(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.attrgetter('setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.attrgetter('setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.methodcaller('__getattribute__', 'setattr')(sys.modules['builtins'])(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.methodcaller('__getattribute__', 'setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import operator\nimport sys\nimport types\noperator.methodcaller('__getattribute__', 'setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import attrgetter as getter\nimport sys\nimport types\ngetter('setattr')(sys.modules['builtins'])(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import attrgetter as getter\nimport sys\nimport types\ngetter('setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import attrgetter as getter\nimport sys\nimport types\ngetter('setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import methodcaller as getter\nimport sys\nimport types\ngetter('__getattribute__', 'setattr')(sys.modules['builtins'])(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import methodcaller as getter\nimport sys\nimport types\ngetter('__getattribute__', 'setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from operator import methodcaller as getter\nimport sys\nimport types\ngetter('__getattribute__', 'setattr')(sys.modules['builtins'])(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle\nimport types\npickle.loads(serialized_setattr)(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle\nimport sys\nimport types\npickle.loads(serialized_setattr)(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle\nimport sys\nimport types\npickle.loads(serialized_setattr)(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle as loader\nimport types\nloader.loads(serialized_setattr)(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle as loader\nimport sys\nimport types\nloader.loads(serialized_setattr)(sys.modules['builtins'], 'exec', foreign_exec)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pickle as loader\nimport sys\nimport types\nloader.loads(serialized_setattr)(sys.modules['builtins'], 'compile', foreign_compile)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nsys.modules['types'] = sys.modules['builtins']\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\ndel sys.modules['types']\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nsys.modules.update({'types': sys.modules['builtins']})\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from sys import modules\nmodules['types'] = modules['builtins']\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from sys import modules as registry\ndel registry['types']\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from sys import modules as registry\nregistry.update({'types': registry['builtins']})\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nsys._getframe().f_globals['ex' + 'ec'] = foreign_exec\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import sys\nimport types\nsys._getframe().f_builtins['set' + 'attr'](types, 'Module' + 'Type', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from sys import _getframe as frame\nframe().f_globals['ex' + 'ec'] = foreign_exec\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from sys import _getframe as frame\nimport types\nframe().f_builtins['set' + 'attr'](types, 'Module' + 'Type', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import pathlib\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nimport pkgutil as types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\nmodule.ModuleType = foreign_factory\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\ndel module.ModuleType\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\nsetattr(module, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\ndelattr(module, 'ModuleType')\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\nmodule.__setattr__('ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\nmodule.__delattr__('ModuleType')\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\ntype(module).__setattr__(module, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nmodule = types\ntype(module).__delattr__(module, 'ModuleType')\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntype(types).__setattr__(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ntypes.__class__.__setattr__(types, 'ModuleType', foreign_factory)\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef load():\n global types\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def outer():\n import types\n def load():\n  nonlocal types\n  shared = types.ModuleType('x')\n  exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nshared = types.ModuleType('x')\nexec(compile(foreign_bytes, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), foreign.__dict__)",
            "import types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__, {})",
            "import types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec', 0), shared.__dict__)",
            "import types\nexec = foreign_exec\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ncompile = foreign_compile\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef exec(source, namespace): pass\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\nfrom helpers import execute as exec\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndel compile\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import types\ndef load():\n global exec\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def outer():\n exec = foreign_exec\n def load():\n  nonlocal exec\n  import types\n  shared = types.ModuleType('x')\n  exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "__builtins__ = foreign_builtins\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "del __builtins__\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "global __builtins__\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def load():\n import types\n __builtins__ = foreign_builtins\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def load():\n import types\n del __builtins__\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def load():\n global __builtins__\n import types\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def outer():\n __builtins__ = foreign_builtins\n def load():\n  nonlocal __builtins__\n  import types\n  shared = types.ModuleType('x')\n  exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "import foreign as __builtins__\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "from foreign import namespace as __builtins__\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def load(__builtins__):\n import types\n shared = types.ModuleType('x')\n exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "def __builtins__(): pass\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "async def __builtins__(): pass\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
            "class __builtins__: pass\nimport types\nshared = types.ModuleType('x')\nexec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)",
        ]
        for source in rejected:
            with self.subTest(source=source):
                self.assertNotEqual(executable_loading_violations(source), [])
        allowed = (
            "import types\n"
            "shared = types.ModuleType('ambercast_shared_guard')\n"
            "exec(compile(__ambercast_shared_bytes__, "
            "__ambercast_shared_path__, 'exec'), shared.__dict__)"
        )
        self.assertEqual(executable_loading_violations(allowed), [])

    def test_raw_and_canonical_identity_helpers_match_independent_fixed_vectors(self) -> None:
        raw_key_order = '{"z":"雪","a":[1,true]}\n'.encode("utf-8")
        raw_whitespace = ' { "a" : [ 1, true ], "z" : "雪" } '.encode("utf-8")
        self.assertEqual(
            hashlib.sha256(raw_key_order).hexdigest(),
            "f652aa04f85d437aef1709b447a30d083f8f019a5f51dc797714b1227eb13d8d",
        )
        self.assertEqual(
            hashlib.sha256(raw_whitespace).hexdigest(),
            "103a343f007803b4d6f63f1142318377f1e4979d3b1d335ff0b4e7a1ce6560ac",
        )
        ordered = strict_json_loads(raw_key_order.decode("utf-8"))
        spaced = strict_json_loads(raw_whitespace.decode("utf-8"))
        self.assertEqual(ordered, spaced)
        self.assertEqual(
            canonical_json_digest(ordered),
            "a194c544bea05b9adb9fee1d6248a54a0665ad81969f77c2198c964ae24d6411",
        )
        self.assertEqual(
            canonical_json_digest(spaced),
            "a194c544bea05b9adb9fee1d6248a54a0665ad81969f77c2198c964ae24d6411",
        )

    def test_manifest_has_exact_top_level_and_event_shape(self) -> None:
        manifest = load_manifest()
        self.assertEqual(set(manifest), {"description", "hooks"})
        self.assertEqual(
            manifest["description"],
            "Ambercast implementation-flow enforcement for Codex.",
        )
        self.assertEqual(set(manifest["hooks"]), {"PreToolUse", "Stop"})
        pre = manifest["hooks"]["PreToolUse"]
        stop = manifest["hooks"]["Stop"]
        self.assertEqual(len(pre), 2)
        self.assertEqual([item.get("matcher") for item in pre], ["^Bash$", "^(apply_patch|Edit|Write)$"])
        self.assertEqual(len(stop), 1)
        self.assertEqual(set(stop[0]), {"hooks"})
        for group in [*pre, *stop]:
            self.assertEqual(set(group), {"matcher", "hooks"} if "matcher" in group else {"hooks"})
            self.assertEqual(len(group["hooks"]), 1)

    def test_inner_command_objects_have_exact_fields_messages_and_timeouts(self) -> None:
        manifest = load_manifest()
        hooks = manifest.get("hooks", {})
        groups = [*hooks.get("PreToolUse", []), *hooks.get("Stop", [])]
        self.assertEqual(len(groups), 3)
        if len(groups) != 3:
            return
        expected_messages = [
            "Checking Ambercast branch policy",
            "Checking Ambercast implementation phase",
            "Checking Ambercast flow completion",
        ]
        for group, message in zip(groups, expected_messages):
            self.assertEqual(len(group.get("hooks", [])), 1)
            inner = group["hooks"][0]
            self.assertEqual(
                set(inner), {"type", "command", "timeout", "statusMessage"}
            )
            self.assertEqual(inner["type"], "command")
            self.assertEqual(inner["timeout"], 40)
            self.assertGreater(inner["timeout"], 6 * 5)
            self.assertEqual(inner["statusMessage"], message)

    def test_commands_use_isolated_inline_verifier_and_exact_bundle_argv(self) -> None:
        commands = [
            manifest_command("PreToolUse", 0),
            manifest_command("PreToolUse", 1),
            manifest_command("Stop", 0),
        ]
        self.assertTrue(all(commands))
        if not all(commands):
            return
        for command, (name, members) in zip(commands, BUNDLES.items()):
            assert command is not None
            self.assertRegex(command, r"^python3 -I -S -c ")
            self.assertIn("rev-parse", command)
            self.assertIn("--show-toplevel", command)
            self.assertIn("timeout=5", command)
            self.assertIn(bundle_digest(REPO_ROOT, members), command)
            self.assertEqual(command.count(members[0]), 1)
            self.assertEqual(command.count(members[1]), 1)

    def test_shlex_argv_is_exactly_eight_tokens_with_literal_bundle_tail(self) -> None:
        commands = [
            manifest_command("PreToolUse", 0),
            manifest_command("PreToolUse", 1),
            manifest_command("Stop", 0),
        ]
        self.assertTrue(all(commands))
        if not all(commands):
            return
        for command, (name, members) in zip(commands, BUNDLES.items()):
            assert command is not None
            argv = shlex.split(command)
            self.assertEqual(len(argv), 8)
            self.assertEqual(argv[:4], ["python3", "-I", "-S", "-c"])
            self.assertNotEqual(argv[4], "")
            self.assertEqual(argv[5:], [all_digests()[name], *members])

    def test_json_manifest_parser_rejects_duplicate_names(self) -> None:
        with self.assertRaises(ValueError):
            strict_json_loads('{"hooks": {}, "hooks": {}}')

    def test_manifest_digest_literals_equal_print_helper(self) -> None:
        for index, (name, members) in enumerate(BUNDLES.items()):
            event, group = ("PreToolUse", index) if index < 2 else ("Stop", 0)
            command = manifest_command(event, group)
            self.assertIsNotNone(command)
            if command is not None:
                self.assertIn(f" {all_digests()[name]} ", command)

    def test_raw_manifest_and_canonical_complete_entry_identity_abi(self) -> None:
        path = REPO_ROOT / ".codex/hooks.json"
        raw = path.read_bytes()
        manifest = strict_json_loads(raw.decode("utf-8"))
        self.assertIsInstance(manifest, dict)
        if not isinstance(manifest, dict) or manifest == {}:
            self.fail("step-11 manifest identities are intentionally absent during red")
        entries = [
            *manifest["hooks"]["PreToolUse"],
            *manifest["hooks"]["Stop"],
        ]
        identities = [canonical_json_digest(entry) for entry in entries]
        self.assertEqual(len(identities), 3)
        self.assertEqual(len(set(identities)), 3)
        for entry, identity in zip(entries, identities):
            changed = dict(entry)
            changed["__mutation__"] = True
            self.assertNotEqual(canonical_json_digest(changed), identity)


class InlineLauncherIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="ambercast launcher ")
        self.integrity_sentinel = "SECRET-INTEGRITY-DIAGNOSTIC"
        self.root = (
            pathlib.Path(self._temp.name)
            / f"repo with spaces {self.integrity_sentinel}"
        )
        self.root.mkdir()
        for members in BUNDLES.values():
            for relative in members:
                target = self.root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(REPO_ROOT / relative, target)
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.root, check=True)

    def tearDown(self) -> None:
        self._temp.cleanup()

    def command(self, event: str, index: int = 0) -> str:
        manifest = load_manifest()
        if manifest == {}:
            self.skipTest("step-11 hook definitions are intentionally absent during red")
        hooks = manifest.get("hooks")
        self.assertIsInstance(hooks, dict)
        self.assertIn(event, hooks)
        groups = hooks[event]
        self.assertIsInstance(groups, list)
        self.assertGreater(len(groups), index)
        group = groups[index]
        self.assertIsInstance(group, dict)
        inner = group.get("hooks")
        self.assertIsInstance(inner, list)
        self.assertEqual(len(inner), 1)
        self.assertIsInstance(inner[0], dict)
        command = inner[0].get("command")
        self.assertIsInstance(command, str)
        self.assertNotEqual(command, "")
        assert isinstance(command, str)
        return command

    def run_command(
        self,
        command: str,
        payload: object,
        *,
        env: dict[str, str] | None = None,
        cwd: pathlib.Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        process_env = os.environ.copy()
        process_env.pop("AMBERCAST_GUARD_STOP", None)
        process_env.update(env or {})
        return subprocess.run(
            command,
            shell=True,
            cwd=cwd or self.root,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=process_env,
            timeout=10,
        )

    def assert_launcher_outcome(
        self, result: subprocess.CompletedProcess[str], *, stop: bool, allowed: bool
    ) -> None:
        if allowed:
            self.assertEqual(result.returncode, 0, result.stderr)
            if stop:
                self.assertEqual(strict_json_loads(result.stdout), {})
            return
        if stop:
            self.assertEqual((result.returncode, result.stderr), (0, ""))
            warning = strict_json_loads(result.stdout)
            self.assertEqual(set(warning), {"continue", "systemMessage"})
            self.assertIs(warning["continue"], False)
        else:
            self.assertEqual((result.returncode, result.stdout), (2, ""))
            self.assertNotEqual(result.stderr, "")

    def test_atomic_repin_byte_transition_has_exact_five_states(self) -> None:
        definitions = [
            ("git", self.command("PreToolUse", 0), False, {"tool_input": {"command": "git status"}}),
            ("phase", self.command("PreToolUse", 1), False, {"tool_input": {"file_path": "README.md"}}),
            ("stop", self.command("Stop", 0), True, {}),
        ]
        for name, old_command, is_stop, body in definitions:
            with self.subTest(bundle=name), tempfile.TemporaryDirectory(
                prefix=f"repin-{name}-"
            ) as temporary:
                base = pathlib.Path(temporary).resolve()
                candidate = base / "candidate"
                stale_linked = base / "stale-linked"
                shutil.copytree(self.root, candidate)
                shutil.copytree(self.root, stale_linked)
                member = candidate / BUNDLES[name][1]
                member.write_bytes(member.read_bytes() + b"\n# candidate byte transition\n")
                old_digest = all_digests(self.root)[name]
                new_digest = all_digests(candidate)[name]
                self.assertNotEqual(old_digest, new_digest)
                repinned = old_command.replace(old_digest, new_digest, 1)
                self.assertNotEqual(repinned, old_command)

                def execute(command: str, root: pathlib.Path) -> subprocess.CompletedProcess[str]:
                    payload = dict(body)
                    payload["cwd"] = str(root)
                    return self.run_command(command, payload, cwd=root)

                states = [
                    (execute(old_command, self.root), True),
                    (execute(old_command, candidate), False),
                    (execute(repinned, candidate), True),
                    (execute(repinned, stale_linked), False),
                ]
                for relative in BUNDLES[name]:
                    destination = stale_linked / relative
                    destination.write_bytes((candidate / relative).read_bytes())
                states.append((execute(repinned, stale_linked), True))
                self.assertEqual([allowed for _, allowed in states], [True, False, True, False, True])
                for result, allowed in states:
                    self.assert_launcher_outcome(result, stop=is_stop, allowed=allowed)

    def test_primary_manifest_commands_execute_linked_bundle_and_reject_mismatch_or_stale_bytes(self) -> None:
        definitions = [
            ("git", self.command("PreToolUse", 0), False, {"tool_input": {"command": "git status"}}),
            ("phase", self.command("PreToolUse", 1), False, {"tool_input": {"file_path": "README.md"}}),
            ("stop", self.command("Stop", 0), True, {}),
        ]
        with tempfile.TemporaryDirectory(prefix="primary-linked-") as temporary:
            base = pathlib.Path(temporary).resolve()
            primary = base / "primary"
            linked = base / "linked"
            primary.mkdir()
            for members in BUNDLES.values():
                for relative in members:
                    target = primary / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(REPO_ROOT / relative, target)
            manifest_path = primary / ".codex/hooks.json"
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO_ROOT / ".codex/hooks.json", manifest_path)
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=primary, check=True)
            subprocess.run(
                [
                    "git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                    "add", ".",
                ],
                cwd=primary,
                check=True,
            )
            subprocess.run(
                [
                    "git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                    "commit", "-q", "-m", "primary manifest",
                ],
                cwd=primary,
                check=True,
            )
            subprocess.run(
                ["git", "worktree", "add", "-q", "-b", "issues/164", str(linked)],
                cwd=primary,
                check=True,
            )
            primary_manifest = strict_json_loads(manifest_path.read_text(encoding="utf-8"))
            self.assertIsInstance(primary_manifest, dict)
            primary_commands = [
                primary_manifest["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
                primary_manifest["hooks"]["PreToolUse"][1]["hooks"][0]["command"],
                primary_manifest["hooks"]["Stop"][0]["hooks"][0]["command"],
            ]
            self.assertEqual(primary_commands, [item[1] for item in definitions])

            for (name, command, is_stop, body), primary_command in zip(definitions, primary_commands):
                with self.subTest(bundle=name):
                    primary_member = primary / BUNDLES[name][0]
                    primary_member.write_bytes(primary_member.read_bytes() + b"\n# primary-only tamper\n")
                    linked_payload = dict(body, cwd=str(linked))
                    valid = self.run_command(primary_command, linked_payload, cwd=linked)
                    self.assert_launcher_outcome(valid, stop=is_stop, allowed=True)

                    mismatch = self.run_command(
                        primary_command, dict(body, cwd=str(primary)), cwd=linked
                    )
                    self.assert_launcher_outcome(mismatch, stop=is_stop, allowed=False)

                    linked_member = linked / BUNDLES[name][0]
                    linked_member.write_bytes(linked_member.read_bytes() + b"\n# stale linked bytes\n")
                    stale = self.run_command(primary_command, linked_payload, cwd=linked)
                    self.assert_launcher_outcome(stale, stop=is_stop, allowed=False)

    def test_every_unmodified_command_succeeds_in_path_with_spaces(self) -> None:
        git_result = self.run_command(
            self.command("PreToolUse", 0),
            {"cwd": str(self.root), "tool_input": {"command": "git status"}},
        )
        phase_result = self.run_command(
            self.command("PreToolUse", 1),
            {"cwd": str(self.root), "tool_input": {"file_path": "README.md"}},
        )
        stop_result = self.run_command(
            self.command("Stop", 0),
            {"cwd": str(self.root)},
        )
        self.assertEqual(git_result.returncode, 0, git_result.stderr)
        self.assertEqual(phase_result.returncode, 0, phase_result.stderr)
        self.assertEqual(stop_result.returncode, 0, stop_result.stderr)
        self.assertEqual(json.loads(stop_result.stdout), {})

    def test_incomplete_stop_observes_exact_six_bounded_git_calls(self) -> None:
        command = self.command("Stop", 0)
        commit_env = os.environ.copy()
        commit_env.update(
            {
                "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+00:00",
                "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+00:00",
            }
        )
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Ambercast Test Fixture",
                "-c",
                "user.email=ambercast-test@example.invalid",
                "commit",
                "--allow-empty",
                "--no-gpg-sign",
                "-q",
                "-m",
                "fixture baseline",
            ],
            cwd=self.root,
            env=commit_env,
            check=True,
        )
        subprocess.run(
            ["git", "checkout", "-q", "-b", "issues/164"],
            cwd=self.root,
            check=True,
        )
        state = self.root / ".claude/impl/issue-164.state"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(
            "issue=164\nbranch=issues/164\nstep01_issue=done\n",
            encoding="utf-8",
        )
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git)
        shim_dir = pathlib.Path(self._temp.name) / "git-shim"
        shim_dir.mkdir()
        log = shim_dir / "calls.jsonl"
        shim = shim_dir / "git"
        shim.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "with open(os.environ['AMBERCAST_GIT_CALL_LOG'], 'a', encoding='utf-8') as stream:\n"
            " stream.write(json.dumps(sys.argv[1:], separators=(',', ':')) + '\\n')\n"
            "real = os.environ['AMBERCAST_REAL_GIT']\n"
            "os.execv(real, [real, *sys.argv[1:]])\n",
            encoding="utf-8",
        )
        shim.chmod(0o755)
        env = {
            "PATH": f"{shim_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "AMBERCAST_GIT_CALL_LOG": str(log),
            "AMBERCAST_REAL_GIT": str(real_git),
        }
        result = self.run_command(command, {"cwd": str(self.root)}, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(strict_json_loads(result.stdout).get("decision"), "block")
        calls = [strict_json_loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        root = str(self.root.resolve())
        self.assertEqual(
            calls,
            [
                ["rev-parse", "--show-toplevel"],
                ["-C", root, "rev-parse", "--show-toplevel"],
                ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"],
                ["-C", root, "rev-parse", "HEAD"],
                ["-C", root, "diff", "HEAD"],
                ["-C", root, "ls-files", "--others", "--exclude-standard"],
            ],
        )
        self.assertEqual(len(calls), 6)
        self.assertIn("timeout=5", command)
        self.assertGreater(40, len(calls) * 5)

    def test_each_inline_verifier_reads_each_member_once_and_reuses_captured_bytes(self) -> None:
        definitions = [
            ("git", self.command("PreToolUse", 0)),
            ("phase", self.command("PreToolUse", 1)),
            ("stop", self.command("Stop", 0)),
        ]
        adapter_a = (
            b"import json, types\n"
            b"expected = b\"SENTINEL = 'captured-shared-A'\\n\"\n"
            b"assert __ambercast_shared_bytes__ == expected\n"
            b"shared = types.ModuleType('captured_shared')\n"
            b"exec(compile(__ambercast_shared_bytes__, __ambercast_shared_path__, 'exec'), shared.__dict__)\n"
            b"assert shared.SENTINEL == 'captured-shared-A'\n"
            b"print(json.dumps({'captured': 'A'}))\n"
        )
        shared_a = b"SENTINEL = 'captured-shared-A'\n"
        poisoned_b = b"raise RuntimeError('path was reopened after capture')\n"

        for name, command in definitions:
            with self.subTest(adapter=name), tempfile.TemporaryDirectory(
                prefix=f"one-read-{name}-"
            ) as temporary:
                root = pathlib.Path(temporary).resolve()
                adapter_relative, shared_relative = BUNDLES[name]
                adapter = root / adapter_relative
                shared = root / shared_relative
                adapter.parent.mkdir(parents=True)
                shared.parent.mkdir(parents=True)
                adapter.write_bytes(adapter_a)
                shared.write_bytes(shared_a)
                subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
                expected = bundle_digest(root, (adapter_relative, shared_relative))
                script = shlex.split(command)[4]
                reads = {adapter.resolve(): 0, shared.resolve(): 0}
                mutated: set[pathlib.Path] = set()
                real_builtin_open = builtins.open
                real_io_open = io.open
                real_os_open = os.open
                real_os_read = os.read
                fd_paths: dict[int, pathlib.Path] = {}

                class CapturedReader:
                    def __init__(self, wrapped: object, path: pathlib.Path) -> None:
                        self.wrapped = wrapped
                        self.path = path

                    def __enter__(self):
                        self.wrapped.__enter__()
                        return self

                    def __exit__(self, *args: object):
                        return self.wrapped.__exit__(*args)

                    def __getattr__(self, attribute: str):
                        return getattr(self.wrapped, attribute)

                    def read(self, *args: object, **kwargs: object):
                        data = self.wrapped.read(*args, **kwargs)
                        if self.path not in mutated:
                            mutated.add(self.path)
                            self.path.write_bytes(poisoned_b)
                        return data

                def tracked_path(file: object) -> pathlib.Path | None:
                    try:
                        path = pathlib.Path(file).resolve()
                    except (TypeError, ValueError, OSError):
                        return None
                    return path if path in reads else None

                def wrap_open(open_function, file: object, *args: object, **kwargs: object):
                    wrapped = open_function(file, *args, **kwargs)
                    mode = kwargs.get("mode", args[0] if args else "r")
                    path = tracked_path(file)
                    if path is not None and "r" in str(mode):
                        reads[path] += 1
                        return CapturedReader(wrapped, path)
                    return wrapped

                def tracked_builtin_open(file: object, *args: object, **kwargs: object):
                    return wrap_open(real_builtin_open, file, *args, **kwargs)

                def tracked_io_open(file: object, *args: object, **kwargs: object):
                    return wrap_open(real_io_open, file, *args, **kwargs)

                def tracked_os_open(file: object, flags: int, *args: object, **kwargs: object):
                    descriptor = real_os_open(file, flags, *args, **kwargs)
                    path = tracked_path(file)
                    if path is not None and flags & os.O_WRONLY == 0 and flags & os.O_RDWR == 0:
                        reads[path] += 1
                        fd_paths[descriptor] = path
                    return descriptor

                def tracked_os_read(descriptor: int, amount: int) -> bytes:
                    data = real_os_read(descriptor, amount)
                    path = fd_paths.get(descriptor)
                    if path is not None and path not in mutated:
                        mutated.add(path)
                        path.write_bytes(poisoned_b)
                    return data

                previous_argv = sys.argv
                previous_cwd = pathlib.Path.cwd()
                stdout, stderr = io.StringIO(), io.StringIO()
                try:
                    sys.argv = ["-c", expected, adapter_relative, shared_relative]
                    os.chdir(root)
                    with (
                        mock.patch.object(builtins, "open", tracked_builtin_open),
                        mock.patch.object(io, "open", tracked_io_open),
                        mock.patch.object(os, "open", tracked_os_open),
                        mock.patch.object(os, "read", tracked_os_read),
                        redirect_stdout(stdout),
                        redirect_stderr(stderr),
                    ):
                        exec(compile(script, f"<{name}-inline-verifier>", "exec"), {"__name__": "__main__"})
                finally:
                    os.chdir(previous_cwd)
                    sys.argv = previous_argv

                self.assertEqual(stderr.getvalue(), "")
                self.assertEqual(strict_json_loads(stdout.getvalue()), {"captured": "A"})
                self.assertEqual(reads, {adapter.resolve(): 1, shared.resolve(): 1})
                self.assertEqual(mutated, {adapter.resolve(), shared.resolve()})
                self.assertEqual(adapter.read_bytes(), poisoned_b)
                self.assertEqual(shared.read_bytes(), poisoned_b)

    def test_every_integrity_failure_mode_covers_both_members_and_all_adapters(self) -> None:
        definitions = [
            ("git", self.command("PreToolUse", 0), {"cwd": str(self.root), "tool_input": {"command": "git status"}}),
            ("phase", self.command("PreToolUse", 1), {"cwd": str(self.root), "tool_input": {"file_path": "README.md"}}),
            ("stop", self.command("Stop", 0), {"cwd": str(self.root)}),
        ]
        modes = ("tamper", "missing", "symlink", "nonregular", "unreadable")
        for adapter_name, command, payload in definitions:
            for relative in BUNDLES[adapter_name]:
                for mode in modes:
                    with self.subTest(adapter=adapter_name, member=relative, mode=mode):
                        if mode == "unreadable" and hasattr(os, "geteuid") and os.geteuid() == 0:
                            self.skipTest("root can read mode-000 files")
                        member = self.root / relative
                        original = member.read_bytes()
                        original_mode = member.stat().st_mode
                        outside = (
                            pathlib.Path(self._temp.name)
                            / f"outside-{adapter_name}-{mode}-{self.integrity_sentinel}.py"
                        )
                        try:
                            if mode == "tamper":
                                member.write_bytes(
                                    original
                                    + f"\n# {self.integrity_sentinel}\n".encode("utf-8")
                                )
                            elif mode == "missing":
                                member.unlink()
                            elif mode == "symlink":
                                outside.write_bytes(original)
                                member.unlink()
                                member.symlink_to(outside)
                            elif mode == "nonregular":
                                member.unlink()
                                member.mkdir()
                            elif mode == "unreadable":
                                member.chmod(0)
                            result = self.run_command(command, payload)
                            self.assertNotIn(
                                self.integrity_sentinel,
                                result.stdout + result.stderr,
                            )
                            diagnostic = (
                                "bundle digest mismatch."
                                if mode == "tamper"
                                else "bundle integrity could not be verified."
                            )
                            if adapter_name == "stop":
                                expected = json.dumps(
                                    {
                                        "continue": False,
                                        "systemMessage": f"Ambercast Stop hook {diagnostic}",
                                    },
                                    separators=(",", ":"),
                                ) + "\n"
                                self.assertEqual(
                                    (result.returncode, result.stdout, result.stderr),
                                    (0, expected, ""),
                                )
                            else:
                                self.assertEqual(
                                    (result.returncode, result.stdout, result.stderr),
                                    (
                                        2,
                                        "",
                                        f"BLOCKED: Ambercast hook {diagnostic}\n",
                                    ),
                                )
                        finally:
                            if member.is_symlink() or member.is_file():
                                member.chmod(original_mode)
                                member.unlink()
                            elif member.exists():
                                member.rmdir()
                            member.write_bytes(original)
                            member.chmod(original_mode)
                            if outside.exists():
                                outside.unlink()

    def test_rootless_launcher_failure_directions_cover_every_definition(self) -> None:
        sentinel = "SECRET-LAUNCHER-ROOT-PATH"
        rootless = pathlib.Path(self._temp.name) / sentinel
        rootless.mkdir()
        definitions = [
            (self.command("PreToolUse", 0), {"cwd": str(rootless)}, False),
            (self.command("PreToolUse", 1), {"cwd": str(rootless)}, False),
            (self.command("Stop", 0), {"cwd": str(rootless)}, True),
        ]
        for command, payload, is_stop in definitions:
            with self.subTest(is_stop=is_stop):
                result = self.run_command(command, payload, cwd=rootless)
                self.assertNotIn(sentinel, result.stdout + result.stderr)
                if is_stop:
                    self.assertEqual(
                        result.stdout,
                        '{"continue":false,"systemMessage":"Ambercast Stop hook root could not be verified."}\n',
                    )
                    self.assertEqual((result.returncode, result.stderr), (0, ""))
                else:
                    self.assertEqual(
                        (result.returncode, result.stdout, result.stderr),
                        (2, "", "BLOCKED: Ambercast hook root could not be verified.\n"),
                    )

    def test_stop_integrity_precedes_kill_switch_and_remains_json_only(self) -> None:
        command = self.command("Stop", 0)
        member = self.root / BUNDLES["stop"][1]
        original = member.read_bytes()
        try:
            member.write_bytes(original + b"\n# invalid digest\n")
            result = self.run_command(
                command,
                {"cwd": str(self.root)},
                env={"AMBERCAST_GUARD_STOP": "0"},
            )
        finally:
            member.write_bytes(original)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        warning = strict_json_loads(result.stdout)
        self.assertEqual(set(warning), {"continue", "systemMessage"})
        self.assertIs(warning["continue"], False)
        self.assertIsInstance(warning["systemMessage"], str)
        self.assertNotEqual(warning["systemMessage"], "")

    def test_tamper_blocks_pretool_and_terminates_stop(self) -> None:
        git_command = self.command("PreToolUse", 0)
        (self.root / BUNDLES["git"][0]).write_text("# tampered\n", encoding="utf-8")
        git_result = self.run_command(
            git_command,
            {"cwd": str(self.root), "tool_input": {"command": "git status"}},
        )
        self.assertEqual(git_result.returncode, 2)
        self.assertIn("digest", git_result.stderr.lower())

        stop_command = self.command("Stop", 0)
        (self.root / BUNDLES["stop"][0]).write_text("# tampered\n", encoding="utf-8")
        stop_result = self.run_command(stop_command, {"cwd": str(self.root)})
        self.assertEqual(stop_result.returncode, 0)
        self.assertEqual(
            set(json.loads(stop_result.stdout)), {"continue", "systemMessage"}
        )

    def test_missing_symlinked_and_nonregular_member_are_rejected_before_execution(self) -> None:
        command = self.command("PreToolUse", 0)
        adapter = self.root / BUNDLES["git"][0]
        original = adapter.read_bytes()
        adapter.unlink()
        missing = self.run_command(
            command, {"cwd": str(self.root), "tool_input": {"command": "git status"}}
        )
        self.assertEqual(missing.returncode, 2)

        outside = pathlib.Path(self._temp.name) / "outside.py"
        outside.write_bytes(original)
        adapter.symlink_to(outside)
        symlinked = self.run_command(
            command, {"cwd": str(self.root), "tool_input": {"command": "git status"}}
        )
        self.assertEqual(symlinked.returncode, 2)

        adapter.unlink()
        adapter.mkdir()
        nonregular = self.run_command(
            command, {"cwd": str(self.root), "tool_input": {"command": "git status"}}
        )
        self.assertEqual(nonregular.returncode, 2)

    def test_isolation_ignores_cwd_pythonpath_user_site_and_shadow_bytecode(self) -> None:
        command = self.command("PreToolUse", 0)
        marker = pathlib.Path(self._temp.name) / "executed"
        shadow = self.root / "json.py"
        shadow.write_text(f"open({str(marker)!r}, 'w').write('cwd')\n", encoding="utf-8")
        pythonpath = pathlib.Path(self._temp.name) / "pythonpath"
        pythonpath.mkdir()
        (pythonpath / "pathlib.py").write_text(
            f"open({str(marker)!r}, 'w').write('path')\n", encoding="utf-8"
        )
        (pythonpath / "sitecustomize.py").write_text(
            f"open({str(marker)!r}, 'w').write('pythonpath-site')\n",
            encoding="utf-8",
        )
        (self.root / ".codex/hooks/types.py").write_text(
            f"open({str(marker)!r}, 'w').write('script-directory')\n",
            encoding="utf-8",
        )
        user_base = pathlib.Path(self._temp.name) / "user-base"
        user_site = (
            user_base
            / "lib"
            / f"python{sys.version_info.major}.{sys.version_info.minor}"
            / "site-packages"
        )
        user_site.mkdir(parents=True)
        (user_site / "sitecustomize.py").write_text(
            f"open({str(marker)!r}, 'w').write('user-site')\n", encoding="utf-8"
        )
        malicious_source = pathlib.Path(self._temp.name) / "malicious-hashlib.py"
        malicious_source.write_text(
            f"open({str(marker)!r}, 'w').write('sourceless-pyc')\n",
            encoding="utf-8",
        )
        cache_dir = self.root / "__pycache__"
        cache_dir.mkdir()
        py_compile.compile(
            str(malicious_source),
            cfile=str(cache_dir / f"hashlib.{sys.implementation.cache_tag}.pyc"),
            doraise=True,
        )
        py_compile.compile(
            str(malicious_source),
            cfile=str(self.root / "hashlib.pyc"),
            doraise=True,
        )
        malicious_source.unlink()
        result = self.run_command(
            command,
            {"cwd": str(self.root), "tool_input": {"command": "git status"}},
            env={"PYTHONPATH": str(pythonpath), "PYTHONUSERBASE": str(user_base)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())


class AdapterCatchBoundaryRedactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="adapter-redaction-")
        self.root = pathlib.Path(self._temp.name).resolve()
        (self.root / "src").mkdir()
        self.modules = {
            "git": load_adapter_module("guard_git.py"),
            "phase": load_adapter_module("guard_phase.py"),
            "stop": load_adapter_module("guard_stop.py"),
        }
        self.payloads = {
            "git": {"cwd": str(self.root), "tool_input": {"command": "git status"}},
            "phase": {"cwd": str(self.root), "tool_input": {"file_path": "src/a.ts"}},
            "stop": {"cwd": str(self.root)},
        }

    def tearDown(self) -> None:
        self._temp.cleanup()

    def assert_redacted_failure(
        self, name: str, result: int, stdout: str, stderr: str, sentinel: str
    ) -> None:
        self.assertNotIn(sentinel, stdout + stderr)
        if name == "stop":
            self.assertEqual(result, 0)
            self.assertEqual(stderr, "")
            warning = strict_json_loads(stdout)
            self.assertIsInstance(warning, dict)
            self.assertEqual(set(warning), {"continue", "systemMessage"})
            self.assertIs(warning["continue"], False)
        else:
            self.assertEqual(result, 2)
            self.assertEqual(stdout, "")
            self.assertNotEqual(stderr, "")

    def test_shared_compile_failure_secret_is_redacted_by_every_adapter(self) -> None:
        sentinel = "SECRET-SHARED-COMPILE-CONTENT"
        source = f"raise RuntimeError({sentinel!r})\n".encode()
        for name, module in self.modules.items():
            shared_path = self.root / f"shared-{name}.py"
            shared_path.write_bytes(b"path content must not be reopened\n")
            with self.subTest(adapter=name), mock.patch.dict(os.environ, {}, clear=True):
                with (
                    mock.patch.object(module, "verified_root", return_value=str(self.root)),
                    mock.patch.object(module, "project_root", return_value=str(self.root)),
                    mock.patch.object(module, "__ambercast_verified_root__", str(self.root), create=True),
                    mock.patch.object(module, "__ambercast_shared_path__", str(shared_path), create=True),
                    mock.patch.object(module, "__ambercast_shared_bytes__", source, create=True),
                ):
                    result, stdout, stderr = invoke_adapter_main(
                        module, self.payloads[name]
                    )
                self.assert_redacted_failure(name, result, stdout, stderr, sentinel)

    def test_shared_evaluate_failure_secret_is_redacted_by_every_adapter(self) -> None:
        sentinel = "SECRET-SHARED-EVALUATE-CONTENT"
        for name, module in self.modules.items():
            shared = types.ModuleType(f"raising_shared_{name}")
            shared.subprocess = subprocess
            if name == "phase":
                shared.resolve_owning_worktree = lambda path, anchor: str(self.root)
                shared.evaluate = lambda path, data: (_ for _ in ()).throw(
                    RuntimeError(sentinel)
                )
            elif name == "git":
                shared.evaluate = lambda command, data: (_ for _ in ()).throw(
                    RuntimeError(sentinel)
                )
            else:
                shared.current_branch = lambda root: "issues/123"
                shared.evaluate = lambda root, branch, session_id: (_ for _ in ()).throw(
                    RuntimeError(sentinel)
                )
            with self.subTest(adapter=name), mock.patch.dict(os.environ, {}, clear=True):
                with (
                    mock.patch.object(module, "verified_root", return_value=str(self.root)),
                    mock.patch.object(module, "project_root", return_value=str(self.root)),
                    mock.patch.object(module, "load_shared_guard", return_value=shared),
                ):
                    result, stdout, stderr = invoke_adapter_main(
                        module, self.payloads[name]
                    )
                self.assert_redacted_failure(name, result, stdout, stderr, sentinel)

    def test_shared_loader_exception_secret_is_redacted_by_every_adapter(self) -> None:
        sentinel = "SECRET-SHARED-LOADER-EXCEPTION"
        for name, module in self.modules.items():
            with self.subTest(adapter=name), mock.patch.dict(os.environ, {}, clear=True):
                with (
                    mock.patch.object(module, "verified_root", return_value=str(self.root)),
                    mock.patch.object(module, "project_root", return_value=str(self.root)),
                    mock.patch.object(
                        module,
                        "load_shared_guard",
                        side_effect=RuntimeError(sentinel),
                    ),
                ):
                    result, stdout, stderr = invoke_adapter_main(
                        module, self.payloads[name]
                    )
                self.assert_redacted_failure(name, result, stdout, stderr, sentinel)

    def test_phase_cached_probe_exception_secret_is_redacted_after_shared_catches_it(self) -> None:
        sentinel = "SECRET-CACHED-PROBE-EXCEPTION"
        module = self.modules["phase"]
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.side_effect = subprocess.TimeoutExpired(
            ["git", sentinel], 5, stderr=sentinel
        )
        shared = types.ModuleType("caught_probe_shared_phase")
        shared.subprocess = runner
        shared.resolve_owning_worktree = lambda path, anchor: str(self.root)

        def evaluate(path: str, data: dict) -> None:
            try:
                shared.subprocess.run(
                    ["git", "status"], capture_output=True, text=True, timeout=5
                )
            except (OSError, shared.subprocess.SubprocessError):
                return None
            return None

        shared.evaluate = evaluate
        with mock.patch.dict(os.environ, {}, clear=True):
            with (
                mock.patch.object(module, "verified_root", return_value=str(self.root)),
                mock.patch.object(module, "project_root", return_value=str(self.root)),
                mock.patch.object(module, "load_shared_guard", return_value=shared),
            ):
                result, stdout, stderr = invoke_adapter_main(
                    module, self.payloads["phase"]
                )
        self.assert_redacted_failure("phase", result, stdout, stderr, sentinel)
        self.assertEqual(runner.run.call_count, 1)


class AdapterProjectRootProbeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="adapter-root-probe-")).resolve()
        self.modules = {
            "git": load_adapter_module("guard_git.py"),
            "phase": load_adapter_module("guard_phase.py"),
            "stop": load_adapter_module("guard_stop.py"),
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def test_each_project_root_uses_exact_bounded_git_probe(self) -> None:
        expected_argv = [
            "git", "-C", str(self.root), "rev-parse", "--show-toplevel"
        ]
        for name, module in self.modules.items():
            with self.subTest(adapter=name):
                completed = subprocess.CompletedProcess(
                    expected_argv, 0, f"{self.root}\n", ""
                )
                with (
                    mock.patch.object(module, "verified_root", return_value=str(self.root)),
                    mock.patch.object(subprocess, "run", return_value=completed) as run,
                ):
                    resolved = module.project_root({"cwd": str(self.root)})
                self.assertEqual(resolved, str(self.root))
                run.assert_called_once_with(
                    expected_argv,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )

    def test_underlying_root_probe_timeout_has_adapter_specific_fail_direction(self) -> None:
        payloads = {
            "git": {"cwd": str(self.root), "tool_input": {"command": "git status"}},
            "phase": {"cwd": str(self.root), "tool_input": {"file_path": "README.md"}},
            "stop": {"cwd": str(self.root)},
        }
        sentinel = "SECRET-UNDERLYING-ROOT-TIMEOUT"
        for name, module in self.modules.items():
            with self.subTest(adapter=name), mock.patch.dict(os.environ, {}, clear=True):
                with (
                    mock.patch.object(module, "verified_root", return_value=str(self.root)),
                    mock.patch.object(
                        subprocess,
                        "run",
                        side_effect=subprocess.TimeoutExpired(["git", sentinel], 5),
                    ),
                ):
                    result, stdout, stderr = invoke_adapter_main(module, payloads[name])
                self.assertNotIn(sentinel, stdout + stderr)
                if name == "stop":
                    self.assertEqual(result, 0)
                    self.assertEqual(stderr, "")
                    warning = strict_json_loads(stdout)
                    self.assertEqual(set(warning), {"continue", "systemMessage"})
                    self.assertIs(warning["continue"], False)
                else:
                    self.assertEqual(result, 2)
                    self.assertEqual(stdout, "")
                    self.assertNotEqual(stderr, "")


class ProjectConfigurationContractTests(unittest.TestCase):
    def test_scalar_toml_parser_rejects_duplicate_keys_and_sections(self) -> None:
        with self.assertRaises(ValueError):
            parse_toml('name = "one"\nname = "two"\n')
        with self.assertRaises(ValueError):
            parse_toml('[agents]\nenabled = true\n[agents]\nenabled = true\n')
        with self.assertRaises(ValueError):
            require_exact_keys({"name": "x", "invented": True}, {"name"}, "role")

    def test_global_project_config_has_exact_orchestrator_and_hook_values(self) -> None:
        config = parse_toml((REPO_ROOT / ".codex/config.toml").read_text(encoding="utf-8"))
        self.assertEqual(config.get("approval_policy"), "on-request")
        self.assertEqual(config.get("approvals_reviewer"), "auto_review")
        self.assertEqual(config.get("default_permissions"), ":workspace")
        self.assertEqual(
            config.get("agents"),
            {
                "enabled": True,
                "max_concurrent_threads_per_session": 8,
                "default_subagent_model": "gpt-5.6-terra",
                "default_subagent_reasoning_effort": "medium",
                "interrupt_message": True,
            },
        )
        self.assertEqual(config.get("features"), {"hooks": True, "goals": True})
        self.assertEqual(
            set(config),
            {
                "approval_policy", "approvals_reviewer", "default_permissions",
                "agents", "features",
            },
        )

    def test_standalone_roles_are_unique_and_match_model_matrix(self) -> None:
        expected = {
            "ambercast-plan-reviewer.toml": ("ambercast_plan_reviewer", "gpt-5.6-sol", "high", "read-only"),
            "ambercast-worker.toml": ("ambercast_worker", "gpt-5.6-sol", "high", "workspace-write"),
            "review-mapper.toml": ("review_mapper", "gpt-5.6-luna", "medium", "read-only"),
            "correctness-reviewer.toml": ("correctness_reviewer", "gpt-5.6-sol", "high", "read-only"),
            "test-reviewer.toml": ("test_reviewer", "gpt-5.6-sol", "high", "read-only"),
            "security-reviewer.toml": ("security_reviewer", "gpt-5.6-sol", "high", "read-only"),
        }
        files = sorted((REPO_ROOT / ".codex/agents").glob("*.toml"))
        self.assertEqual({path.name for path in files}, set(expected))
        names: list[str] = []
        for path in files:
            config = parse_toml(path.read_text(encoding="utf-8"))
            require_exact_keys(
                config,
                {
                    "name", "description", "model", "model_reasoning_effort",
                    "sandbox_mode", "developer_instructions",
                },
                path.name,
            )
            actual = (
                config.get("name"), config.get("model"),
                config.get("model_reasoning_effort"), config.get("sandbox_mode"),
            )
            self.assertEqual(actual, expected[path.name])
            self.assertIsInstance(config.get("developer_instructions"), str)
            names.append(config["name"])
        self.assertEqual(len(names), len(set(names)))

    def test_reviewer_instructions_forbid_writes_delegation_and_cross_model_calls(self) -> None:
        for path in sorted((REPO_ROOT / ".codex/agents").glob("*reviewer.toml")) + [
            REPO_ROOT / ".codex/agents/review-mapper.toml"
        ]:
            instructions = parse_toml(path.read_text(encoding="utf-8"))[
                "developer_instructions"
            ].lower()
            self.assertRegex(
                instructions,
                r"do not[^.\n]*(?:edit|write)|(?:do not[^.\n]*)?edit files",
                path.name,
            )
            self.assertRegex(instructions, r"do not .*spawn|do not .*delegate")
            self.assertRegex(
                instructions,
                r"do not[^.\n]*invoke claude or codex",
                path.name,
            )

    def test_worker_is_bounded_and_cannot_mutate_flow_or_git_lifecycle(self) -> None:
        worker = parse_toml(
            (REPO_ROOT / ".codex/agents/ambercast-worker.toml").read_text(encoding="utf-8")
        )["developer_instructions"].lower()
        for phrase in ("scope", ".claude/impl/", "do not commit", "push", "merge", "claude", "codex"):
            self.assertIn(phrase, worker)
        self.assertRegex(worker, r"do not[^.\n]*invoke claude or codex")


class SkillAndRepositoryContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skill_path = REPO_ROOT / ".agents/skills/ambercast-implementation/SKILL.md"
        self.skill = self.skill_path.read_text(encoding="utf-8")
        self.agents = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.canonical = (
            REPO_ROOT / ".claude/skills/implement/SKILL.md"
        ).read_text(encoding="utf-8")
        self.rule = (
            REPO_ROOT / ".claude/rules/implementation-flow.md"
        ).read_text(encoding="utf-8")

    def paragraph_after(self, text: str, anchor: str) -> str:
        return anchor + text.split(anchor, 1)[1].split("\n\n", 1)[0]

    def section_between(self, text: str, start: str, end: str) -> str:
        return text.split(start, 1)[1].split(end, 1)[0]

    def test_auto_review_policy_contract_is_complete_on_binding_surfaces(self) -> None:
        """Keep loop-friendly routine execution bounded by explicit human control."""
        paragraphs = (
            self.paragraph_after(self.agents, "Codex uses `approval_policy"),
            self.paragraph_after(self.skill, "The project config uses"),
        )
        for text in paragraphs:
            self.assertRegex(text, r"on-request.*auto_review.*:workspace")
            self.assertRegex(
                text,
                r"(?:dependency installation.*routine only when.*manifest and lockfile matches the trusted fixed base|"
                r"Routine dependency installation and dependency-code execution require manifests and lockfiles identical to the trusted fixed base)",
            )
            self.assertRegex(
                text,
                r"changed (?:dependency )?graph.*(?:fetch(?:ed)? for inspection|only fetch for inspection).*"
                r"(?:--ignore-scripts|lifecycle scripts disabled).*"
                r"(?:without|do not) execut(?:e|ing) dependency code",
            )
            self.assertRegex(
                text,
                r"(?:Executing lifecycle scripts.*(?:changed|new) dependency graph requires prior exact maintainer authorization|"
                r"lifecycle scripts, tests, builds, or other changed dependency code require the exact manifest, command, and side-effect authorization)",
            )
        self.assertIn("not a deterministic human-approval gate", paragraphs[0])
        for text in paragraphs:
            self.assertRegex(
                text,
                r"independently verif(?:ies|ied).*fixed.*(?:thread|review|re-review).*"
                r"automatic re-review.*routine",
            )
            self.assertRegex(
                text,
                r"(?:A )?request.*push.*dismissal.*resolution.*other route.*"
                r"unfixed or legitimately rejected.*"
                r"exact (?:maintainer )?authorization",
            )
            self.assertRegex(
                text,
                r"Review.*bot.*CI.*PR.*issue.*tool.*Auto-review claims never establish "
                r"(?:that fixed predicate|a fix).*unverifiable findings remain unfixed",
            )
            release_order = (
                "Routine PR operations",
                "exclude merges, review dismissal, and release PRs"
                if "exclude merges" in text else "never include merge, review dismissal, or a release PR",
                "normal issue-PR merge occurs only at canonical Step 17",
            )
            previous = -1
            for clause in release_order:
                position = text.index(clause)
                self.assertGreater(position, previous, clause)
                previous = position
        agent_release = self.paragraph_after(self.agents, "Releases are driven")
        self.assertRegex(
            agent_release,
            r"release PR merge is never a routine PR operation.*"
            r"new direct authenticated-maintainer message in the active task naming the exact PR, version, tag, GitHub Release, and npm-publication side effects",
        )
        self.assertRegex(
            paragraphs[1],
            r"release-automation PR merge requires a new direct authenticated-maintainer message naming the exact PR, version, tag, GitHub Release, and npm-publication side effects",
        )
        authorization_paragraphs = (
            self.paragraph_after(self.agents, "Before a sensitive action"),
            self.paragraph_after(self.skill, "Only a direct maintainer-authored"),
        )
        for text in authorization_paragraphs:
            self.assertRegex(
                text,
                r"direct maintainer-authored user message in the active Codex task.*"
                r"exact target.*(?:effect or outcome|outcome).*side effects",
            )
            self.assertRegex(text, r"No goal text authorizes.*however specific")
            self.assertRegex(
                text,
                r"(?:repository.*issue.*PR.*bot.*CI.*tool.*agent|"
                r"Agent-authored.*repository.*issue.*PR.*bot.*CI.*tool).*"
                r"never authoriz",
            )

    def test_sensitive_action_categories_and_untrusted_fix_boundary_are_explicit(self) -> None:
        authorization = self.section_between(
            self.agents, "Before a sensitive action", "An Auto-review denial"
        )
        required_categories = (
            "destructive or irreversible",
            "production deployment", "shared-infrastructure",
            "secrets or credentials", "granting privileges", "IAM",
            "force-pushing", "branch protection",
            "unrelated external state", "CHANGES_REQUESTED",
            "unfixed review thread", "merge eligibility",
            "executing lifecycle scripts, tests, builds, or other dependency code",
            "merging a release-please or other release-automation PR",
            "safety controls",
        )
        lead = "Prior exact authorization is required for:"
        previous = authorization.index(lead)
        for category in required_categories:
            position = authorization.index(category)
            self.assertGreater(position, previous, category)
            previous = position
        self.assertRegex(authorization, r"rewriting `?main`? history")
        self.assertRegex(
            authorization,
            r"release-automation PR.*direct authorization must name the exact PR and version plus the tag, Release, and npm-publication side effects",
        )

    def test_routine_long_running_operations_remain_explicit(self) -> None:
        policy = self.paragraph_after(self.agents, "Codex uses `approval_policy")
        ordered = (
            "Workspace edits, checks, tests, builds",
            "guarded issue-branch commits and pushes",
            "ordinary issue-PR creation/update/comment/observation",
            "CI observation",
            "review remediation after fixing the underlying finding",
        )
        previous = -1
        for clause in ordered:
            position = policy.index(clause)
            self.assertGreater(position, previous, clause)
            previous = position
        self.assertRegex(policy, r"Routine PR operations never include merge, review dismissal, or a release PR")
        self.assertRegex(
            policy,
            r"normal issue-PR merge occurs only at canonical Step 17 after required checks pass and review conversations are resolved; "
            r"it does not acquire an additional approval requirement here",
        )
        self.assertRegex(
            policy,
            r"PR that changes the workflow control surface separately requires its existing authenticated maintainer approving review",
        )
        adapter_policy = self.paragraph_after(self.skill, "The project config uses")
        self.assertRegex(
            adapter_policy,
            r"normal issue-PR merge occurs only at canonical Step 17 after required checks pass and conversations are resolved; "
            r"only workflow-control PRs add the existing authenticated maintainer approving-review requirement",
        )

    def test_denial_state_machine_fails_closed_and_cannot_source_authorization(self) -> None:
        paragraphs = (
            self.paragraph_after(self.agents, "An Auto-review denial is a stop signal."),
            self.paragraph_after(self.skill, "Treat an Auto-review denial as a stop signal."),
        )
        for text in paragraphs:
            self.assertRegex(
                text,
                r"any route.*denied requested effect or outcome.*equivalent.*"
                r"regardless of command.*intermediate step.*alternate target",
            )
            self.assertRegex(
                text,
                r"A (?:denied )?worker, subagent, or reviewer writes nothing.*"
                r"never retries.*(?:returns|reports) the exact",
            )
            if "first checks for a materially safer" in text:
                self.assertRegex(
                    text,
                    r"reports the exact denial fields to the active driver.*"
                    r"first checks for a materially safer non-equivalent path.*"
                    r"Only when no such path exists.*does the driver set `?paused=true`? first.*"
                    r"sole permitted follow-up tool action.*issue-<N>-denial\.md",
                )
            else:
                self.assertRegex(
                    text,
                    r"returns the exact .* to the driver.*"
                    r"If no non-equivalent safe path exists.*first set `?paused=true`?.*"
                    r"only permitted follow-up tool action.*issue-<N>-denial\.md",
                )
            self.assertRegex(text, r"provenance=driver-observed.*provenance=untrusted-child-report")
            self.assertRegex(text, r"adopt.*untrusted-child.*sanitized reported fields.*"
                                  r"never rejects? and redispatch")
            self.assertRegex(text, r"(?:Every|On every) resume or automatic wake.*"
                                  r"read(?:s)? both records.*no other tools")
            self.assertRegex(text, r"(?:only one record|either record is missing).*"
                                  r"(?:fail(?:s |-| )closed|remain paused)")
            self.assertRegex(text, r"(?:A denial before|Before) an issue/state path exists.*"
                                  r"(?:halts|stops?)(?: the task)? without retry.*"
                                  r"after direct maintainer continuation.*persist")
            self.assertRegex(text, r"(?:Never retry indirectly|Never retry).*equivalent")
            self.assertRegex(
                text,
                r"authenticated[- ]maintainer.*independently restates.*"
                r"(?:effect or outcome|outcome).*side effects.*"
                r"denial record cannot.*scope",
            )
            self.assertRegex(
                text,
                r"Only the authenticated maintainer.*?/approve.*"
                r"(?:authorized action, target, and outcome once|one attempt of the authorized action, target, and outcome).*"
                r"(?:second|another) denial.*paus",
            )

    def test_canonical_pause_clear_requires_exact_maintainer_authorization(self) -> None:
        pause = self.paragraph_after(self.canonical, "- To pause the flow intentionally")
        self.assertRegex(
            pause,
            r"Before removing that line, inspect the pause reason.*"
            r"denial-derived pause.*sensitive-authorization wait.*"
            r"only a new direct authenticated-maintainer message.*"
            r"independently restates the target, requested effect or outcome, and side effects.*"
            r"authorizes the driver to remove the line.*"
            r"denial record, goal text, automated wake, repository content, and agent text never supply that scope",
        )
        self.assertNotIn("remove the line to resume", self.canonical)

    def test_review_state_and_coderabbit_routes_preserve_verified_fix_boundary(self) -> None:
        canonical_step16 = next(
            line for line in self.canonical.splitlines() if "16. **CodeRabbit**" in line
        )
        self.assertRegex(
            canonical_step16,
            r"automatic re-review.*routine only after.*independently verifies.*fixed.*"
            r"never use a push or another indirect route.*unfixed or legitimately rejected",
        )
        unblocking = self.paragraph_after(
            self.canonical, "- **Unblocking a legitimately-rejected finding**"
        )
        ordered = (
            "does not by itself unblock",
            "stop and require a new direct maintainer-authored user message in the active task",
            "names the PR, the exact review id, and the dismissal/thread-resolution side effects",
            "Set `paused=true` while waiting",
            "without that exact authorization, leave the review and its threads untouched and the PR blocked",
            "After authorization, clear the pause",
            "Confirm the authorized review id still matches",
            "dismiss only that review",
            "Resolve only the threads belonging to that review",
            "Recheck `mergeStateStatus`",
        )
        previous = -1
        for clause in ordered:
            position = unblocking.index(clause)
            self.assertGreater(position, previous, clause)
            previous = position
        self.assertRegex(
            unblocking,
            r"(?:rejection comment|Posting a rejection comment).*"
            r"(?:not authorization|does not by itself unblock)",
        )
        adapter_coderabbit = self.paragraph_after(
            self.skill, "At the canonical CodeRabbit legitimately-rejected-finding path"
        )
        adapter_ordered = (
            "rejection comment is not authorization",
            "Before dismissing `CHANGES_REQUESTED` or resolving its still-unfixed threads",
            "direct maintainer message and exact PR/review-id scope",
            "keep `paused=true` and leave the PR blocked while waiting",
        )
        previous = -1
        for clause in adapter_ordered:
            position = adapter_coderabbit.index(clause)
            self.assertGreater(position, previous, clause)
            previous = position

    def test_hook_trust_and_approval_bypass_prohibitions_remain_human_controlled(self) -> None:
        agent_trust = self.paragraph_after(self.agents, "Enforcement is layered")
        adapter_trust = self.paragraph_after(
            self.skill, "Current Codex releases discover project hooks"
        )
        self.assertRegex(
            agent_trust,
            r"inspect and explicitly trust all three complete definitions.*"
            r"Hook trust is separate from routine Codex Auto-review: never automate hook trust or use a trust bypass",
        )
        self.assertRegex(
            adapter_trust,
            r"Routine Auto-review never authorizes hook trust: a human must inspect and explicitly trust complete definitions, "
            r"and no agent may use a trust-bypass flag",
        )
        agent_prohibition = self.paragraph_after(self.agents, "Never use `approval_policy")
        adapter_prohibition = self.paragraph_after(self.skill, "Never use `approval_policy")
        for text in (agent_prohibition, adapter_prohibition):
            self.assertRegex(text, r"Never use .*approval_policy = \"never\".*"
                                  r":danger-full-access.*--yolo.*"
                                  r"--dangerously-bypass-approvals-and-sandbox.*"
                                  r"--dangerously-bypass-hook-trust")
            self.assertRegex(text, r"Manual npm publishing.*release[- ]automation.*forbidden")
        for text in (self.agents, self.skill, self.canonical):
            self.assertNotRegex(text, r"(?i)automate\s+approval")

    def test_skill_frontmatter_is_valid_and_dependency_references_are_exact(self) -> None:
        self.assertTrue(self.skill.startswith("---\n"))
        values = skill_frontmatter(self.skill)
        self.assertEqual(values.get("name"), "ambercast-implementation")
        self.assertIn("17-step", values.get("description", ""))
        preflight = self.skill.split("## Load and preflight the shared contract", 1)[1].split("## Orchestrate", 1)[0]
        for dependency in ("$codex-orchestrator", "$cross-model-review", "$claude-consultation"):
            self.assertIn(dependency, preflight)

    def test_skill_frontmatter_rejects_duplicate_and_unknown_keys(self) -> None:
        duplicate = "---\nname: one\nname: two\ndescription: d\n---\nbody\n"
        unknown = "---\nname: one\ndescription: d\nrequires: invented\n---\nbody\n"
        with self.assertRaises(ValueError):
            skill_frontmatter(duplicate)
        with self.assertRaises(ValueError):
            skill_frontmatter(unknown)

    def test_skill_routes_to_canonical_workflow_without_forking_steps(self) -> None:
        self.assertIn(".claude/skills/implement/SKILL.md", self.skill)
        self.assertIn("Do not copy the 17 steps", self.skill)
        self.assertIn("Codex does not copy Claude's `asyncRewake` watchdog", self.skill)
        self.assertIn("safe-mode", self.skill)
        self.assertIn("Never invoke raw `claude -p`", self.skill)

    def test_skill_requires_cross_model_review_roles_at_all_review_gates(self) -> None:
        self.assertIn("steps 8, 10, and 12", self.skill)
        for role in (
            "review_mapper", "correctness_reviewer", "test_reviewer", "security_reviewer"
        ):
            self.assertIn(role, self.skill)
        self.assertIn("independent read-only Claude review", self.skill)
        routing = next(
            line for line in self.skill.splitlines()
            if "current step's specification to every prompt" in line
        )
        self.assertIn("relevant Ambercast comment policy", routing)
        self.assertRegex(routing, r"steps 8, 10, and 12.*every prompt")

    def test_ui_metadata_is_exact(self) -> None:
        interface = yaml_interface(
            REPO_ROOT / ".agents/skills/ambercast-implementation/agents/openai.yaml"
        )
        self.assertEqual(
            interface,
            {
                "display_name": "Ambercast Implementation",
                "short_description": "Run Ambercast’s 17-step flow with Codex as orchestrator",
                "default_prompt": "Implement this Ambercast change through the mandatory cross-model workflow.",
            },
        )

    def test_ui_metadata_parser_rejects_duplicate_and_unknown_interface_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "openai.yaml"
            path.write_text(
                'interface:\n  display_name: "one"\n  display_name: "two"\n',
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                yaml_interface(path)
            path.write_text(
                'interface:\n  display_name: "one"\n  invented: "two"\n',
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                yaml_interface(path)

    def test_repository_contract_names_both_entrypoints_and_dedicated_workflow_pr(self) -> None:
        for text in (self.agents, self.rule):
            self.assertIn("`/implement`", text)
            self.assertIn("`$ambercast-implementation`", text)
            self.assertIn("maintainer-approved", text)
            self.assertIn(".codex/", text)

    def test_pinned_import_contract_is_dependency_closed_on_all_binding_surfaces(self) -> None:
        for text in (self.agents, self.rule, self.skill):
            paragraph = next(
                line for line in text.splitlines()
                if "pinned adapter" in line and "repository-local executable" in line
            )
            self.assertRegex(
                paragraph,
                r"pinned adapter.*may import only.*Python standard library.*"
                r"repository-local executable.*ordered bundle.*"
                r"adding any repository-local executable dependency.*"
                r"(?:requires (?:the )?manifest|requires a manifest) (?:to be )?re-pin",
            )

    def test_binding_rule_names_native_edits_and_forbids_bash_patch_utilities(self) -> None:
        self.assertIn("native `apply_patch`, Edit, or Write events", self.rule)
        self.assertIn(
            "Bash-invoked `patch`, `git apply`, or `apply_patch`",
            self.rule,
        )
        self.assertIn("`src/`, `bin/`, or tests", self.rule)

    def test_first_manifest_bootstrap_is_distinct_from_existing_pin_repin(self) -> None:
        for text in (self.agents, self.rule, self.skill):
            paragraph = next(
                line for line in text.splitlines()
                if "old pin to self-lock" in line and "dedicated workflow PR" in line
            )
            normalized = paragraph.replace("linked-worktree controls", "linked controls")
            self.assertIn("primary `main` already contains a pinned `.codex/hooks.json`", paragraph)
            self.assertLess(paragraph.index("primary `main` already"), paragraph.index("atomic"))
            self.assertLess(paragraph.index("first introduces the manifest") if "first introduces the manifest" in paragraph else paragraph.index("first-manifest bootstrap"), paragraph.index("no old pin to self-lock"))
            self.assertLess(
                paragraph.index("no old pin to self-lock"),
                paragraph.index("dedicated workflow PR", paragraph.index("no old pin to self-lock")),
            )
            merge = next(
                marker for marker in ("post-merge", "After either case merges", "After any workflow merge")
                if marker in normalized
            )
            merge_index = normalized.index(merge)
            rollout = normalized[merge_index:]
            for required in ("primary", "trust", "linked", "controls"):
                self.assertIn(required, rollout)
            self.assertRegex(rollout, r"linked(?: worktree)?[^.]*controls")

    def test_bootstrap_attestation_is_sanitized_durable_and_precedes_removal(self) -> None:
        for text in (self.agents, self.rule, self.skill):
            paragraph = next(
                line for line in text.splitlines() if "sole live canonical" in line
            )
            self.assertIn("Before step 17", paragraph)
            self.assertIn("sanitized durable attestation", paragraph)
            self.assertRegex(
                paragraph,
                r"Before step 17.*sanitized durable attestation.*"
                r"(?:omit|without) absolute paths.*user-local details.*"
                r"include the manifest and ordered-bundle identities.*"
                r"trust/control outcomes.*issue-comment URL",
            )
            if "before removal" in paragraph[paragraph.index("issue-comment URL"):]:
                self.assertLess(paragraph.index("issue-comment URL"), paragraph.rindex("before removal"))
            else:
                self.assertLess(paragraph.index("removes the issue worktree"), paragraph.index("sanitized durable attestation"))
            self.assertLess(
                paragraph.index("Before step 17"),
                paragraph.index("sanitized durable attestation"),
            )
            self.assertLess(
                paragraph.index("sanitized durable attestation"),
                paragraph.index("issue-comment URL"),
            )

    def test_binding_comment_policy_and_public_artifact_boundary_are_preserved(self) -> None:
        self.assertRegex(
            self.agents,
            r"comments/JSDoc as the design spec, emphasizing Why and design-level How.*"
            r"\.claude/rules/implementation-flow\.md",
        )
        self.assertIn("comments are natural prose", self.rule)
        self.assertIn("Labeled section headings", self.rule)
        self.assertIn("written in English", self.rule)
        self.assertRegex(
            self.rule,
            r"Comments and JSDoc are the design document.*Why.*rationale.*"
            r"design-level How.*invariants.*Never restate what adjacent code expresses",
        )
        for phrase in (
            "rejected alternatives",
            "constraints",
            "approach choice",
            "contracts",
            "non-obvious mechanics",
            "copying literal values, string content, or step sequences",
        ):
            self.assertIn(phrase, self.rule)
        self.assertRegex(
            self.rule,
            r"docs-first step.*future implementation.*implementation step must reconcile.*"
            r"timeless present tense.*prune any How the code now expresses directly",
        )
        self.assertRegex(
            self.rule,
            r"Comments never describe the repository's current development status.*"
            r"what existed before an issue.*git history, issues, and PRs carry process context",
        )
        self.assertRegex(
            self.rule,
            r"Shipped comments reference only artifacts that exist in the public repository.*"
            r"references to uncommitted files.*local state.*forbidden",
        )
        self.assertRegex(
            self.rule,
            r"Public API JSDoc is consumer-facing.*behavior, parameters, returns, errors, and examples.*"
            r"@remarks.*summary a library consumer reads",
        )

    def test_claude_index_is_import_only_and_names_both_driver_surfaces(self) -> None:
        actual = tuple(
            line.rstrip()
            for line in (REPO_ROOT / ".claude/CLAUDE.md")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip()
        )
        self.assertEqual(
            actual,
            (
                "# .claude/",
                "- Treat this directory as committed Claude Code configuration; keep local state in the gitignored paths listed below.",
                "- Use `skills/implement/` for the mandatory 17-step `/implement` flow.",
                "- Enforce flow-only implementation, no commits on main, and honest state files through `rules/implementation-flow.md`.",
                "- Use `hooks/guard_git.py` to block commits and pushes on main, compound switch-and-commit commands, and commits outside `issues/<N>` or `issues/<N>-<slug>` branches.",
                "- Use `hooks/guard_phase.py` to block src, bin, and test edits until the required flow steps are complete across rebases and linked worktrees.",
                "- Use `hooks/guard_stop.py` to keep unfinished implementation flows moving while allowing intentional pauses and live background work.",
                "- Use `hooks/watch_progress.py` as the asyncRewake watchdog for stalled issue flows and idle orchestrators.",
                "- Wire Claude Code hooks through `settings.json`.",
                "- Store per-issue state, plans, and review artifacts in the gitignored `impl/` directory.",
                "- Store personal orchestration state in the gitignored `logs/` and `todos/` directories.",
                "- Use `../.agents/skills/` for repo-scoped Agent Skills, including gh-stack and Codex's Ambercast implementation adapter.",
            ),
        )

    def test_gitignore_preserves_active_patterns_and_updates_shared_surface_comment_only(self) -> None:
        text = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        normalized = tuple(
            line.rstrip() for line in text.splitlines() if line.strip()
        )
        self.assertEqual(
            normalized,
            (
                "node_modules/", "dist/", "*.tgz",
                "# local AI agent state (shared Claude/Codex config is committed)",
                ".claude/settings.local.json", ".claude/logs/", ".claude/todos/",
                ".claude/impl/", "CLAUDE.local.md",
                "# product runtime artifacts (run results, screenshots — see AGENTS.md)",
                ".runs/", ".env", ".env.*", "!.env.example", "coverage/", ".DS_Store",
            ),
        )
        active = [
            line for line in text.splitlines()
            if line and not line.lstrip().startswith("#")
        ]
        self.assertEqual(
            active,
            [
                "node_modules/", "dist/", "*.tgz",
                ".claude/settings.local.json", ".claude/logs/", ".claude/todos/",
                ".claude/impl/", "CLAUDE.local.md", ".runs/", ".env", ".env.*",
                "!.env.example", "coverage/", ".DS_Store",
            ],
        )

    def test_stop_skill_forbids_a_synthetic_background_task_bypass(self) -> None:
        paragraph = next(
            line for line in self.skill.splitlines() if "background_tasks" in line
        )
        self.assertIn("Codex Stop events do not expose", paragraph)
        self.assertIn("calls the shared state evaluator directly", paragraph)
        self.assertIn("does not claim or emulate that bypass", paragraph)
        self.assertIn("Do not add", paragraph)

    def test_skill_specifies_recursive_evidence_digest_identity(self) -> None:
        self.assertIn("sorted `.claude/impl/` relative paths and file bytes", self.skill)
        self.assertIn("tracked/untracked status", self.skill)


class PackageAndCiContractTests(unittest.TestCase):
    def test_agent_hook_script_runs_separate_claude_and_codex_discoveries(self) -> None:
        package = strict_json_loads(
            (REPO_ROOT / "package.json").read_text(encoding="utf-8")
        )
        self.assertIsInstance(package, dict)
        script = package.get("scripts", {}).get("test:agent-hooks")
        self.assertIsInstance(script, str)
        if not isinstance(script, str):
            return
        discoveries = [part.strip() for part in script.split("&&")]
        self.assertEqual(len(discoveries), 2)
        self.assertTrue(
            any("unittest discover -s .claude/hooks" in item for item in discoveries)
        )
        self.assertTrue(
            any("unittest discover -s .codex/hooks" in item for item in discoveries)
        )
        self.assertTrue(all("unittest discover" in item for item in discoveries))

    def test_ci_invokes_agent_hook_contract_script(self) -> None:
        workflow = (REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        try:
            contract = parse_agent_hooks_ci(workflow)
        except ValueError as error:
            self.fail(str(error))
        self.assertEqual(contract["versions"], ["3.9", "3.x"])
        self.assertLess(contract["setup_step"], contract["test_step"])

    def test_ci_parser_rejects_out_of_scope_duplicate_misbound_and_reversed_mutations(self) -> None:
        valid = """on:
  pull_request:
jobs:
  agent-hooks:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.9", "3.x"]
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - run: npm run test:agent-hooks
"""
        self.assertEqual(parse_agent_hooks_ci(valid)["versions"], ["3.9", "3.x"])
        mutations = [
            """# python-version: ["3.9", "3.x"]
on:
  pull_request:
jobs:
  agent-hooks:
    runs-on: ubuntu-latest
    env:
      python-version: ["3.9", "3.x"]
    strategy:
      matrix: {}
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python-version }}
      - run: npm run test:agent-hooks
""",
            valid.replace(
                "    strategy:\n      matrix:\n        python-version: [\"3.9\", \"3.x\"]\n",
                "",
            ),
            valid.replace(
                "      - uses: actions/setup-python@v5\n        with:\n          python-version: ${{ matrix.python-version }}\n      - run: npm run test:agent-hooks\n",
                "      - run: npm run test:agent-hooks\n      - uses: actions/setup-python@v5\n        with:\n          python-version: ${{ matrix.python-version }}\n",
            ),
            valid.replace(
                "      - run: npm run test:agent-hooks\n",
                "      - uses: actions/setup-python@v4\n        with:\n          python-version: ${{ matrix.python-version }}\n      - run: npm run test:agent-hooks\n",
            ),
            valid.replace(
                "          python-version: ${{ matrix.python-version }}",
                "          python-version: 3.9",
            ),
            valid.replace("  pull_request:\n", "  push:\n"),
            valid.replace("    runs-on: ubuntu-latest\n", ""),
            valid.replace("    runs-on: ubuntu-latest\n", "    runs-on: \"\"\n"),
            valid.replace("    runs-on: ubuntu-latest\n", "    runs-on: []\n"),
            valid.replace(
                "    runs-on: ubuntu-latest\n",
                "    if: false\n    runs-on: ubuntu-latest\n",
            ),
            valid.replace(
                "    runs-on: ubuntu-latest\n",
                "    continue-on-error: true\n    runs-on: ubuntu-latest\n",
            ),
            valid.replace(
                "      - run: npm run test:agent-hooks\n",
                "      - run: npm run test:agent-hooks\n        if: false\n",
            ),
            valid.replace(
                "      - run: npm run test:agent-hooks\n",
                "      - run: npm run test:agent-hooks\n        continue-on-error: true\n",
            ),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    parse_agent_hooks_ci(mutation)


if __name__ == "__main__":
    if sys.argv[1:]:
        raise SystemExit(print_digest_cli(sys.argv[1:]))
    unittest.main()
