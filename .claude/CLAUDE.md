# .claude/

Shared Claude Code configuration for this repository (committed; local state is gitignored).

- `skills/implement/` — the mandatory 17-step implementation flow (`/implement`)
- `rules/implementation-flow.md` — binding rules: flow-only implementation, no commits on main, state-file honesty
- `hooks/guard_git.py` — blocks commits/pushes on main and non-`issues/<N>` branches
- `hooks/guard_phase.py` — blocks src/test edits until the required /implement steps are done
- `settings.json` — wires the hooks (PreToolUse)
- `impl/` (gitignored) — per-issue state files, plans, and review artifacts
- `logs/`, `todos/` (gitignored) — personal orchestration state
