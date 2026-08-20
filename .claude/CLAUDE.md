# .claude/

- Treat this directory as committed Claude Code configuration; keep local state in the gitignored paths listed below.
- Use `skills/implement/` for the mandatory 17-step `/implement` flow.
- Enforce flow-only implementation, no commits on main, and honest state files through `rules/implementation-flow.md`.
- Use `hooks/guard_git.py` to block commits and pushes on main, compound switch-and-commit commands, and commits outside `issues/<N>` or `issues/<N>-<slug>` branches.
- Use `hooks/guard_phase.py` to block src, bin, and test edits until the required flow steps are complete across rebases and linked worktrees.
- Use `hooks/guard_stop.py` to keep unfinished implementation flows moving while allowing intentional pauses and live background work.
- Use `hooks/watch_progress.py` as the asyncRewake watchdog for stalled issue flows and idle orchestrators.
- Wire Claude Code hooks through `settings.json`.
- Store per-issue state, plans, and review artifacts in the gitignored `impl/` directory.
- Store personal orchestration state in the gitignored `logs/` and `todos/` directories.
- Use `../.agents/skills/` for repo-scoped Agent Skills, including gh-stack and Codex's Ambercast implementation adapter.
