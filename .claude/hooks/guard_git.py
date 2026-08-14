#!/usr/bin/env python3
"""PreToolUse hook (Bash): enforce the branch discipline of the /implement flow.

Blocks (exit 2):
- `git commit` / `git push` while the repository is on `main`
- `git commit` on any branch not named `issues/<N>` or `issues/<N>-<slug>`

Branch grammar: ASCII digits, slug words are lowercase alphanumerics joined
by single hyphens. Accepted: issues/12, issues/12-schema, issues/12-fix-login.
Rejected: issues/12-, issues/12--a, issues/12-A, unicode digits.

Everything else passes through (exit 0). Runs outside a work tree -> no-op.

Directory resolution deliberately selects the first available trusted
execution-context value (`data["cwd"]`, then `CLAUDE_PROJECT_DIR`, then the
hook process's own cwd); it never derives a directory from shell command text.
The hook still reads command text separately, elsewhere, to classify commit,
push, and branch-switch operations -- but no command shape, a `-C <path>` flag,
a leading `cd`, or anything else, changes which directory this resolution
picks. Parsing command text cannot safely reproduce the combined Git and shell
grammars, so using a command-derived path for resolution would create a bypass
surface.

This does mean resolution cannot recover once its selected value is itself
wrong. A missing directory, or one outside a Git worktree, is still observable:
the branch probe below fails and the hook fails open. A directory that is
merely the *wrong* checkout -- the main checkout, or another session's
still-existing linked worktree -- is not: it is indistinguishable from the
intended checkout using only execution-context signals, since both are real,
valid checkouts of this repository. In that situation the branch check below
runs against the wrong checkout, and a command's `-C` cannot correct it: `-C`
only changes where *git* itself acts, never which directory the guard
evaluates. That asymmetry cuts both ways -- it can produce a false-positive
block on a correctly-checked-out directory, and, inversely, it can let the
guard approve a command whose `-C` (or shell cwd) actually targets a different
checkout than the one just evaluated. The former is judged the safer failure
mode; closing the latter would require trusting command text.

Every block reports that trusted directory, its source tier, and the observed
branch so the affected teammate can hand off a single verified report instead
of retrying a command whose context cannot change. Command classification is
separate from this resolution: a command-position lexer identifies actual Git
operations, while quoted prose remains data rather than an invocation. A
Git-bearing command whose shell grammar is too complex for that deliberately
small lexer is blocked on every branch; guessing would make branch protection
dependent on syntax the hook cannot reliably model.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys


ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.S)
STRUCTURAL_SHELL_TOKENS = {
    "(", ")", "{", "}", "if", "then", "elif", "else", "fi", "while",
    "for", "until", "case", "do", "done", "esac", "select", "function",
}
GIT_OPTIONS_WITH_VALUE = {
    "-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
    "--config-env", "--exec-path",
}
ENV_OPTIONS_WITH_VALUE = {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}
WRAPPER_COMMANDS = {"command", "exec", "sudo", "nice", "time"}
WRAPPER_OPTIONS_WITH_VALUE = {
    "exec": {"-a"},
    "sudo": {
        "-u", "-g", "-h", "-r", "-t", "-C", "-R", "-T", "--user",
        "--group", "--host", "--prompt", "--role", "--type", "--close-from",
        "--chroot", "--chdir",
    },
    "nice": {"-n", "--adjustment"},
}


# The resolver returns both the chosen path and a stable source label. The
# label is diagnostic only; accepting `-C`, `cd`, or any shell-derived path
# here would turn a helpful message into a branch-protection bypass.
def resolve_target_dir(data: dict) -> tuple[str, str]:
    """Return the trusted hook directory and its established fallbacks."""
    if data.get("cwd"):
        return data["cwd"], "data.cwd"
    if os.environ.get("CLAUDE_PROJECT_DIR"):
        return os.environ["CLAUDE_PROJECT_DIR"], "CLAUDE_PROJECT_DIR"
    return os.getcwd(), "process cwd"


def _contains_git(text):
    return bool(re.search(r"(?<![A-Za-z0-9_.-])git\b", text))


def _shell_tokens(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";|&()\n")
    # A Bash tool submission commonly contains one command per physical line.
    # Leaving newline out of whitespace makes it a command separator without
    # disturbing quoted newlines, which shlex still returns inside one token.
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def _is_git_executable(token):
    return _executable_basename(token) == "git"


def _executable_basename(token):
    """Normalize a command-path token without granting it path authority."""
    return token.rsplit("/", 1)[-1]


def _is_operator(token):
    """Recognize every shlex punctuation run that starts a new command."""
    return bool(token) and all(character in ";|&\n" for character in token)


def _is_shell_executable(token):
    """Recognize an interpreter token without assuming it lacks a path."""
    return _executable_basename(token) in {"sh", "bash", "zsh"}


def _has_combined_shell_c_flag(tokens, index):
    """Whether this shell invocation executes a nested command string."""
    for token in tokens[index + 1:]:
        if _is_operator(token):
            break
        if token == "--":
            break
        if token.startswith("-") and not token.startswith("--") and "c" in token[1:]:
            return True
    return False


def _skip_env(tokens, index):
    """Skip environment setup so the next command-position token is executable."""
    index += 1
    while index < len(tokens):
        token = tokens[index]
        if _is_operator(token):
            return index
        if token == "--":
            return index + 1
        if ASSIGNMENT_RE.fullmatch(token):
            index += 1
            continue
        if token.startswith("-"):
            if (
                token in ENV_OPTIONS_WITH_VALUE
                and index + 1 < len(tokens)
                and not _is_operator(tokens[index + 1])
            ):
                index += 2
            else:
                index += 1
            continue
        return index
    return index


def _skip_wrapper(tokens, index):
    """Skip a shell wrapper and its setup options before its executable."""
    wrapper = _executable_basename(tokens[index])
    options_with_value = WRAPPER_OPTIONS_WITH_VALUE.get(wrapper, set())
    index += 1
    while index < len(tokens):
        token = tokens[index]
        if _is_operator(token):
            return index
        if token == "--":
            return index + 1
        if not token.startswith("-"):
            return index
        if (
            token in options_with_value
            and index + 1 < len(tokens)
            and not _is_operator(tokens[index + 1])
        ):
            index += 2
        else:
            index += 1
    return index


def _git_subcommand(tokens, index):
    """Return Git's first non-global option, which is its subcommand."""
    index += 1
    while index < len(tokens):
        token = tokens[index]
        if _is_operator(token):
            return None
        if token == "--":
            if index + 1 < len(tokens) and not _is_operator(tokens[index + 1]):
                return tokens[index + 1]
            return None
        if token in GIT_OPTIONS_WITH_VALUE:
            if index + 1 < len(tokens) and not _is_operator(tokens[index + 1]):
                index += 2
            else:
                return None
            continue
        if token.startswith(("-c", "-C")) and token not in {"-c", "-C"}:
            index += 1
            continue
        if token.startswith((
            "--git-dir=", "--work-tree=", "--namespace=", "--super-prefix=",
            "--config-env=", "--exec-path=",
        )):
            index += 1
            continue
        if token.startswith("-"):
            index += 1
            continue
        return token
    return None


