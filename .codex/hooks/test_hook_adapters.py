#!/usr/bin/env python3
"""Integration tests for the Codex Git and Stop adapters."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


HOOKS = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HOOKS.parents[1]
RUNNER = r"""
import pathlib, sys
adapter_path, root, shared_path = sys.argv[1:]
adapter = pathlib.Path(adapter_path).read_bytes()
shared = pathlib.Path(shared_path).read_bytes()
scope = {
    "__name__": "__main__",
    "__file__": adapter_path,
    "__ambercast_verified_root__": root,
    "__ambercast_shared_path__": shared_path,
    "__ambercast_shared_bytes__": shared,
}
exec(compile(adapter, adapter_path, "exec"), scope)
"""


def load(name: str):
    path = HOOKS / name
    spec = importlib.util.spec_from_file_location(f"test_{name[:-3]}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GIT_GUARD = load("guard_git.py")
PHASE_GUARD = load("guard_phase.py")
STOP_GUARD = load("guard_stop.py")

GIT_ENV = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
}


def git(cwd: pathlib.Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
        env={**os.environ, **GIT_ENV},
    )


def invoke_main(module: types.ModuleType, payload: object) -> tuple[int, str, str]:
    """Invoke an adapter main in process while preserving global stdin."""
    stdout, stderr = io.StringIO(), io.StringIO()
    original_stdin = sys.stdin
    sys.stdin = io.StringIO(json.dumps(payload))
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = module.main()
    finally:
        sys.stdin = original_stdin
    return result, stdout.getvalue(), stderr.getvalue()


class AdapterRepositoryCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="ambercast adapters ")
        self.root = pathlib.Path(self._temp.name) / "repo with spaces"
        self.root.mkdir()
        (self.root / ".claude/hooks").mkdir(parents=True)
        (self.root / ".claude/impl").mkdir(parents=True)
        for name in ("guard_git.py", "guard_stop.py"):
            shutil.copy2(
                REPO_ROOT / ".claude/hooks" / name,
                self.root / ".claude/hooks" / name,
            )
        git(self.root, "init", "-q", "-b", "main")
        git(
            self.root,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "initial",
        )

    def tearDown(self) -> None:
        self._temp.cleanup()

    def checkout(self, branch: str) -> None:
        git(self.root, "checkout", "-q", "-b", branch)

    def run_raw(
        self,
        adapter: str,
        raw: str,
        *,
        shared: pathlib.Path | None = None,
        root: pathlib.Path | None = None,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        shared_path = shared or self.root / ".claude/hooks" / adapter
        process_env = {**os.environ, **GIT_ENV}
        process_env.pop("AMBERCAST_GUARD_STOP", None)
        process_env.update(env or {})
        return subprocess.run(
            [
                sys.executable,
                "-I",
                "-S",
                "-c",
                RUNNER,
                str(HOOKS / adapter),
                str((root or self.root).resolve()),
                str(shared_path),
            ],
            cwd=self.root,
            input=raw,
            capture_output=True,
            text=True,
            env=process_env,
        )

    def run_hook(
        self,
        adapter: str,
        payload: object,
        **kwargs: object,
    ) -> subprocess.CompletedProcess[str]:
        return self.run_raw(adapter, json.dumps(payload), **kwargs)


class GitAdapterTests(AdapterRepositoryCase):
    def payload(self, command: object = "git status", **tool: object) -> dict:
        return {
            "cwd": str(self.root),
            "tool_name": "Bash",
            "tool_input": {"command": command, **tool},
        }

    def test_main_commit_blocks_with_codex_guidance_and_status_allows(self) -> None:
        blocked = self.run_hook("guard_git.py", self.payload("git commit -m test"))
        allowed = self.run_hook("guard_git.py", self.payload("git status"))
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("$ambercast-implementation", blocked.stderr)
        self.assertNotIn("Start the /implement", blocked.stderr)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_issue_commit_and_push_are_allowed(self) -> None:
        self.checkout("issues/123")
        commit = self.run_hook("guard_git.py", self.payload("git commit --dry-run"))
        push = self.run_hook("guard_git.py", self.payload("git push --dry-run"))
        self.assertEqual(commit.returncode, 0, commit.stderr)
        self.assertEqual(push.returncode, 0, push.stderr)

    def test_malformed_json_nonobject_and_required_fields_fail_closed(self) -> None:
        results = [
            self.run_raw("guard_git.py", "{bad"),
            self.run_raw("guard_git.py", "[]"),
            self.run_hook("guard_git.py", {"cwd": str(self.root)}),
            self.run_hook(
                "guard_git.py", {"cwd": str(self.root), "tool_input": {}}
            ),
            self.run_hook(
                "guard_git.py",
                {"cwd": str(self.root), "tool_input": {"workdir": str(self.root)}},
            ),
            self.run_hook("guard_git.py", {"tool_input": {"command": "git status"}}),
            self.run_hook(
                "guard_git.py", {"cwd": 7, "tool_input": {"command": "git status"}}
            ),
            self.run_hook("guard_git.py", self.payload(7)),
            self.run_hook(
                "guard_git.py", {"cwd": str(self.root), "tool_input": "bad"}
            ),
        ]
        for result in results:
            self.assertEqual(result.returncode, 2, result.stderr)

    def test_empty_nongit_nonexistent_cwd_and_explicit_null_workdir_block(self) -> None:
        nongit = pathlib.Path(self._temp.name) / "not-a-repo"
        nongit.mkdir()
        nonexistent = pathlib.Path(self._temp.name) / "missing"
        payloads = [
            {"cwd": "", "tool_input": {"command": "git status"}},
            {"cwd": str(nongit), "tool_input": {"command": "git status"}},
            {"cwd": str(nonexistent), "tool_input": {"command": "git status"}},
            self.payload("git status", workdir=None),
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                result = self.run_hook("guard_git.py", payload)
                self.assertEqual(result.returncode, 2)
                self.assertNotEqual(result.stderr, "")

    def test_workdir_must_exist_and_derive_the_verified_worktree(self) -> None:
        nested = self.root / "nested"
        nested.mkdir()
        accepted = self.run_hook(
            "guard_git.py", self.payload("git status", workdir="nested")
        )
        invalid = self.run_hook(
            "guard_git.py", self.payload("git status", workdir="missing")
        )
        empty = self.run_hook(
            "guard_git.py", self.payload("git status", workdir="")
        )
        malformed = self.run_hook(
            "guard_git.py", self.payload("git status", workdir=8)
        )
        other = pathlib.Path(self._temp.name) / "other"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        foreign = self.run_hook(
            "guard_git.py", self.payload("git status", workdir=str(other))
        )
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(empty.returncode, 2)
        self.assertEqual(malformed.returncode, 2)
        self.assertEqual(foreign.returncode, 2)

    def test_symlinked_nested_workdir_is_accepted_for_same_physical_root(self) -> None:
        nested = self.root / "nested"
        nested.mkdir()
        alias = pathlib.Path(self._temp.name) / "alias"
        alias.symlink_to(nested, target_is_directory=True)
        result = self.run_hook(
            "guard_git.py", self.payload("git status", workdir=str(alias))
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_injected_root_mismatch_blocks_even_when_payload_repo_is_valid(self) -> None:
        other = pathlib.Path(self._temp.name) / "other-root"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        result = self.run_hook("guard_git.py", self.payload(), root=other)
        self.assertEqual(result.returncode, 2)

    def test_shared_import_and_evaluation_failures_block(self) -> None:
        import_failure = self.root / ".claude/hooks/import-failure.py"
        import_failure.write_text("raise RuntimeError('import failed')\n", encoding="utf-8")
        evaluate_failure = self.root / ".claude/hooks/evaluate-failure.py"
        evaluate_failure.write_text(
            "import subprocess\n"
            "def evaluate(command, data): raise RuntimeError('evaluate failed')\n",
            encoding="utf-8",
        )
        for shared in (import_failure, evaluate_failure):
            with self.subTest(shared=shared.name):
                result = self.run_hook("guard_git.py", self.payload(), shared=shared)
                self.assertEqual(result.returncode, 2)

    def test_shared_policy_receives_effective_physical_workdir(self) -> None:
        nested = self.root / "nested"
        nested.mkdir()
        shared = self.root / ".claude/hooks/assert-workdir.py"
        shared.write_text(
            "import subprocess\n"
            "def evaluate(command, data):\n"
            f" assert data['cwd'] == {str(nested.resolve())!r}\n"
            " return None\n",
            encoding="utf-8",
        )
        result = self.run_hook(
            "guard_git.py",
            self.payload("git status", workdir="nested"),
            shared=shared,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_main_rewrite_targets_standalone_command_tokens_not_paths(self) -> None:
        original = (
            "Start the /implement flow; The /implement flow requires review. "
            "Read .claude/skills/implement/SKILL.md and /implementations/x."
        )
        shared = self.root / ".claude/hooks/rewrite-git.py"
        shared.write_text(
            "import subprocess\n"
            f"def evaluate(command, data): return (2, {original!r})\n",
            encoding="utf-8",
        )
        result = self.run_hook("guard_git.py", self.payload("git commit"), shared=shared)
        self.assertEqual(result.returncode, 2)
        rewritten = result.stderr.strip()
        self.assertEqual(
            rewritten,
            "Start the $ambercast-implementation flow; The $ambercast-implementation "
            "flow requires review. Read .claude/skills/implement/SKILL.md and "
            "/implementations/x.",
        )
        self.assertEqual(rewritten.count("$ambercast-implementation"), 2)

    def test_adapter_diagnostics_redact_raw_payload_path_and_exception_text(self) -> None:
        sentinel = "SECRET-GIT-DIAGNOSTIC-SENTINEL"
        payload = {
            "cwd": f"/nonexistent/{sentinel}",
            "tool_input": {"command": f"git status # {sentinel}"},
        }
        result = self.run_hook("guard_git.py", payload)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(sentinel, result.stderr)


class GitProbeProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="git-proxy-")).resolve()

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def fake_shared(self, outcome: object) -> tuple[types.ModuleType, mock.Mock]:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        if isinstance(outcome, BaseException):
            runner.run.side_effect = outcome
        else:
            runner.run.return_value = outcome
        shared = types.ModuleType("fake_shared_git")
        shared.subprocess = runner

        def evaluate(command: str, data: dict) -> None:
            try:
                result = shared.subprocess.run(
                    ["git", "-C", str(self.root), "rev-parse", "--abbrev-ref", "HEAD"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
            except (OSError, shared.subprocess.SubprocessError):
                return None
            if result.returncode != 0:
                return None
            return None

        shared.evaluate = evaluate
        return shared, runner

    def test_shared_caught_empty_nonzero_and_raised_branch_probe_fail_closed(self) -> None:
        sentinel = "SECRET-GIT-PROBE-DETAIL"
        outcomes = [
            subprocess.CompletedProcess([], 0, "", sentinel),
            subprocess.CompletedProcess([], 9, "", sentinel),
            OSError(sentinel),
            subprocess.TimeoutExpired(["git"], 5, stderr=sentinel),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__):
                shared, runner = self.fake_shared(outcome)
                original_shared_subprocess = shared.subprocess
                original_real_run = subprocess.run
                with (
                    mock.patch.object(GIT_GUARD, "verified_root", return_value=str(self.root)),
                    mock.patch.object(GIT_GUARD, "project_root", return_value=str(self.root)),
                    mock.patch.object(GIT_GUARD, "load_shared_guard", return_value=shared),
                ):
                    result, stdout, stderr = invoke_main(
                        GIT_GUARD,
                        {"cwd": str(self.root), "tool_input": {"command": "git commit"}},
                    )
                self.assertEqual(result, 2)
                self.assertEqual(stdout, "")
                self.assertNotEqual(stderr, "")
                self.assertNotIn(sentinel, stderr)
                self.assertEqual(runner.run.call_count, 1)
                self.assertIs(shared.subprocess, original_shared_subprocess)
                self.assertIs(subprocess.run, original_real_run)

    def test_shared_subprocess_is_restored_after_evaluate_exception(self) -> None:
        sentinel = "SECRET-GIT-EVALUATE-EXCEPTION"
        shared, _ = self.fake_shared(
            subprocess.CompletedProcess([], 0, "issues/123\n", "")
        )
        original_shared_subprocess = shared.subprocess
        original_real_run = subprocess.run
        shared.evaluate = lambda command, data: (_ for _ in ()).throw(
            RuntimeError(sentinel)
        )
        with (
            mock.patch.object(GIT_GUARD, "verified_root", return_value=str(self.root)),
            mock.patch.object(GIT_GUARD, "project_root", return_value=str(self.root)),
            mock.patch.object(GIT_GUARD, "load_shared_guard", return_value=shared),
        ):
            result, stdout, stderr = invoke_main(
                GIT_GUARD,
                {"cwd": str(self.root), "tool_input": {"command": "git status"}},
            )
        self.assertEqual(result, 2)
        self.assertEqual(stdout, "")
        self.assertNotEqual(stderr, "")
        self.assertNotIn(sentinel, stderr)
        self.assertIs(shared.subprocess, original_shared_subprocess)
        self.assertIs(subprocess.run, original_real_run)


class StopProbeProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="stop-proxy-")).resolve()
        self.argv = [
            "git", "-C", str(self.root), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def invoke(self, outcome: object) -> tuple[int, str, str, mock.Mock]:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        if isinstance(outcome, BaseException):
            runner.run.side_effect = outcome
        else:
            runner.run.return_value = outcome
        shared = types.ModuleType("fake_shared_stop")
        shared.subprocess = runner

        def current_branch(root: str) -> str | None:
            try:
                result = shared.subprocess.run(
                    self.argv, capture_output=True, timeout=5
                )
            except (OSError, shared.subprocess.SubprocessError):
                return None
            if result.returncode != 0:
                return None
            branch = result.stdout.decode(errors="replace").strip()
            return branch or None

        shared.current_branch = current_branch
        shared.evaluate = lambda root, branch, session_id: None
        with mock.patch.dict(os.environ, {}, clear=True):
            with (
                mock.patch.object(STOP_GUARD, "verified_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "project_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "load_shared_guard", return_value=shared),
            ):
                result, stdout, stderr = invoke_main(
                    STOP_GUARD, {"cwd": str(self.root)}
                )
        runner.run.assert_called_once_with(self.argv, capture_output=True, timeout=5)
        return result, stdout, stderr, runner

    def test_attached_and_exact_detached_outcomes_pass_through(self) -> None:
        outcomes = [
            subprocess.CompletedProcess(self.argv, 0, b"issues/123\n", b""),
            subprocess.CompletedProcess(self.argv, 1, b"", b""),
        ]
        for outcome in outcomes:
            with self.subTest(returncode=outcome.returncode):
                result, stdout, stderr, _ = self.invoke(outcome)
                self.assertEqual(result, 0)
                self.assertEqual(stderr, "")
                self.assertEqual(json.loads(stdout), {})

    def test_invalid_or_raised_symbolic_ref_outcomes_terminate_safely(self) -> None:
        outcomes = [
            subprocess.CompletedProcess(self.argv, 0, b"", b""),
            subprocess.CompletedProcess(self.argv, 1, b"issues/123\n", b""),
            subprocess.CompletedProcess(self.argv, 2, b"", b""),
            subprocess.TimeoutExpired(self.argv, 5),
            OSError("git unavailable"),
        ]
        for outcome in outcomes:
            with self.subTest(outcome=type(outcome).__name__, value=outcome):
                result, stdout, stderr, _ = self.invoke(outcome)
                self.assertEqual(result, 0)
                self.assertEqual(stderr, "")
                warning = json.loads(stdout)
                self.assertEqual(set(warning), {"continue", "systemMessage"})
                self.assertIs(warning["continue"], False)

    def invoke_progress(
        self, progress_outcomes: dict[tuple[str, ...], object]
    ) -> tuple[int, str, str, mock.Mock, types.ModuleType]:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        branch_argv = tuple(self.argv)

        def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            key = tuple(argv)
            if key == branch_argv:
                return subprocess.CompletedProcess(argv, 0, b"issues/123\n", b"")
            outcome = progress_outcomes[key]
            if isinstance(outcome, BaseException):
                raise outcome
            assert isinstance(outcome, subprocess.CompletedProcess)
            return outcome

        runner.run.side_effect = run
        shared = types.ModuleType("fake_shared_stop_progress")
        shared.subprocess = runner

        def git_stdout(root: str, args: list[str]) -> bytes:
            try:
                result = shared.subprocess.run(
                    ["git", "-C", root, *args], capture_output=True, timeout=5
                )
            except (OSError, shared.subprocess.SubprocessError):
                return b""
            return result.stdout if result.returncode == 0 else b""

        def current_branch(root: str) -> str | None:
            result = shared.subprocess.run(self.argv, capture_output=True, timeout=5)
            return result.stdout.decode().strip() or None

        def evaluate(root: str, branch: str, session_id: str) -> dict:
            git_stdout(root, ["rev-parse", "HEAD"])
            git_stdout(root, ["diff", "HEAD"])
            git_stdout(root, ["ls-files", "--others", "--exclude-standard"])
            return {"decision": "block", "reason": "/implement flow pending"}

        shared.current_branch = current_branch
        shared.evaluate = evaluate
        with mock.patch.dict(os.environ, {}, clear=True):
            with (
                mock.patch.object(STOP_GUARD, "verified_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "project_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "load_shared_guard", return_value=shared),
            ):
                result, stdout, stderr = invoke_main(STOP_GUARD, {"cwd": str(self.root)})
        return result, stdout, stderr, runner, shared

    def test_progress_probes_require_success_allow_empty_diff_and_restore_proxy(self) -> None:
        progress = [
            ("rev-parse", "HEAD"),
            ("diff", "HEAD"),
            ("ls-files", "--others", "--exclude-standard"),
        ]

        def success(stdout: bytes = b"ok\n") -> subprocess.CompletedProcess:
            return subprocess.CompletedProcess([], 0, stdout, b"")

        base = {
            ("git", "-C", str(self.root), *args): success()
            for args in progress
        }
        base[("git", "-C", str(self.root), "diff", "HEAD")] = success(b"")
        base[("git", "-C", str(self.root), "ls-files", "--others", "--exclude-standard")] = success(b"")
        result, stdout, stderr, runner, shared = self.invoke_progress(base)
        self.assertEqual((result, stderr), (0, ""))
        self.assertEqual(json.loads(stdout)["decision"], "block")
        self.assertEqual(runner.run.call_count, 4)
        self.assertIs(shared.subprocess, runner)

        required = [
            ("git", "-C", str(self.root), "rev-parse", "HEAD"),
            ("git", "-C", str(self.root), "diff", "HEAD"),
            ("git", "-C", str(self.root), "ls-files", "--others", "--exclude-standard"),
        ]
        for probe in required:
            for outcome in (
                subprocess.CompletedProcess([], 2, b"", b"secret"),
                subprocess.TimeoutExpired(list(probe), 5),
                OSError("git unavailable"),
            ):
                with self.subTest(probe=probe, outcome=type(outcome).__name__):
                    outcomes = dict(base)
                    outcomes[probe] = outcome
                    result, stdout, stderr, runner, shared = self.invoke_progress(outcomes)
                    self.assertEqual((result, stderr), (0, ""))
                    warning = json.loads(stdout)
                    self.assertEqual(set(warning), {"continue", "systemMessage"})
                    self.assertIs(warning["continue"], False)
                    self.assertEqual(runner.run.call_count, 4)
                    self.assertIs(shared.subprocess, runner)

        empty_head = dict(base)
        empty_head[("git", "-C", str(self.root), "rev-parse", "HEAD")] = success(b"")
        _, stdout, stderr, _, _ = self.invoke_progress(empty_head)
        self.assertEqual(stderr, "")
        self.assertEqual(set(json.loads(stdout)), {"continue", "systemMessage"})

    def test_real_shared_progress_probes_use_exact_five_second_kwargs(self) -> None:
        impl = self.root / ".claude/impl"
        impl.mkdir(parents=True)
        (impl / "issue-123.state").write_text(
            "issue=123\nbranch=issues/123\nstep01_issue=done\n",
            encoding="utf-8",
        )
        path = REPO_ROOT / ".claude/hooks/guard_stop.py"
        spec = importlib.util.spec_from_file_location("real_shared_stop_bounds", path)
        assert spec is not None and spec.loader is not None
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)
        root = str(self.root)
        expected = [
            ["git", "-C", root, "rev-parse", "HEAD"],
            ["git", "-C", root, "diff", "HEAD"],
            ["git", "-C", root, "ls-files", "--others", "--exclude-standard"],
        ]
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.side_effect = [
            subprocess.CompletedProcess(expected[0], 0, b"abc123\n", b""),
            subprocess.CompletedProcess(expected[1], 0, b"", b""),
            subprocess.CompletedProcess(expected[2], 0, b"", b""),
        ]
        shared.subprocess = runner
        result = shared.evaluate(root, "issues/123", "")
        self.assertEqual(result.get("decision"), "block")
        self.assertEqual(
            runner.run.call_args_list,
            [
                mock.call(argv, capture_output=True, timeout=5)
                for argv in expected
            ],
        )
        self.assertEqual(len(runner.run.call_args_list), 3)

    def test_stop_proxy_restores_shared_subprocess_after_evaluate_exception(self) -> None:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.return_value = subprocess.CompletedProcess(
            self.argv, 0, b"issues/123\n", b""
        )
        shared = types.ModuleType("raising_shared_stop")
        shared.subprocess = runner

        def current_branch(root: str) -> str:
            result = shared.subprocess.run(
                self.argv, capture_output=True, timeout=5
            )
            return result.stdout.decode().strip()

        shared.current_branch = current_branch
        shared.evaluate = lambda root, branch, session_id: (_ for _ in ()).throw(
            RuntimeError("SECRET-STOP-EVALUATE-EXCEPTION")
        )
        original_real_run = subprocess.run
        with mock.patch.dict(os.environ, {}, clear=True):
            with (
                mock.patch.object(STOP_GUARD, "verified_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "project_root", return_value=str(self.root)),
                mock.patch.object(STOP_GUARD, "load_shared_guard", return_value=shared),
            ):
                result, stdout, stderr = invoke_main(
                    STOP_GUARD, {"cwd": str(self.root)}
                )
        self.assertEqual((result, stderr), (0, ""))
        warning = json.loads(stdout)
        self.assertEqual(set(warning), {"continue", "systemMessage"})
        self.assertIs(warning["continue"], False)
        self.assertNotIn("SECRET-STOP-EVALUATE-EXCEPTION", stdout)
        self.assertIs(shared.subprocess, runner)
        self.assertIs(subprocess.run, original_real_run)


class InjectedSourceAndRootFailureTests(unittest.TestCase):
    def test_each_adapter_executes_injected_shared_bytes_after_path_is_unlinked(self) -> None:
        source_a = b"SENTINEL = 'injected-A'\n"
        for module, name in (
            (GIT_GUARD, "guard_git.py"),
            (PHASE_GUARD, "guard_phase.py"),
            (STOP_GUARD, "guard_stop.py"),
        ):
            with self.subTest(adapter=name), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary).resolve()
                path = root / ".claude/hooks" / name
                path.parent.mkdir(parents=True)
                path.write_bytes(b"raise RuntimeError('path-B-was-read')\n")
                with (
                    mock.patch.object(module, "__ambercast_verified_root__", str(root), create=True),
                    mock.patch.object(module, "__ambercast_shared_path__", str(path), create=True),
                    mock.patch.object(module, "__ambercast_shared_bytes__", source_a, create=True),
                ):
                    path.unlink()
                    shared = module.load_shared_guard(str(root))
                self.assertIsNotNone(shared)
                self.assertEqual(shared.SENTINEL, "injected-A")

    def test_root_probe_exception_fails_closed_in_pretool_and_terminates_stop(self) -> None:
        root = pathlib.Path(tempfile.mkdtemp(prefix="root-failure-")).resolve()
        sentinel = "SECRET-ROOT-PROBE-TIMEOUT"
        try:
            cases = [
                (
                    GIT_GUARD,
                    {"cwd": str(root), "tool_input": {"command": "git status"}},
                    2,
                ),
                (
                    PHASE_GUARD,
                    {"cwd": str(root), "tool_input": {"file_path": "README.md"}},
                    2,
                ),
                (STOP_GUARD, {"cwd": str(root)}, 0),
            ]
            for raised in (
                subprocess.TimeoutExpired([sentinel], 5),
                OSError(sentinel),
            ):
                for module, payload, expected in cases:
                    with self.subTest(module=module.__name__, raised=type(raised).__name__):
                        with mock.patch.dict(os.environ, {}, clear=True):
                            with (
                                mock.patch.object(module, "verified_root", return_value=str(root)),
                                mock.patch.object(module, "project_root", side_effect=raised),
                            ):
                                result, stdout, stderr = invoke_main(module, payload)
                        self.assertEqual(result, expected)
                        self.assertNotIn(sentinel, stdout + stderr)
                        if module is STOP_GUARD:
                            warning = json.loads(stdout)
                            self.assertEqual(set(warning), {"continue", "systemMessage"})
                            self.assertIs(warning["continue"], False)
                            self.assertEqual(stderr, "")
                        else:
                            self.assertEqual(stdout, "")
                            self.assertNotEqual(stderr, "")
        finally:
            shutil.rmtree(root)


class StopAdapterTests(AdapterRepositoryCase):
    def payload(self, *, include_tool_input: bool = False, **tool: object) -> dict:
        payload = {
            "cwd": str(self.root),
            "hook_event_name": "Stop",
            "turn_id": "changes-each-turn",
        }
        if include_tool_input or tool:
            payload["tool_input"] = tool
        return payload

    def write_state(self, content: str) -> None:
        (self.root / ".claude/impl/issue-123.state").write_text(
            content, encoding="utf-8"
        )

    def parsed(self, result: subprocess.CompletedProcess[str]) -> dict:
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def test_unfinished_flow_emits_exact_continuation_shape_and_codex_guidance(self) -> None:
        self.checkout("issues/123")
        self.write_state("issue=123\nbranch=issues/123\nstep01_issue=done\n")
        output = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertEqual(set(output), {"decision", "reason"})
        self.assertEqual(output["decision"], "block")
        self.assertIn("$ambercast-implementation flow", output["reason"])
        self.assertNotIn("/implement flow", output["reason"])
        self.assertIn(".claude/skills/implement/SKILL.md", output["reason"])
        self.assertTrue(
            output["reason"].endswith(
                " Also re-read .agents/skills/ambercast-implementation/SKILL.md for Codex routing."
            )
        )

    def test_kill_switch_precedes_cwd_validation_and_emits_exact_empty_object(self) -> None:
        payload = {"cwd": [], "tool_input": {"workdir": 7}}
        result = self.run_hook(
            "guard_stop.py", payload, env={"AMBERCAST_GUARD_STOP": "0"}
        )
        self.assertEqual(self.parsed(result), {})
        self.assertEqual(result.stdout.strip(), "{}")

    def test_kill_switch_does_not_override_malformed_json_or_nonobject(self) -> None:
        for raw in ("{bad", "[]"):
            with self.subTest(raw=raw):
                output = self.parsed(
                    self.run_raw(
                        "guard_stop.py",
                        raw,
                        env={"AMBERCAST_GUARD_STOP": "0"},
                    )
                )
                self.assertEqual(set(output), {"continue", "systemMessage"})
                self.assertIs(output["continue"], False)

    def test_nonissue_detached_paused_and_completed_states_allow(self) -> None:
        main = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertEqual(main, {})

        self.checkout("issues/123")
        self.write_state("issue=123\nbranch=issues/123\npaused=true\n")
        paused = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertEqual(paused, {})

        all_steps = [
            "step01_issue", "step02_branch", "step03_plan", "step04_plan_review",
            "step05_plan_revised", "step06_scaffold", "step07_docs",
            "step08_docs_review", "step09_tests", "step10_tests_review",
            "step11_code", "step12_code_review", "step13_push", "step14_pr",
            "step15_ci", "step16_coderabbit", "step17_merged",
        ]
        self.write_state(
            "issue=123\nbranch=issues/123\n"
            + "".join(f"{step}=done\n" for step in all_steps)
        )
        completed = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertEqual(completed, {})

        git(self.root, "checkout", "--detach", "-q")
        detached = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertEqual(detached, {})

    def test_stable_empty_session_id_reaches_stall_backoff(self) -> None:
        self.checkout("issues/123")
        self.write_state("issue=123\nbranch=issues/123\nstep01_issue=done\n")
        first_three = [
            self.parsed(self.run_hook("guard_stop.py", self.payload()))
            for _ in range(3)
        ]
        fourth = self.parsed(self.run_hook("guard_stop.py", self.payload()))
        self.assertTrue(all(item.get("decision") == "block" for item in first_three))
        self.assertEqual(fourth, {})

    def test_normal_shared_none_is_allow_not_warning(self) -> None:
        custom = self.root / ".claude/hooks/allow.py"
        custom.write_text(
            "import subprocess\n"
            "def current_branch(root): return 'issues/123'\n"
            "def evaluate(root, branch, session_id): return None\n",
            encoding="utf-8",
        )
        self.assertEqual(
            self.parsed(self.run_hook("guard_stop.py", self.payload(), shared=custom)),
            {},
        )

    def test_missing_shared_subprocess_emits_exact_terminating_warning(self) -> None:
        custom = self.root / ".claude/hooks/missing-subprocess.py"
        custom.write_text(
            "def current_branch(root): return 'issues/123'\n"
            "def evaluate(root, branch, session_id): return None\n",
            encoding="utf-8",
        )

        result = self.run_hook("guard_stop.py", self.payload(), shared=custom)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            result.stdout,
            '{"continue":false,"systemMessage":"Ambercast flow completion guard '
            'could not verify repository policy."}\n',
        )

    def test_malformed_shared_returns_emit_exact_terminating_warning(self) -> None:
        malformed = [
            ["not", "an", "object"],
            {"decision": "block"},
            {"decision": "block", "reason": "pending", "extra": True},
            {"decision": "allow", "reason": "pending"},
            {"decision": "block", "reason": 7},
        ]
        expected = (
            '{"continue":false,"systemMessage":"Ambercast flow completion guard '
            'could not verify repository policy."}\n'
        )
        for index, payload in enumerate(malformed):
            with self.subTest(payload=payload):
                custom = self.root / f".claude/hooks/malformed-return-{index}.py"
                custom.write_text(
                    "import subprocess\n"
                    "def current_branch(root): return 'issues/123'\n"
                    f"def evaluate(root, branch, session_id): return {payload!r}\n",
                    encoding="utf-8",
                )

                result = self.run_hook("guard_stop.py", self.payload(), shared=custom)

                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, "")
                self.assertEqual(result.stdout, expected)

    def test_issue_branch_without_state_is_intentional_allow(self) -> None:
        self.checkout("issues/123")
        self.assertFalse((self.root / ".claude/impl/issue-123.state").exists())
        result = self.run_hook("guard_stop.py", self.payload())
        self.assertEqual(self.parsed(result), {})

    def test_symlinked_impl_parent_warns_without_external_mutation(self) -> None:
        self.checkout("issues/123")
        impl = self.root / ".claude/impl"
        impl.rmdir()
        outside = pathlib.Path(self._temp.name) / "outside-impl"
        outside.mkdir()
        (outside / "issue-123.state").write_text(
            "issue=123\nbranch=issues/123\nstep01_issue=done\n",
            encoding="utf-8",
        )
        (outside / ".guard-stop-issue-123.json").write_text(
            '{"precious": true}', encoding="utf-8"
        )
        impl.symlink_to(outside, target_is_directory=True)
        before = {path.name: path.read_bytes() for path in outside.iterdir()}

        result = self.run_hook("guard_stop.py", self.payload())

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "")
        self.assertEqual(
            result.stdout,
            '{"continue":false,"systemMessage":"Ambercast flow completion guard '
            'could not verify repository policy."}\n',
        )
        after = {path.name: path.read_bytes() for path in outside.iterdir()}
        self.assertEqual(after, before)

    def test_shared_sidecar_persistence_failure_is_intentional_allow(self) -> None:
        self.checkout("issues/123")
        self.write_state("issue=123\nbranch=issues/123\nstep01_issue=done\n")
        shared_path = REPO_ROOT / ".claude/hooks/guard_stop.py"
        spec = importlib.util.spec_from_file_location(
            "shared_stop_persistence_failure", shared_path
        )
        assert spec is not None and spec.loader is not None
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)
        shared._persist_sidecar = lambda *args: False
        with mock.patch.dict(os.environ, {}, clear=True):
            with (
                mock.patch.object(STOP_GUARD, "verified_root", return_value=str(self.root.resolve())),
                mock.patch.object(STOP_GUARD, "project_root", return_value=str(self.root.resolve())),
                mock.patch.object(STOP_GUARD, "load_shared_guard", return_value=shared),
            ):
                result, stdout, stderr = invoke_main(STOP_GUARD, self.payload())
        self.assertEqual(result, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout), {})

    def test_malformed_json_nonobject_and_root_errors_terminate_exactly(self) -> None:
        results = [
            self.run_raw("guard_stop.py", "{bad"),
            self.run_raw("guard_stop.py", "[]"),
            self.run_hook("guard_stop.py", {"tool_input": {}}),
            self.run_hook("guard_stop.py", {"cwd": [], "tool_input": {}}),
        ]
        other = pathlib.Path(self._temp.name) / "other"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        results.append(self.run_hook("guard_stop.py", self.payload(), root=other))
        for result in results:
            payload = self.parsed(result)
            self.assertEqual(set(payload), {"continue", "systemMessage"})
            self.assertIs(payload["continue"], False)

    def test_empty_nongit_nonexistent_cwd_and_explicit_null_workdir_terminate(self) -> None:
        nongit = pathlib.Path(self._temp.name) / "not-a-repo"
        nongit.mkdir()
        nonexistent = pathlib.Path(self._temp.name) / "missing"
        payloads = [
            {"cwd": ""},
            {"cwd": str(nongit)},
            {"cwd": str(nonexistent)},
            self.payload(workdir=None),
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                result = self.run_hook("guard_stop.py", payload)
                warning = self.parsed(result)
                self.assertEqual(set(warning), {"continue", "systemMessage"})
                self.assertIs(warning["continue"], False)

    def test_warning_redacts_invalid_cwd_and_payload_sentinel(self) -> None:
        sentinel = "SECRET-STOP-PAYLOAD-SENTINEL"
        result = self.run_hook(
            "guard_stop.py",
            {"cwd": f"/nonexistent/{sentinel}", "unknown": sentinel},
        )
        warning = self.parsed(result)
        self.assertEqual(set(warning), {"continue", "systemMessage"})
        self.assertNotIn(sentinel, result.stdout)

    def test_invalid_and_cross_worktree_workdir_terminate(self) -> None:
        other = pathlib.Path(self._temp.name) / "other"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        for workdir in ("", 8, "missing", str(other)):
            with self.subTest(workdir=workdir):
                payload = self.parsed(
                    self.run_hook("guard_stop.py", self.payload(workdir=workdir))
                )
                self.assertEqual(set(payload), {"continue", "systemMessage"})

    def test_relative_nested_workdir_is_supported_even_if_normal_stop_omits_it(self) -> None:
        nested = self.root / "nested"
        nested.mkdir()
        result = self.run_hook("guard_stop.py", self.payload(workdir="nested"))
        self.assertEqual(self.parsed(result), {})

    def test_shared_load_or_evaluation_error_terminates_without_loop(self) -> None:
        import_failure = self.root / ".claude/hooks/import-failure.py"
        import_failure.write_text("raise RuntimeError('bad import')\n", encoding="utf-8")
        evaluate_failure = self.root / ".claude/hooks/evaluate-failure.py"
        evaluate_failure.write_text(
            "def current_branch(root): return 'issues/123'\n"
            "def evaluate(root, branch, session_id): raise RuntimeError('bad eval')\n",
            encoding="utf-8",
        )
        for shared in (import_failure, evaluate_failure):
            with self.subTest(shared=shared.name):
                payload = self.parsed(
                    self.run_hook("guard_stop.py", self.payload(), shared=shared)
                )
                self.assertEqual(set(payload), {"continue", "systemMessage"})
                self.assertIs(payload["continue"], False)

    def test_current_branch_exception_terminates_without_leaking_exception(self) -> None:
        sentinel = "SECRET-CURRENT-BRANCH-EXCEPTION"
        custom = self.root / ".claude/hooks/current-branch-failure.py"
        custom.write_text(
            f"def current_branch(root): raise RuntimeError({sentinel!r})\n"
            "def evaluate(root, branch, session_id): return None\n",
            encoding="utf-8",
        )
        result = self.run_hook("guard_stop.py", self.payload(), shared=custom)
        output = self.parsed(result)
        self.assertEqual(set(output), {"continue", "systemMessage"})
        self.assertNotIn(sentinel, result.stdout)

    def test_realistic_payload_without_tool_input_blocks_and_allows(self) -> None:
        self.checkout("issues/123")
        self.write_state("issue=123\nbranch=issues/123\nstep01_issue=done\n")
        blocked_result = self.run_hook("guard_stop.py", self.payload())
        self.assertNotIn("tool_input", self.payload())
        blocked = self.parsed(blocked_result)
        self.assertEqual(blocked["decision"], "block")
        allowed = self.parsed(
            self.run_hook(
                "guard_stop.py",
                self.payload(),
                env={"AMBERCAST_GUARD_STOP": "0"},
            )
        )
        self.assertEqual(allowed, {})

    def test_adapter_passes_stable_empty_session_id_and_skips_background_api(self) -> None:
        custom = self.root / ".claude/hooks/session.py"
        custom.write_text(
            "import subprocess\n"
            "def current_branch(root): return 'issues/123'\n"
            "def has_live_background(tasks): raise AssertionError('must not call')\n"
            "def evaluate(root, branch, session_id):\n"
            " assert session_id == ''\n"
            " return {'decision': 'block', 'reason': '/implement flow waits'}\n",
            encoding="utf-8",
        )
        payload = self.payload()
        payload["background_tasks"] = [
            {"task_type": "delegated", "status": "running"}
        ]
        output = self.parsed(self.run_hook("guard_stop.py", payload, shared=custom))
        self.assertEqual(output["decision"], "block")

    def test_main_reason_rewrite_is_narrow_and_preserves_canonical_path(self) -> None:
        reason = (
            "/implement flow pending; read .claude/skills/implement/SKILL.md; "
            "unrelated /implement command remains."
        )
        custom = self.root / ".claude/hooks/rewrite-stop.py"
        custom.write_text(
            "import subprocess\n"
            "def current_branch(root): return 'issues/123'\n"
            f"def evaluate(root, branch, session_id): return {{'decision': 'block', 'reason': {reason!r}}}\n",
            encoding="utf-8",
        )
        output = self.parsed(
            self.run_hook("guard_stop.py", self.payload(), shared=custom)
        )
        rewritten = output["reason"]
        self.assertEqual(
            rewritten,
            "$ambercast-implementation flow pending; read "
            ".claude/skills/implement/SKILL.md; unrelated /implement command remains."
            " Also re-read .agents/skills/ambercast-implementation/SKILL.md for Codex routing.",
        )
        self.assertEqual(rewritten.count("$ambercast-implementation flow"), 1)
        self.assertNotIn("/implement flow", rewritten)


if __name__ == "__main__":
    unittest.main()
