#!/usr/bin/env python3
"""Behavioral tests for the Codex phase adapter.

These tests intentionally exercise the documented adapter boundary rather than
copying the shared Claude policy.  Temporary repositories make ownership,
symlink, nested-cwd, and nonexistent-target behavior observable through the
same Codex-shaped JSON that the real hook receives.
"""
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
import time
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock


HOOKS = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HOOKS.parents[1]
ADAPTER_PATH = HOOKS / "guard_phase.py"
SHARED_PATH = REPO_ROOT / ".claude/hooks/guard_phase.py"

SPEC = importlib.util.spec_from_file_location("codex_guard_phase_tests", ADAPTER_PATH)
assert SPEC is not None and SPEC.loader is not None
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)

INJECTED_RUNNER = r"""
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


def git(cwd: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    )


class PhaseRepositoryCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory(prefix="ambercast phase ")
        root = pathlib.Path(self._temp.name) / "repo with spaces"
        root.mkdir()
        self.root = root.resolve()
        (self.root / ".claude/hooks").mkdir(parents=True)
        (self.root / ".claude/impl").mkdir(parents=True)
        (self.root / "src/nested").mkdir(parents=True)
        (self.root / "tests").mkdir()
        (self.root / "docs").mkdir()
        shutil.copy2(SHARED_PATH, self.root / ".claude/hooks/guard_phase.py")
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

    def write_state(self, *done: str) -> None:
        body = ["issue=123", "branch=issues/123"]
        body.extend(f"{key}=done" for key in done)
        (self.root / ".claude/impl/issue-123.state").write_text(
            "\n".join(body) + "\n", encoding="utf-8"
        )

    def payload(
        self,
        tool_input: object,
        *,
        cwd: pathlib.Path | str | object | None = None,
    ) -> dict:
        return {
            "cwd": str(self.root if cwd is None else cwd)
            if isinstance(self.root if cwd is None else cwd, (str, pathlib.Path))
            else cwd,
            "tool_name": "apply_patch",
            "tool_input": tool_input,
        }

    def run_payload(
        self, payload: object, *, shared: pathlib.Path | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-I",
                "-S",
                "-c",
                INJECTED_RUNNER,
                str(ADAPTER_PATH),
                str(self.root.resolve()),
                str(shared or self.root / ".claude/hooks/guard_phase.py"),
            ],
            cwd=self.root,
            input=json.dumps(payload),
            capture_output=True,
            text=True,
        )

    def run_input(self, raw: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-I",
                "-S",
                "-c",
                INJECTED_RUNNER,
                str(ADAPTER_PATH),
                str(self.root.resolve()),
                str(self.root / ".claude/hooks/guard_phase.py"),
            ],
            cwd=self.root,
            input=raw,
            capture_output=True,
            text=True,
        )

    def patch_result(
        self, patch: str, *, cwd: pathlib.Path | None = None, workdir: object = None
    ) -> subprocess.CompletedProcess[str]:
        tool_input: dict[str, object] = {"command": patch}
        if workdir is not None:
            tool_input["workdir"] = workdir
        return self.run_payload(self.payload(tool_input, cwd=cwd))


class ExtractPathsTests(PhaseRepositoryCase):
    def extract(self, data: dict) -> list[str]:
        with mock.patch.object(GUARD, "verified_root", return_value=str(self.root.resolve())):
            return GUARD.extract_paths(data, str(self.root))

    def test_accumulates_structured_fields_and_all_patch_header_kinds(self) -> None:
        data = self.payload(
            {
                "file_path": "src/one.ts",
                "notebook_path": "tests/notebook.ipynb",
                "command": (
                    "*** Begin Patch\r\n"
                    "*** Update File: src/one.ts\r\n"
                    "*** Move to: src/moved file.ts\r\n"
                    "*** Add File: tests/new.test.ts\r\n"
                    "*** Delete File: src/old.ts\r\n"
                    "*** End Patch\r\n"
                ),
            }
        )
        expected = [
            self.root / "src/one.ts",
            self.root / "tests/notebook.ipynb",
            self.root / "src/moved file.ts",
            self.root / "tests/new.test.ts",
            self.root / "src/old.ts",
        ]
        extracted = self.extract(data)
        self.assertEqual(len(extracted), len(expected))
        self.assertEqual(set(extracted), {str(path.resolve()) for path in expected})

    def test_deduplicates_physical_aliases_and_ignores_dev_null(self) -> None:
        alias = self.root / "source-alias"
        alias.symlink_to(self.root / "src", target_is_directory=True)
        data = self.payload(
            {
                "file_path": "src/same.ts",
                "command": (
                    "*** Update File: source-alias/same.ts\n"
                    "*** Add File: /dev/null\n"
                    "*** Delete File: src/same.ts\n"
                ),
            }
        )
        self.assertEqual(
            self.extract(data),
            [str((self.root / "src/same.ts").resolve())],
        )

    def test_headers_must_start_at_column_zero_and_keep_quotes_literal(self) -> None:
        data = self.payload(
            {
                "command": (
                    " *** Add File: src/indented.ts\n"
                    "*** Add File: \"src/quoted.ts\"\n"
                    "prefix *** Update File: src/inline.ts\n"
                )
            }
        )
        self.assertEqual(
            self.extract(data),
            [str((self.root / '\"src/quoted.ts\"').resolve())],
        )

    def test_nonexistent_suffix_is_attached_after_resolving_existing_symlink(self) -> None:
        alias = self.root / "nested-alias"
        alias.symlink_to(self.root / "src/nested", target_is_directory=True)
        data = self.payload({"file_path": "nested-alias/new/deep/file.ts"})
        self.assertEqual(
            self.extract(data),
            [str(self.root / "src/nested/new/deep/file.ts")],
        )


class PhasePolicyIntegrationTests(PhaseRepositoryCase):
    def test_main_blocks_source_and_test_but_allows_repository_docs(self) -> None:
        source = self.patch_result("*** Update File: src/index.ts")
        test = self.patch_result("*** Update File: tests/index.test.ts")
        docs = self.patch_result("*** Update File: docs/design.md")
        self.assertEqual(source.returncode, 2)
        self.assertEqual(test.returncode, 2)
        self.assertEqual(docs.returncode, 0, docs.stderr)
        self.assertIn("$ambercast-implementation", source.stderr)

    def test_issue_branch_observes_source_and_test_phase_transitions(self) -> None:
        self.checkout("issues/123")
        self.write_state()
        before_plan = self.patch_result("*** Update File: src/index.ts")
        self.write_state("step05_plan_revised")
        after_plan = self.patch_result("*** Update File: src/index.ts")
        before_docs = self.patch_result("*** Update File: tests/index.test.ts")
        self.write_state("step05_plan_revised", "step08_docs_review")
        after_docs = self.patch_result("*** Update File: tests/index.test.ts")
        self.assertEqual(before_plan.returncode, 2)
        self.assertEqual(after_plan.returncode, 0, after_plan.stderr)
        self.assertEqual(before_docs.returncode, 2)
        self.assertEqual(after_docs.returncode, 0, after_docs.stderr)

    def test_singular_test_helpers_and_fixtures_follow_docs_review_gate(self) -> None:
        self.checkout("issues/123")
        paths = ("test/helpers/browser.ts", "test/fixtures/session.json")
        self.write_state("step05_plan_revised")
        for path in paths:
            with self.subTest(path=path, phase="before-step08"):
                result = self.patch_result(f"*** Update File: {path}")
                self.assertEqual(result.returncode, 2)
                self.assertIn("step08_docs_review", result.stderr)

        self.write_state("step05_plan_revised", "step08_docs_review")
        for path in paths:
            with self.subTest(path=path, phase="after-step08"):
                result = self.patch_result(f"*** Update File: {path}")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_issue_state_recovery_messages_rewrite_run_and_finish_variants(self) -> None:
        self.checkout("issues/123")
        missing_state = self.patch_result("*** Update File: src/index.ts")
        self.assertEqual(missing_state.returncode, 2)
        self.assertIn("Run $ambercast-implementation steps 1-5", missing_state.stderr)
        self.assertNotIn("Run /implement", missing_state.stderr)

        self.write_state()
        incomplete_plan = self.patch_result("*** Update File: src/index.ts")
        self.assertEqual(incomplete_plan.returncode, 2)
        self.assertIn("Finish $ambercast-implementation steps 3-5", incomplete_plan.stderr)
        self.assertNotIn("Finish /implement", incomplete_plan.stderr)

    def test_mixed_patch_blocks_the_entire_edit(self) -> None:
        self.checkout("issues/123")
        self.write_state("step05_plan_revised")
        result = self.patch_result(
            "*** Update File: docs/design.md\n"
            "*** Update File: test/fixtures/not-yet.json\n"
        )
        self.assertEqual(result.returncode, 2)

    def test_nested_cwd_and_nonexistent_child_remain_classified_as_source(self) -> None:
        self.checkout("issues/123")
        self.write_state()
        nested = self.root / "src/nested"
        result = self.patch_result(
            "*** Add File: missing/deeper/new.ts", cwd=nested
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("step05_plan_revised", result.stderr)

    def test_parent_traversal_from_nested_cwd_is_physicalized_inside_root(self) -> None:
        self.checkout("issues/123")
        self.write_state()
        result = self.patch_result(
            "*** Update File: ../other.ts", cwd=self.root / "src/nested"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("step05_plan_revised", result.stderr)
        self.assertNotIn("outside", result.stderr.lower())

    def test_symlinked_nested_cwd_deriving_same_worktree_is_accepted(self) -> None:
        self.checkout("issues/123")
        self.write_state("step05_plan_revised")
        alias = self.root / "nested-alias"
        alias.symlink_to(self.root / "src/nested", target_is_directory=True)
        result = self.patch_result("*** Add File: new.ts", cwd=alias)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_relative_workdir_overrides_cwd_for_target_resolution(self) -> None:
        self.checkout("issues/123")
        self.write_state()
        result = self.patch_result(
            "*** Add File: nested/new.ts", workdir="src"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("step05_plan_revised", result.stderr)

    def test_absolute_nested_workdir_deriving_same_root_is_accepted(self) -> None:
        self.checkout("issues/123")
        self.write_state("step05_plan_revised")
        result = self.patch_result(
            "*** Add File: new.ts", workdir=str(self.root / "src/nested")
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cross_worktree_workdir_is_rejected(self) -> None:
        other = pathlib.Path(self._temp.name) / "other"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        result = self.patch_result("*** Add File: README.md", workdir=str(other))
        self.assertEqual(result.returncode, 2)
        self.assertIn("worktree", result.stderr.lower())

    def test_outside_absolute_and_parent_targets_are_rejected(self) -> None:
        absolute = self.patch_result(
            f"*** Add File: {pathlib.Path(self._temp.name) / 'escape.ts'}"
        )
        parent = self.patch_result("*** Add File: ../escape.ts")
        self.assertEqual(absolute.returncode, 2)
        self.assertEqual(parent.returncode, 2)
        self.assertIn("outside", absolute.stderr.lower())
        self.assertIn("outside", parent.stderr.lower())

    def test_directory_and_file_symlink_escapes_with_nonexistent_suffix_block(self) -> None:
        outside = pathlib.Path(self._temp.name).resolve() / "outside"
        outside.mkdir()
        outside_file = outside / "target-file"
        outside_file.write_text("outside", encoding="utf-8")
        directory_alias = self.root / "directory-alias"
        file_alias = self.root / "file-alias"
        directory_alias.symlink_to(outside, target_is_directory=True)
        file_alias.symlink_to(outside_file)
        paths = [
            "directory-alias/nonexistent/deep.ts",
            "file-alias/nonexistent.ts",
        ]
        for path in paths:
            for tool_input in (
                {"file_path": path},
                {"command": f"*** Add File: {path}"},
            ):
                with self.subTest(path=path, shape=tuple(tool_input)):
                    result = self.run_payload(self.payload(tool_input))
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("outside", result.stderr.lower())

    def test_injected_verified_root_mismatch_blocks(self) -> None:
        other = pathlib.Path(self._temp.name).resolve() / "other-root"
        other.mkdir()
        git(other, "init", "-q", "-b", "main")
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-S",
                "-c",
                INJECTED_RUNNER,
                str(ADAPTER_PATH),
                str(other),
                str(self.root / ".claude/hooks/guard_phase.py"),
            ],
            cwd=self.root,
            input=json.dumps(self.payload({"file_path": "README.md"})),
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)

    def test_empty_nongit_nonexistent_cwd_and_explicit_null_workdir_block(self) -> None:
        nongit = pathlib.Path(self._temp.name).resolve() / "not-a-repo"
        nongit.mkdir()
        nonexistent = pathlib.Path(self._temp.name).resolve() / "missing"
        payloads = [
            {"cwd": "", "tool_input": {"file_path": "README.md"}},
            {"cwd": str(nongit), "tool_input": {"file_path": "README.md"}},
            {"cwd": str(nonexistent), "tool_input": {"file_path": "README.md"}},
            self.payload({"file_path": "README.md", "workdir": None}),
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                result = self.run_payload(payload)
                self.assertEqual(result.returncode, 2)
                self.assertNotEqual(result.stderr, "")

    def test_present_malformed_fields_block_even_with_another_valid_target(self) -> None:
        cases = [
            {"file_path": 7, "notebook_path": "docs/a.ipynb"},
            {"file_path": "", "command": "*** Add File: docs/a.md"},
            {"notebook_path": "", "file_path": "docs/a.md"},
            {"notebook_path": 9, "file_path": "docs/a.md"},
            {"command": ["*** Add File: docs/a.md"], "file_path": "docs/a.md"},
        ]
        for tool_input in cases:
            with self.subTest(tool_input=tool_input):
                result = self.run_payload(self.payload(tool_input))
                self.assertEqual(result.returncode, 2)

    def test_no_recognizable_target_blocks(self) -> None:
        for command in ("*** Begin Patch", "*** Add File:    \n"):
            with self.subTest(command=command):
                result = self.run_payload(self.payload({"command": command}))
                self.assertEqual(result.returncode, 2)
                self.assertIn("target", result.stderr.lower())

    def test_malformed_event_shapes_fail_closed(self) -> None:
        malformed = self.run_input("{bad")
        non_object = self.run_input("[]")
        missing_tool_input = self.run_payload({"cwd": str(self.root)})
        empty_tool_input = self.run_payload(
            {"cwd": str(self.root), "tool_input": {}}
        )
        missing_cwd = self.run_payload({"tool_input": {"file_path": "README.md"}})
        bad_cwd = self.run_payload(
            {"cwd": [], "tool_input": {"file_path": "README.md"}}
        )
        bad_tool = self.run_payload({"cwd": str(self.root), "tool_input": []})
        for result in (
            malformed,
            non_object,
            missing_tool_input,
            empty_tool_input,
            missing_cwd,
            bad_cwd,
            bad_tool,
        ):
            self.assertEqual(result.returncode, 2)

    def test_missing_or_invalid_workdir_blocks(self) -> None:
        for workdir in ("", 4, "does-not-exist"):
            with self.subTest(workdir=workdir):
                result = self.patch_result(
                    "*** Update File: docs/design.md", workdir=workdir
                )
                self.assertEqual(result.returncode, 2)

    def test_broken_shared_policy_fails_closed(self) -> None:
        broken = self.root / ".claude/hooks/broken.py"
        broken.write_text("raise RuntimeError('broken policy')\n", encoding="utf-8")
        broken_result = self.run_payload(
            self.payload({"file_path": "docs/design.md"}), shared=broken
        )
        self.assertEqual(broken_result.returncode, 2)

    def test_shared_policy_exception_fails_closed(self) -> None:
        broken = self.root / ".claude/hooks/raising.py"
        broken.write_text(
            "import subprocess\n"
            "def resolve_owning_worktree(path, anchor): return anchor\n"
            "def evaluate(path, data): raise RuntimeError('boom')\n",
            encoding="utf-8",
        )
        result = self.run_payload(
            self.payload({"file_path": "docs/design.md"}), shared=broken
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("failed", result.stderr.lower())

    def test_guidance_rewrites_command_but_preserves_canonical_path(self) -> None:
        source = (
            "import subprocess\n"
            "def resolve_owning_worktree(path, anchor): return anchor\n"
            "def evaluate(path, data):\n"
            " return (2, 'See /implement, then .claude/skills/implement/SKILL.md')\n"
        )
        custom = self.root / ".claude/hooks/guidance.py"
        custom.write_text(source, encoding="utf-8")
        result = self.run_payload(
            self.payload({"file_path": "docs/design.md"}), shared=custom
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("$ambercast-implementation", result.stderr)
        self.assertIn(".claude/skills/implement/SKILL.md", result.stderr)

    def test_main_rewrites_all_shared_recovery_variants_exactly(self) -> None:
        original = (
            "See /implement. Start /implement! Run /implement, Finish /implement; "
            "keep .claude/skills/implement/SKILL.md."
        )
        custom = self.root / ".claude/hooks/all-guidance.py"
        custom.write_text(
            "import subprocess\n"
            "def resolve_owning_worktree(path, anchor): return anchor\n"
            f"def evaluate(path, data): return (2, {original!r})\n",
            encoding="utf-8",
        )
        result = self.run_payload(
            self.payload({"file_path": "docs/design.md"}), shared=custom
        )
        self.assertEqual(result.returncode, 2)
        rewritten = result.stderr.strip()
        self.assertEqual(
            rewritten,
            "See $ambercast-implementation. Start $ambercast-implementation! "
            "Run $ambercast-implementation, Finish $ambercast-implementation; "
            "keep .claude/skills/implement/SKILL.md.",
        )
        self.assertEqual(rewritten.count("$ambercast-implementation"), 4)

    def test_adapter_generated_diagnostic_redacts_raw_path_and_patch(self) -> None:
        sentinel = "SECRET-PHASE-DIAGNOSTIC-SENTINEL"
        result = self.run_payload(
            {
                "cwd": str(self.root),
                "tool_input": {
                    "file_path": f"../{sentinel}.ts",
                    "command": f"*** Add File: ../{sentinel}.ts",
                },
            }
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(sentinel, result.stderr)


class PhaseProxyCacheContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="phase-proxy-")).resolve()
        (self.root / "src").mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.root)

    def fake_guard(
        self,
        runner: object,
        *,
        raise_evaluate: bool = False,
        probes: list[tuple[list[str], dict[str, object]]] | None = None,
    ) -> types.ModuleType:
        module = types.ModuleType("fake_shared_phase")
        module.subprocess = runner
        module.resolve_owning_worktree = lambda path, anchor: "original-resolver"
        module._observations = []

        def evaluate(path: str, data: dict) -> None:
            module._observations.append(
                {
                    "resolver": module.resolve_owning_worktree(path, "wrong-anchor"),
                    "environment": os.environ.get("CLAUDE_PROJECT_DIR"),
                    "proxy_installed": module.subprocess is not runner,
                }
            )
            if raise_evaluate:
                raise RuntimeError("evaluation exploded")
            calls = probes or [
                (
                    [
                        "git", "-C", str(self.root), "symbolic-ref",
                        "--quiet", "--short", "HEAD",
                    ],
                    {"capture_output": True, "text": True, "timeout": 5},
                )
            ]
            for argv, kwargs in calls:
                try:
                    module.subprocess.run(argv, **kwargs)
                except (OSError, module.subprocess.SubprocessError):
                    return None
            return None

        module.evaluate = evaluate
        return module

    def invoke_main(self, shared: types.ModuleType, targets: list[str]) -> tuple[int, str, str]:
        payload = {
            "cwd": str(self.root),
            "tool_input": {
                "command": "\n".join(f"*** Add File: {path}" for path in targets)
            },
        }
        stdout, stderr = io.StringIO(), io.StringIO()
        original_stdin = sys.stdin
        sys.stdin = io.StringIO(json.dumps(payload))
        try:
            with (
                mock.patch.object(GUARD, "verified_root", return_value=str(self.root)),
                mock.patch.object(GUARD, "project_root", return_value=str(self.root)),
                mock.patch.object(GUARD, "load_shared_guard", return_value=shared),
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                result = GUARD.main()
        finally:
            sys.stdin = original_stdin
        return result, stdout.getvalue(), stderr.getvalue()

    def test_one_proxy_cache_serves_identical_returning_probe_for_all_targets(self) -> None:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.return_value = subprocess.CompletedProcess([], 0, "issues/123\n", "")
        shared = self.fake_guard(runner)
        original_run = subprocess.run
        original_resolver = shared.resolve_owning_worktree
        original_subprocess = shared.subprocess
        result, _, stderr = self.invoke_main(
            shared, [f"src/generated-{index}.ts" for index in range(40)]
        )
        self.assertEqual(result, 0, stderr)
        self.assertEqual(runner.run.call_count, 1)
        self.assertIs(subprocess.run, original_run)
        self.assertIs(shared.resolve_owning_worktree, original_resolver)
        self.assertIs(shared.subprocess, original_subprocess)
        self.assertEqual(len(shared._observations), 40)
        self.assertTrue(all(item["resolver"] == str(self.root) for item in shared._observations))
        self.assertTrue(all(item["environment"] == str(self.root) for item in shared._observations))
        self.assertTrue(all(item["proxy_installed"] for item in shared._observations))

    def test_raised_probe_outcomes_are_cached_reraised_and_force_fail_closed(self) -> None:
        for raised in (
            subprocess.SubprocessError("git unavailable"),
            OSError("git executable unavailable"),
            subprocess.TimeoutExpired(["git"], 5),
        ):
            with self.subTest(raised=type(raised).__name__):
                runner = mock.Mock()
                runner.SubprocessError = subprocess.SubprocessError
                runner.run.side_effect = raised
                shared = self.fake_guard(runner)
                result, _, stderr = self.invoke_main(
                    shared, ["src/a.ts", "src/b.ts", "src/c.ts"]
                )
                self.assertEqual(runner.run.call_count, 1)
                self.assertEqual(len(shared._observations), 3)
                self.assertEqual(result, 2)
                self.assertIn("failed", stderr.lower())

    def test_symbolic_ref_accepts_only_attached_or_exact_detached_outcomes(self) -> None:
        argv = [
            "git", "-C", str(self.root), "symbolic-ref",
            "--quiet", "--short", "HEAD",
        ]
        kwargs = {"capture_output": True, "text": True, "timeout": 5}
        cases = [
            (subprocess.CompletedProcess(argv, 0, "issues/123\n", ""), 0),
            (subprocess.CompletedProcess(argv, 1, "", ""), 0),
            (subprocess.CompletedProcess(argv, 0, "", ""), 2),
            (subprocess.CompletedProcess(argv, 1, "issues/123\n", ""), 2),
            (subprocess.CompletedProcess(argv, 2, "", ""), 2),
            (subprocess.TimeoutExpired(argv, 5), 2),
            (OSError("git unavailable"), 2),
        ]
        for outcome, expected in cases:
            with self.subTest(outcome=type(outcome).__name__, expected=expected):
                runner = mock.Mock()
                runner.SubprocessError = subprocess.SubprocessError
                if isinstance(outcome, BaseException):
                    runner.run.side_effect = outcome
                else:
                    runner.run.return_value = outcome
                shared = self.fake_guard(runner, probes=[(argv, kwargs)])
                result, _, stderr = self.invoke_main(shared, ["src/a.ts", "src/b.ts"])
                self.assertEqual(result, expected, stderr)
                runner.run.assert_called_once_with(argv, **kwargs)

    def test_required_rev_parse_probes_require_nonempty_success_and_restore_proxy(self) -> None:
        kwargs = {"capture_output": True, "text": True, "timeout": 5}
        for suffix in ("--git-dir", "--absolute-git-dir"):
            argv = ["git", "-C", str(self.root), "rev-parse", suffix]
            cases = [
                (subprocess.CompletedProcess(argv, 0, ".git\n", ""), 0),
                (subprocess.CompletedProcess(argv, 0, "", ""), 2),
                (subprocess.CompletedProcess(argv, 1, ".git\n", ""), 2),
                (subprocess.TimeoutExpired(argv, 5), 2),
                (OSError("git unavailable"), 2),
            ]
            for outcome, expected in cases:
                with self.subTest(probe=suffix, outcome=type(outcome).__name__):
                    runner = mock.Mock()
                    runner.SubprocessError = subprocess.SubprocessError
                    if isinstance(outcome, BaseException):
                        runner.run.side_effect = outcome
                    else:
                        runner.run.return_value = outcome
                    shared = self.fake_guard(runner, probes=[(argv, kwargs)])
                    original_subprocess = shared.subprocess
                    original_resolver = shared.resolve_owning_worktree
                    result, _, stderr = self.invoke_main(shared, ["src/a.ts", "src/b.ts"])
                    self.assertEqual(result, expected, stderr)
                    runner.run.assert_called_once_with(argv, **kwargs)
                    self.assertIs(shared.subprocess, original_subprocess)
                    self.assertIs(shared.resolve_owning_worktree, original_resolver)

    def test_classified_probe_does_not_trust_result_args_metadata(self) -> None:
        kwargs = {"capture_output": True, "text": True, "timeout": 5}
        probes = [
            [
                "git", "-C", str(self.root), "symbolic-ref",
                "--quiet", "--short", "HEAD",
            ],
            ["git", "-C", str(self.root), "rev-parse", "--git-dir"],
        ]
        for argv in probes:
            with self.subTest(argv=argv):
                runner = mock.Mock()
                runner.SubprocessError = subprocess.SubprocessError
                runner.run.return_value = subprocess.CompletedProcess([], 2, "", "")
                shared = self.fake_guard(runner, probes=[(argv, kwargs)])

                result, _, stderr = self.invoke_main(shared, ["src/a.ts"])

                self.assertEqual(result, 2, stderr)
                runner.run.assert_called_once_with(argv, **kwargs)

    def test_attached_and_detached_probe_sets_are_bounded_independent_of_target_count(self) -> None:
        common = {"capture_output": True, "text": True, "timeout": 5}
        attached_probes = [
            (["git", "-C", str(self.root), "rev-parse", "--git-dir"], common),
            (
                [
                    "git", "-C", str(self.root), "symbolic-ref",
                    "--quiet", "--short", "HEAD",
                ],
                common,
            ),
        ]
        detached_probes = [
            *attached_probes,
            (["git", "-C", str(self.root), "rev-parse", "--absolute-git-dir"], common),
        ]
        for probes, expected in ((attached_probes, 2), (detached_probes, 3)):
            with self.subTest(expected=expected):
                runner = mock.Mock()
                runner.SubprocessError = subprocess.SubprocessError
                runner.run.return_value = subprocess.CompletedProcess([], 0, "ok\n", "")
                result, _, stderr = self.invoke_main(
                    self.fake_guard(runner, probes=probes),
                    [f"src/many-{index}.ts" for index in range(60)],
                )
                self.assertEqual(result, 0, stderr)
                self.assertEqual(runner.run.call_count, expected)

    def test_cache_key_includes_every_supported_keyword(self) -> None:
        argv = ["git", "status"]
        probes = [
            (argv, {"capture_output": True, "text": True, "timeout": 5}),
            (argv, {"capture_output": False, "text": True, "timeout": 5}),
            (argv, {"capture_output": True, "text": False, "timeout": 5}),
            (argv, {"capture_output": True, "text": True, "timeout": 4}),
        ]
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.return_value = subprocess.CompletedProcess([], 0, "", "")
        result, _, stderr = self.invoke_main(
            self.fake_guard(runner, probes=probes), ["src/a.ts", "src/b.ts"]
        )
        self.assertEqual(result, 0, stderr)
        self.assertEqual(runner.run.call_count, 4)

    def test_shared_symbols_and_environment_restore_after_evaluation_exception(self) -> None:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        shared = self.fake_guard(runner, raise_evaluate=True)
        resolver = shared.resolve_owning_worktree
        shared_subprocess = shared.subprocess
        before = os.environ.get("CLAUDE_PROJECT_DIR")
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": "sentinel"}, clear=False):
            result, _, _ = self.invoke_main(shared, ["src/a.ts"])
            self.assertEqual(os.environ.get("CLAUDE_PROJECT_DIR"), "sentinel")
        self.assertEqual(os.environ.get("CLAUDE_PROJECT_DIR"), before)
        self.assertEqual(result, 2)
        self.assertIs(shared.resolve_owning_worktree, resolver)
        self.assertIs(shared.subprocess, shared_subprocess)

    def test_initially_unset_environment_is_present_only_during_normal_evaluation(self) -> None:
        runner = mock.Mock()
        runner.SubprocessError = subprocess.SubprocessError
        runner.run.return_value = subprocess.CompletedProcess(
            [], 0, "issues/123\n", ""
        )
        shared = self.fake_guard(runner)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("CLAUDE_PROJECT_DIR", os.environ)
            result, _, stderr = self.invoke_main(shared, ["src/a.ts", "src/b.ts"])
            self.assertEqual(result, 0, stderr)
            self.assertNotIn("CLAUDE_PROJECT_DIR", os.environ)
        self.assertEqual(len(shared._observations), 2)
        self.assertTrue(
            all(item["environment"] == str(self.root) for item in shared._observations)
        )

    def test_resolver_proxy_and_environment_contract_covers_set_unset_normal_error(self) -> None:
        for initial in (None, "previous-project-root"):
            for raises in (False, True):
                with self.subTest(initial=initial, raises=raises):
                    runner = mock.Mock()
                    runner.SubprocessError = subprocess.SubprocessError
                    runner.run.return_value = subprocess.CompletedProcess(
                        [], 0, "issues/123\n", ""
                    )
                    shared = self.fake_guard(runner, raise_evaluate=raises)
                    original_resolver = shared.resolve_owning_worktree
                    original_subprocess = shared.subprocess
                    with mock.patch.dict(os.environ, {}, clear=True):
                        if initial is not None:
                            os.environ["CLAUDE_PROJECT_DIR"] = initial
                        result, _, _ = self.invoke_main(shared, ["src/a.ts"])
                        self.assertEqual(os.environ.get("CLAUDE_PROJECT_DIR"), initial)
                    self.assertEqual(result, 2 if raises else 0)
                    self.assertEqual(len(shared._observations), 1)
                    observation = shared._observations[0]
                    self.assertEqual(observation["resolver"], str(self.root))
                    self.assertEqual(observation["environment"], str(self.root))
                    self.assertTrue(observation["proxy_installed"])
                    self.assertIs(shared.resolve_owning_worktree, original_resolver)
                    self.assertIs(shared.subprocess, original_subprocess)

    def test_real_shared_guard_uses_two_or_three_distinct_cached_probes(self) -> None:
        def load_real_shared() -> types.ModuleType:
            spec = importlib.util.spec_from_file_location(
                f"real_shared_phase_{time.monotonic_ns()}", SHARED_PATH
            )
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            return module

        class CountingSubprocess:
            SubprocessError = subprocess.SubprocessError

            def __init__(self) -> None:
                self.calls: list[tuple[tuple[str, ...], tuple[tuple[str, object], ...]]] = []

            def run(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
                key = (tuple(argv), tuple(sorted(kwargs.items())))
                self.calls.append(key)
                time.sleep(0.002)
                return subprocess.run(argv, **kwargs)

        subprocess.run(["git", "init", "-q", "-b", "issues/123"], cwd=self.root, check=True)
        subprocess.run(
            [
                "git", "-c", "user.name=Test", "-c", "user.email=test@example.com",
                "commit", "--allow-empty", "-q", "-m", "initial",
            ],
            cwd=self.root,
            check=True,
        )
        (self.root / ".claude/impl").mkdir(parents=True)
        (self.root / ".claude/impl/issue-123.state").write_text(
            "issue=123\nbranch=issues/123\n"
            "step05_plan_revised=done\nstep08_docs_review=done\n",
            encoding="utf-8",
        )
        targets = [f"src/real-{index}.ts" for index in range(50)]

        attached = load_real_shared()
        attached_runner = CountingSubprocess()
        attached.subprocess = attached_runner
        result, _, stderr = self.invoke_main(attached, targets)
        self.assertEqual(result, 0, stderr)
        self.assertEqual(len(attached_runner.calls), 2)
        self.assertEqual(len(set(attached_runner.calls)), 2)

        subprocess.run(["git", "checkout", "--detach", "-q"], cwd=self.root, check=True)
        git_dir = pathlib.Path(
            subprocess.run(
                ["git", "rev-parse", "--absolute-git-dir"],
                cwd=self.root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
        (git_dir / "rebase-merge").mkdir()
        (git_dir / "rebase-merge/head-name").write_text(
            "refs/heads/issues/123\n", encoding="utf-8"
        )
        detached = load_real_shared()
        detached_runner = CountingSubprocess()
        detached.subprocess = detached_runner
        result, _, stderr = self.invoke_main(detached, targets)
        self.assertEqual(result, 0, stderr)
        self.assertEqual(len(detached_runner.calls), 3)
        self.assertEqual(len(set(detached_runner.calls)), 3)


if __name__ == "__main__":
    unittest.main()