def _is_ambiguous_shell(command, tokens):
    """Recognize constructs whose nested command grammar shlex cannot prove safe."""
    if not _contains_git(command):
        return False
    if "$(" in command or "`" in command:
        return True
    for index, token in enumerate(tokens):
        if token == "eval" or token in STRUCTURAL_SHELL_TOKENS:
            return True
        if _is_shell_executable(token) and _has_combined_shell_c_flag(tokens, index):
            return True
    return False


def classify(command):
    """Classify protected Git operations without searching quoted argument text."""
    if not _contains_git(command):
        return False, False, False, False
    try:
        tokens = _shell_tokens(command)
    except ValueError:
        return False, False, False, True
    if _is_ambiguous_shell(command, tokens):
        return False, False, False, True

    commit = push = branch_switch = False
    index = 0
    command_position = True
    while index < len(tokens):
        token = tokens[index]
        if _is_operator(token):
            command_position = True
            index += 1
            continue
        if not command_position:
            index += 1
            continue
        while index < len(tokens) and ASSIGNMENT_RE.fullmatch(tokens[index]):
            index += 1
        if index >= len(tokens):
            break
        if _is_operator(tokens[index]):
            command_position = True
            continue
        while index < len(tokens):
            if _is_operator(tokens[index]):
                break
            executable = _executable_basename(tokens[index])
            if executable == "env":
                index = _skip_env(tokens, index)
                continue
            if executable in WRAPPER_COMMANDS:
                index = _skip_wrapper(tokens, index)
                continue
            break
        if index < len(tokens) and _is_operator(tokens[index]):
            command_position = True
            continue
        if index < len(tokens) and _is_git_executable(tokens[index]):
            subcommand = _git_subcommand(tokens, index)
            commit = commit or subcommand == "commit"
            push = push or subcommand == "push"
            branch_switch = branch_switch or subcommand in {"checkout", "switch"}
        command_position = False
        index += 1
    return commit, push, branch_switch, False


