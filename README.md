# ambercast

Prompt-native E2E testing.

Write test cases as natural-language Markdown prompts — the prompt is the single source of truth. An AI compiler turns each prompt into a deterministic, lockfile-like execution plan. From then on, runs are replayed with **zero AI calls**: fast, free, and fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human is asked to review.

Like an insect preserved in amber, your test's intent is cast once and kept intact — no matter how the surface changes.

## Status

**Under active development.** This is an early placeholder release while the first implementation is being built. The CLI is not functional yet.

## Planned

- `ambercast compile` — natural-language prompt → deterministic execution plan (reviewable, committed to git)
- `ambercast run` — deterministic replay, zero AI calls on the happy path
- Self-repair on UI drift, human review on semantic change
- Local results viewer

## License

MIT
