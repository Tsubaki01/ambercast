---
title: CI usage
description: A safe default CI pipeline, heal refusal in CI, cache write-back rules, and exit-code gating.
sidebar:
  order: 8
---

A safe default for CI is `check` to gate freshness, then `run` without healing or cache write-back:

```bash
npx ambercast check
npx ambercast run
```

- `heal` does not run automatically anywhere, and it refuses to run in CI at all (exit 2) unless you opt in with `ci.heal: true` in `ambercast.config.json`.
- Grounding-cache changes from `run` are not persisted in CI unless you pass `--update-cache` for that invocation or set `ci.updateGroundingCache: true` — see the [write-back matrix](/ambercast/guides/commands/#grounding-write-back).
- Gate your pipeline on the process exit code (see [Exit codes](/ambercast/guides/exit-codes/)); `4` in particular means the committed plan/grounding no longer matches the prompt and needs `generate` or `heal`, not a re-run.