def _block_message(reason, proj, tier, branch):
    """Attach one actionable trusted-context handoff to every policy block."""
    return (
        f"BLOCKED: {reason}\n"
        f"Resolved directory: {proj} (source: {tier})\n"
        f"Observed branch: {branch}\n"
        "Do not retry repeatedly. If this appears to be a false positive, run "
        "`git -C <your-worktree> rev-parse --abbrev-ref HEAD` and report its "
        "result and this message to the orchestrator once."
    )


def evaluate(command: str, data: dict) -> tuple[int, str] | None:
    """Return a branch-policy block for a commit or push command, if needed."""
    is_commit, is_push, has_branch_switch, ambiguous = classify(command)
    if not (is_commit or is_push or ambiguous):
        return None

    proj, tier = resolve_target_dir(data)
    try:
        res = subprocess.run(
            ["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        if ambiguous:
            return 2, _block_message(
                "shell syntax is too complex to statically classify a Git "
                "operation. Rewrite it as a simple, single-command form (for "
                "example, `git -C <path> commit -m \"...\"`) and retry.",
                proj, tier, "unavailable (branch probe failed)",
            )
        return None
    if res.returncode != 0:
        if ambiguous:
            return 2, _block_message(
                "shell syntax is too complex to statically classify a Git "
                "operation. Rewrite it as a simple, single-command form (for "
                "example, `git -C <path> commit -m \"...\"`) and retry.",
                proj, tier, "unavailable (branch probe failed)",
            )
        return None
    branch = res.stdout.strip()

    if ambiguous:
        return 2, _block_message(
            "shell syntax is too complex to statically classify a Git "
            "operation. Rewrite it as a simple, single-command form (for "
            "example, `git -C <path> commit -m \"...\"`) and retry.",
            proj, tier, branch,
        )

    # The branch is sampled BEFORE the command runs, so a compound command that
    # switches branches and then commits would be judged against the wrong
    # branch. Standalone switches (no commit/push in the command) pass through.
    if has_branch_switch:
        return 2, _block_message(
            "branch switching and commit/push in one command hides the real "
            "target branch from this guard. Run the switch first, then commit/push "
            "as a separate command.",
            proj, tier, branch,
        )

    if branch == "main":
        return 2, _block_message(
            "commits/pushes on main are forbidden. Start the /implement flow and "
            "work on an issues/<N> branch.",
            proj, tier, branch,
        )

    if is_commit and not re.fullmatch(r"issues/[0-9]+(?:-[a-z0-9]+)*", branch):
        return 2, _block_message(
            f"branch '{branch}' does not match issues/<N> or issues/<N>-<slug>. "
            "The /implement flow requires one branch per GitHub issue (stack layers "
            "use the issues/<N>-<slug> form).",
            proj, tier, branch,
        )

    return None


def main() -> int:
    """Apply branch enforcement to hook input and emit a block message if needed."""
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0

    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    command = tool_input.get("command", "")
    if not isinstance(command, str):
        return 0
    if "cwd" in data and not isinstance(data["cwd"], str):
        return 0

    result = evaluate(command, data)
    if result is None:
        return 0

    exit_code, message = result
    print(message, file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
