# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, and others) working in this repository. This file is the single source of truth for agent guidance; `CLAUDE.md` merely imports it.

## What this project is

**ambercast** — prompt-native E2E testing.

Test cases are written as natural-language Markdown prompts; the prompt is the single source of truth. An AI compiler turns each prompt into a deterministic, lockfile-like execution plan (IR). Replays run with **zero AI calls**: fast, free, fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human reviews.

## Status

Pre-implementation. The current package is a 0.0.1 placeholder that reserves the npm name; `bin/ambercast.js` only prints a banner. Implementation starts from this state.

## Repository layout

- `bin/` — CLI entry point (placeholder), a thin shim to the built `dist/`
- `src/` — TypeScript sources, compiled by `tsdown` to `dist/` (gitignored, built on demand)
- `package.json` — `files: ["bin", "dist"]` limits what gets published; keep agent/config files and sources out of the tarball
- `AGENTS.md` / `CLAUDE.md` — agent guidance (this file is canonical)

## Core design decisions (fixed — do not re-litigate in code)

- The prompt (`<name>.test.md`) is the source of truth. The IR is a compiled artifact, never hand-edited.
- IR files: `<name>.ambercast.plan.json` (reviewed, committed) and `<name>.ambercast.grounding.json` (grounding cache, committed by default). Run results go to `.runs/` (gitignored).
- IR format: plain JSON (RFC 8259). Canonical serialization: JCS-style key ordering with 2-space pretty-printing; parse → re-serialize must be byte-identical.
- Freshness: the plan embeds an `inputsDigest` (normalized prompt digest + schemaVersion + compiler prompt-template fingerprint + target definitions). Stale plans fail with a message; no silent auto-recompile in CI.
- Repairs regenerate a step subtree via structured output and re-serialize the whole document — never patch raw text.
- Secrets are referenced (`{{secrets.*}}`), never baked into the IR; the schema rejects literal secrets.

## Conventions

- English-native: all code, comments, docs, commit messages, and identifiers are in English.
- TypeScript, Node >= 22.14, ESM-only (`"type": "module"`). Built with `tsdown`.
- **TDD is mandatory**: write a failing test first (red), implement minimally (green), refactor. Cover normal, error, boundary, and edge cases. Run the full test suite before declaring any task done.
- Validation: zod for runtime schemas (discriminated unions for step types), JSON Schema for the public spec.
- Keep diffs minimal and reviewable; the IR's git-diff quality is a product feature, treat serialization changes as breaking.

## Development workflow (enforced)

All implementation goes through the **`/implement` skill** (`.claude/skills/implement/SKILL.md`) — a mandatory 17-step flow: GitHub issue → `issues/<N>` branch (or `issues/<N>-<slug>` stack layers) → plan → parallel review across up to seven perspectives (component design runs only for UI work; non-UI tasks skip it and record the skip) → docs-first coding (comments/JSDoc as the design spec, emphasizing Why and design-level How per the comment rules in `.claude/rules/implementation-flow.md`) → comprehensive tests → implementation → independent reviews at each gate → PR → CI → CodeRabbit → merge.

Enforcement is layered: GitHub branch protection (PRs only, conversations resolved), PreToolUse hooks (`.claude/hooks/`) that block commits on `main` and block src/test edits until the per-issue state file records the prerequisite steps, and the binding rules in `.claude/rules/implementation-flow.md`. Do not bypass or edit the guards; if a guard blocks you incorrectly, stop and tell the maintainer. The guards themselves change only through a maintainer-approved PR dedicated to workflow changes.

**Branching & releases**: trunk-based — `main` plus short-lived `issues/<N>`(-`<slug>`) branches only; no develop or release branches, and hotfixes use the normal issue flow. Merges are **squash-only** (enforced in repo settings): the PR title becomes the commit subject and MUST follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with `!` for breaking changes). Releases are driven by **release-please**: it maintains a Release PR from the conventional commit history; merging that PR creates the `v*` tag, GitHub Release, and CHANGELOG, and the same workflow's `publish` job (gated on `release_created` — GITHUB_TOKEN-created releases cannot trigger separate workflows) then publishes to npm via OIDC trusted publishing (tokenless, provenance attached). Versioning is semver, staying on 0.x until MVP. Never publish to npm manually. npm authenticates the publish job via a Trusted Publisher registered on npmjs.com (owner `Tsubaki01`, repository `ambercast`, workflow `release-please.yml`, no environment) — renaming that workflow file requires updating the npm-side registration first.

**Stacked pull requests** (GitHub native, public preview): when an issue splits into independently reviewable layers, plan a stack at step 3 and use layer branches `issues/<N>-<slug>` (e.g. `issues/12-schema` → `issues/12-serializer`). Manage stacks exclusively with `gh stack` following the official skill in `.agents/skills/gh-stack/SKILL.md` (non-interactive rules: always `--json`, `submit --auto`, positional branch names; `gh pr merge` does not work on stacks — use `gh stack merge --yes`). One issue per stack; unrelated work gets its own issue and branch.

## Parallel work with git worktrees (default)

Implementation tasks run in a **linked worktree per issue** by default; working directly in the main checkout requires a stated reason (e.g. a trivial few-line fix). The main checkout (`<product-root>/workspace/ambercast`) stays on `main` — integration, acceptance, and releases only — and is never switched to an issue branch (a branch cannot be checked out in two worktrees at once).

- Layout: worktrees live at `<product-root>/.worktrees/issues-<N>[-<slug>]` on branch `issues/<N>[-<slug>]`. When an issue is worked as a stacked PR, each layer branch gets its own worktree only if the layers are worked in parallel.
- Create: `node scripts/worktree-add.mjs <N> [slug]` — creates the branch from local `main` (or attaches an existing one), then runs `npm ci` and `npm run build` in the new worktree. `--no-setup` (or `AMBERCAST_WT_SKIP_SETUP=1`) skips setup. Receptacle override: `AMBERCAST_WORKTREE_ROOT`.
- Remove (after merge): `node scripts/worktree-remove.mjs <N> [--with-branch] [--force]` — copies this worktree's `.claude/logs/` and `.claude/todos/` files back to the main checkout first (per-issue state is gitignored, so it is worktree-local and would die with the directory), refuses dirty trees without `--force`, and refuses to remove the main checkout. Never delete a worktree directory by hand; if one was deleted, run `git worktree prune`.
- Concurrency: at most ~5 worktrees at a time; one agent, one scope per worktree; before merging, review `git diff main..issues/<N>`; merge one branch at a time and remove its worktree immediately.

## Commands

- `npm run build` — compile `src/` to `dist/` via `tsdown`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — build (via `pretest`) then run the Vitest suite
- `node bin/ambercast.js` — run the CLI (requires `npm run build` first)
- `node scripts/verify-pack.mjs` — authoritative, automated check that the
  packed tarball contains `dist/`, `bin/ambercast.js`, and that the bin file
  is executable; run this instead of eyeballing `npm pack --dry-run` output

Keep this file updated as the implementation grows.
