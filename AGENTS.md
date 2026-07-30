# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, and others) working in this repository. This file is the single source of truth for agent guidance; `CLAUDE.md` merely imports it.

## What this project is

**ambercast** — prompt-native E2E testing.

Test cases are written as natural-language Markdown prompts; the prompt is the single source of truth. An AI compiler turns each prompt into a deterministic, lockfile-like execution plan (IR). Replays run with **zero AI calls**: fast, free, fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human reviews.

## Status

Pre-implementation. The current package is a 0.0.1 placeholder that reserves the npm name; `bin/ambercast.js` only prints a banner. Implementation starts from this state.

## Repository layout

- `bin/` — CLI entry point (placeholder)
- `package.json` — `files: ["bin"]` limits what gets published; keep agent/config files out of the tarball
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
- TypeScript, Node >= 18.
- **TDD is mandatory**: write a failing test first (red), implement minimally (green), refactor. Cover normal, error, boundary, and edge cases. Run the full test suite before declaring any task done.
- Validation: zod for runtime schemas (discriminated unions for step types), JSON Schema for the public spec.
- Keep diffs minimal and reviewable; the IR's git-diff quality is a product feature, treat serialization changes as breaking.

## Commands

- `node bin/ambercast.js` — run the placeholder CLI
- `npm pack --dry-run` — verify publish contents (must stay: package.json, README, LICENSE, bin/)

Build/test commands will be added here as the toolchain lands. Keep this file updated as the implementation grows.
