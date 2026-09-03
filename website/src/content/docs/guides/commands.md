---
title: Commands
description: generate, run, check, and heal — flags, what they write, when AI is called, and CI behavior.
sidebar:
  order: 4
---

Every command accepts `--config <path>`, `--no-color`, `--json`, and the shared `--` separator (everything after it is treated as literal prompt paths, even ones starting with `--`). Positionals are literal prompt paths; with none given, ambercast discovers prompts via `testDir`/`testMatch`/`testIgnore`.

## `generate [files...]`

Turns prompts into plans. Calls AI once per prompt that needs it; skips prompts whose plan is already fresh.

| Flag | Effect |
| --- | --- |
| `--strict` | Ambiguous generation output fails instead of only warning |
| `--force` | Regenerates unconditionally, even if the plan is fresh |
| `--dry-run` | Previews without writing plan/grounding files |
| `--target <name>` | Selects a configured target |
| `--ai <claude\|codex>` | Overrides provider selection for this invocation |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without generating |
| `--config <path>` | Uses an explicit config file |

Writes: `<name>.ambercast.plan.json`, `<name>.ambercast.grounding.json`.

## `run [files...]`

Replays plans against a real Chromium session, deterministically, with no AI calls unless a step's cached grounding is missing.

| Flag | Effect |
| --- | --- |
| `--grep <pattern>` | Filters discovered prompt paths by regular expression |
| `--target <name>` | Selects a configured target |
| `--headed` | Runs with a visible browser window |
| `--cache-only` | Fails a grounding miss instead of falling back to AI |
| `--update-cache` | Explicitly authorizes persisting this run's grounding-cache changes |
| `--stale <fail>` | Freshness policy on a stale/missing plan; only `fail` is currently supported (`regenerate` is accepted by the parser but always rejected with exit 2 today) |
| `--ai <claude\|codex>` | Overrides the provider used only if a grounding-miss fallback is needed |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without executing |

Writes: per-invocation evidence and `report.json` under `.runs/` (see [Artifacts](/ambercast/guides/artifacts/)); grounding-cache updates, subject to the write-back matrix below.

### Grounding write-back

Whether a grounding-cache change is actually persisted depends on `--update-cache`, `grounding.localWriteBack`, and (in CI) `ci.updateGroundingCache`:

| Environment | Persists when |
| --- | --- |
| Local, `localWriteBack: "auto"` (default) | Always |
| Local, `localWriteBack: "explicit"` | `--update-cache` passed |
| CI | `--update-cache` passed, or `ci.updateGroundingCache: true` |

## `check [files...]`

Read-only freshness inspection. Never calls an AI provider or a browser, and never writes. Use it as a CI gate before `run`.

| Flag | Effect |
| --- | --- |
| `--target <name>` | Selects a configured target |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without checking |
| `--config <path>` | Uses an explicit config file |

## `heal [files...]`

Repairs a plan whose grounding no longer matches the live UI: step re-resolution, then structured step repair, then whole-plan regeneration, escalating only as far as needed.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Measures and previews repairs without writing anything |
| `--yes`, `-y` | Commits repairs without an interactive confirmation prompt |
| `--target <name>` | Selects a configured target |
| `--ai <claude\|codex>` | Overrides provider selection for this invocation |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without healing |

### Heal-in-CI refusal

`heal` does not run automatically anywhere, and it refuses to run in CI at all (exit 2) unless `ci.heal: true` is set in `ambercast.config.json` — see [CI usage](/ambercast/guides/ci/).

Two configuration keys shape incremental repair; see the [configuration reference](/ambercast/reference/configuration/) for their full contract:

- `heal.maxStepRepairs` — hard limit on real provider dispatches per healing batch (unset by default — no limit).
- `heal.caseTimeoutMs` — admission-boundary deadline for one healing case.
