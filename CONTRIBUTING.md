# Contributing

Thanks for your interest in ambercast!

## Current state

ambercast is published on npm (0.x, pre-1.0). The CLI (`generate`, `run`, `check`, `heal`) is functional, but breaking changes can still land in a minor release. Contributions to code, tests, docs (README in three locales, the docs site under `website/`), and toolchain are all welcome. Please open an issue before large changes.

## Development

Requires Node.js >= 22.14, then run `npm ci`.

- `npm run build` — compile `src/` to `dist/` (tsdown) and regenerate the config schema
- `npm test` — build then run the Vitest suite
- `npm run typecheck` / `npm run lint`
- `cd website && npm ci && npm run build` — build the docs site (Astro/Starlight); `npm run dev` there for a local preview

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
