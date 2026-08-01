# Contributing

Thanks for your interest in ambercast!

## Current state

The package is a pre-implementation placeholder — the CLI is not functional
yet. Until the TypeScript toolchain lands, realistic contributions are limited
to docs and configuration.

## How to contribute

1. **Open an issue first** describing the problem or proposal.
2. Fork and branch. Branch names are free-form for external contributors
   (the `issues/<N>` convention is maintainer automation, not a requirement).
3. Open a pull request. **The PR title must be a Conventional Commit**
   (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, optional scope,
   `!` for breaking changes). This repository squash-merges with the PR title
   as the commit subject, and releases are derived from those subjects by
   release-please — a malformed title breaks versioning, so CI enforces it.
4. All review conversations must be resolved before merge; CodeRabbit reviews
   every PR automatically.

## About AGENTS.md and .claude/

`AGENTS.md` and the `.claude/` directory describe the maintainer's AI-agent
automation (a 17-step implement flow with local hooks). They are **not** a
prerequisite for external contributions — the checks that matter for your PR
run in CI.

## Security

See [SECURITY.md](SECURITY.md) — please do not report vulnerabilities in
public issues.
