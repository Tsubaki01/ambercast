English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# ambercast

Prompt-native E2E testing.

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

Write test cases as natural-language Markdown prompts — the prompt is the single source of truth. An AI generator turns each prompt into a deterministic, lockfile-like execution plan. From then on, runs are replayed with **zero AI calls**: fast, free, and fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human is asked to review.

Like an insect preserved in amber, your test's intent is cast once and kept intact — no matter how the surface changes.

> [!NOTE]
> ambercast is pre-1.0 and under active development. See [Status & limitations](#status--limitations).

**Full documentation:** https://tsubaki01.github.io/ambercast/ (English / 日本語 / 简体中文)

## How it works

```text
sign-in.test.md
      │  ambercast generate (AI call, once)
      ▼
sign-in.ambercast.plan.json  +  sign-in.ambercast.grounding.json
      │  commit both to git
      ▼
ambercast run (replayed — zero AI calls)
      │
      ├─ grounding hit  → deterministic replay
      ├─ grounding miss → live AI-assisted step, cache updated (git-diffable)
      └─ drift detected → ambercast heal repairs the plan (human confirms)
```

1. **Generate** — an AI provider reads the prompt once and produces a plan (the steps to perform) and a grounding cache (the concrete selectors/coordinates it found). Both are plain JSON, meant to be committed and reviewed like a lockfile.
2. **Run** — replays the plan against a real browser using the cached grounding, with no AI calls on the happy path. A grounding miss for one step falls back to a live AI-assisted resolution for that step only (skip this with `--cache-only`).
3. **Heal** — when the UI has drifted enough that replay can't recover on its own, `ambercast heal` re-resolves, repairs, or regenerates the affected plan steps and asks for confirmation before writing.

## Prerequisites

- Node.js >= 22.14
- A Chromium binary for [Playwright](https://playwright.dev):

  ```bash
  npx playwright-core install chromium
  ```

- An AI provider CLI, already installed and authenticated — bring your own key, ambercast does not manage credentials:
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`), or
  - [Codex CLI](https://github.com/openai/codex) (`codex`)

  By default (`ai.provider: "auto"`) ambercast probes `claude` then `codex` and uses whichever responds; pass `--ai claude` / `--ai codex` or set `ai.provider` in the config to pin one.

## Install

```bash
npm install -D ambercast
```

Or run it without installing:

```bash
npx ambercast <command>
```

## Quick start

There is no `init` command yet, so set up the two pieces by hand.

1. Create `ambercast.config.json` in your project root (optional — these are the defaults):

   ```json
   {
     "testDir": "tests/ambercast",
     "targets": {
       "web-user": { "baseUrl": "http://localhost:3000", "browser": "chromium" }
     }
   }
   ```

2. Write a test prompt at `tests/ambercast/sign-in.test.md`:

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

3. Generate the plan, then run it:

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` writes `tests/ambercast/sign-in.ambercast.plan.json` and `tests/ambercast/sign-in.ambercast.grounding.json` next to the prompt. Commit all three files.

## Commands

Every command accepts `--config <path>`, `--no-color`, `--json`, and the shared `--` separator (everything after it is treated as literal prompt paths, even ones starting with `--`). Positionals are literal prompt paths; with none given, ambercast discovers prompts via `testDir`/`testMatch`/`testIgnore`.

### `generate [files...]`

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

### `run [files...]`

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

Writes: per-invocation evidence and `report.json` under `runsDir` (default `tests/ambercast/.runs/`; see [Artifacts](#artifacts)); grounding-cache updates, subject to the write-back policy below.

Whether a grounding-cache change is actually persisted depends on `--update-cache`, `grounding.localWriteBack`, and (in CI) `ci.updateGroundingCache`:

| Environment | Persists when |
| --- | --- |
| Local, `localWriteBack: "auto"` (default) | Always |
| Local, `localWriteBack: "explicit"` | `--update-cache` passed |
| CI | `--update-cache` passed, or `ci.updateGroundingCache: true` |

### `check [files...]`

Read-only freshness inspection. Never calls an AI provider or a browser, and never writes. Use it as a CI gate before `run`.

| Flag | Effect |
| --- | --- |
| `--target <name>` | Selects a configured target |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without checking |
| `--config <path>` | Uses an explicit config file |

### `heal [files...]`

Repairs a plan whose grounding no longer matches the live UI: step re-resolution, then structured step repair, then whole-plan regeneration, escalating only as far as needed.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Measures and previews repairs without writing anything |
| `--yes`, `-y` | Commits repairs without an interactive confirmation prompt |
| `--target <name>` | Selects a configured target |
| `--ai <claude\|codex>` | Overrides provider selection for this invocation |
| `--allow-empty` | A zero-match selection succeeds instead of exiting 5 |
| `--list` | Reports resolved prompt paths without healing |

In CI, `heal` refuses to run (exit 2) unless `ci.heal: true` is set — see [CI usage](#ci-usage).

Two configuration keys shape incremental repair; see [`docs/configuration.md`](docs/configuration.md) for their full contract:

- `heal.maxStepRepairs` — optional hard limit on real provider dispatches per healing batch (unset by default, meaning no limit).
- `heal.caseTimeoutMs` — admission-boundary deadline for one healing case.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Assertion failed (a replayed case's expectation did not hold) |
| `2` | Usage or configuration error (bad flags/config, unresolved secret or target, heal blocked in CI) |
| `3` | Environment error (browser launch failed, AI provider unavailable, file I/O failure, unexpected crash, interrupted) |
| `4` | The plan or grounding artifact can't be trusted (missing, stale `inputsDigest`, broken 1:1 correspondence) — regenerate before trusting results |
| `5` | The selection matched zero prompts (disable with `--allow-empty`) |

When a batch has results in more than one of these categories, the reported process exit code is the highest-priority one, in this fixed order: **2 > 3 > 4 > 1 > 5 > 0**. Individual case outcomes are always preserved in the JSON report's `results`/`errors`.

## Artifacts

| File | What it is | Commit to git? |
| --- | --- | --- |
| `<name>.test.md` | The prompt — source of truth | Yes |
| `<name>.ambercast.plan.json` | Generated execution plan | Yes (review it like a lockfile) |
| `<name>.ambercast.grounding.json` | Cached selectors/state the plan resolved | Yes by default (`grounding.repositoryPolicy: "committed"`) |
| `tests/ambercast/.runs/<invocation-id>/...` | Per-run evidence and `report.json` (location = `runsDir`) | No — gitignore this directory |

## Secrets

Prompts and plans must never contain literal credentials. Reference a secret as `{{secrets.name}}` and resolve it from the environment variable `AMBERCAST_SECRET_NAME` (dots become underscores, uppercased).

A secret reference is only honored when the prompt explicitly grants it, on its own line, outside code blocks:

```markdown
@ambercast-secret {{secrets.password}}
```

- A generated plan that embeds a literal-looking secret (`sk-...`, `ghp_...`, an AWS access key, or another high-entropy token) instead of a reference is rejected (`secret-literal-rejected`, exit 2).
- A referenced secret with no matching grant line, or no matching environment variable, fails closed (`secret-grant-unattributable` / `secret-unresolved`, exit 2) rather than silently proceeding.
- Resolved secret values are redacted from captured evidence, reports, and error output before they are written or printed.

## CI usage

A safe default for CI is `check` to gate freshness, then `run` without healing or cache write-back:

```bash
npx ambercast check
npx ambercast run
```

- `heal` does not run automatically anywhere, and it refuses to run in CI at all unless you opt in with `ci.heal: true` in `ambercast.config.json`.
- Grounding-cache changes from `run` are not persisted in CI unless you pass `--update-cache` for that invocation or set `ci.updateGroundingCache: true`.
- Gate your pipeline on the process exit code (see [Exit codes](#exit-codes)); `4` in particular means the committed plan/grounding no longer matches the prompt and needs `generate` or `heal`, not a re-run.

## Configuration

`ambercast.config.json` at the project root controls test discovery, targets, the AI provider, the viewer, CI behavior, grounding policy, and healing limits. All fields have defaults, so the file is optional. See [`docs/configuration.md`](docs/configuration.md) for the fields with a non-obvious contract.

## Status & limitations

ambercast is **0.x, pre-1.0**: breaking changes can land in a minor release. Current scope:

- Chromium only (Firefox and WebKit are planned).
- Local execution only — no hosted runner.
- No `init` command yet — set up config and prompts by hand (see [Quick start](#quick-start)).
- No results viewer yet.
- No MCP server yet.

## Contributing

See [`AGENTS.md`](AGENTS.md) for the project's design invariants, conventions, and workflow. The scripts you'll use most:

- `npm run build` — compile `src/` to `dist/`
- `npm test` — build then run the test suite
- `npm run typecheck` / `npm run lint`

## License

MIT — see [LICENSE](LICENSE).
