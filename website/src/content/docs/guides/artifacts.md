---
title: Artifacts
description: What each generated file is, whether to commit it, and the grounding.repositoryPolicy switch.
sidebar:
  order: 6
---

| File | What it is | Commit to git? |
| --- | --- | --- |
| `<name>.test.md` | The prompt — source of truth | Yes |
| `<name>.ambercast.plan.json` | Generated execution plan | Yes (review it like a lockfile) |
| `<name>.ambercast.grounding.json` | Cached selectors/state the plan resolved | Yes by default (`grounding.repositoryPolicy: "committed"`) |
| `tests/ambercast/.runs/<invocation-id>/...` | Per-run evidence and `report.json` (location = `runsDir`) | No — gitignore this directory |

The plan and grounding files live next to their prompt, under `testDir`. Run evidence lives under `runsDir`, which defaults to `tests/ambercast/.runs` (inside `testDir`) rather than a project-root `.runs`.

## Commit policy

Plans and grounding caches are meant to be reviewed like a lockfile: a diff in `<name>.ambercast.plan.json` shows exactly how the generated steps changed, and a diff in `<name>.ambercast.grounding.json` shows exactly how the resolved selectors changed.

## `grounding.repositoryPolicy`

Controls whether the grounding cache is treated as a committed artifact:

- `"committed"` (default) — the grounding cache is expected in git alongside the plan; `check` uses this to classify a fresh plan with no grounding file as stale rather than merely uncached.
- `"uncommitted"` — the grounding cache is treated as local, disposable state (for example, gitignored). `run` still writes and reads it locally under this policy; it just isn't expected to exist for `check` to consider the pair trustworthy in a fresh checkout.

See [Configuration reference](/ambercast/reference/configuration/) for the full field list, and [Secrets](/ambercast/guides/secrets/) for what the grounding cache never contains.
