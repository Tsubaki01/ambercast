English | [日本語](README-ja.md) | [简体中文](README-zh-CN.md)

# ambercast

Prompt-native E2E testing.

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/kotarotsubaki/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

Write test cases as natural-language Markdown prompts — the prompt is the single source of truth. An AI generator turns each prompt into a deterministic, lockfile-like execution plan. From then on, runs are replayed with **zero AI calls**: fast, free, and fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human is asked to review.

Like an insect preserved in amber, your test's intent is cast once and kept intact — no matter how the surface changes.

> [!NOTE]
> ambercast is pre-1.0 and under active development. [Status](#status) has the details.

**Full documentation:** https://kotarotsubaki.github.io/ambercast/ (English / 日本語 / 简体中文)

## Install

```bash
npm install -D ambercast
```

Or run it without installing:

```bash
npx ambercast <command>
```

You need Node.js >= 22.14, a Chromium binary (`npx playwright-core install chromium`), and an already-authenticated AI provider CLI, either [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex) (ambercast does not manage credentials; bring your own key) — take a look at the [Getting started guide](https://kotarotsubaki.github.io/ambercast/guides/getting-started/).

## Quick start

There is no `init` command yet; a prompt file is all you need, and defaults assume your app is at `http://localhost:3000` ([configuration](https://kotarotsubaki.github.io/ambercast/reference/configuration/) has the details).

1. Write a test prompt at `tests/ambercast/sign-in.test.md`:

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

2. Generate the plan, then run it:

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` writes `sign-in.ambercast.plan.json` and `sign-in.ambercast.grounding.json` next to the prompt; be sure to commit all three files. Every later `run` replays the plan with zero AI calls as long as the cached grounding is intact; a grounding miss falls back to AI for that step, and `--cache-only` makes it fail instead — take a look at the [Writing prompts](https://kotarotsubaki.github.io/ambercast/guides/writing-prompts/) guide.

## Learn more

- [Commands](https://kotarotsubaki.github.io/ambercast/guides/commands/) — Overview of generate, run, check, and heal commands.
- [Exit codes](https://kotarotsubaki.github.io/ambercast/guides/exit-codes/) — Exit codes 0–5 and priority order for mixed batch outcomes.
- [Artifacts](https://kotarotsubaki.github.io/ambercast/guides/artifacts/) — Which generated files to commit and which to gitignore.
- [Secrets](https://kotarotsubaki.github.io/ambercast/guides/secrets/) — How credentials reach a test without entering the prompt or plan.
- [CI usage](https://kotarotsubaki.github.io/ambercast/guides/ci/) — Running on CI and why heal is blocked there.
- [Configuration reference](https://kotarotsubaki.github.io/ambercast/reference/configuration/) — Full reference for every `ambercast.config.json` field.

## Status

ambercast is pre-1.0 (0.x), and breaking changes can land in a minor release.

- Chromium only (Firefox and WebKit are planned).
- Local execution only — no hosted runner.
- No `init` command yet — config and prompts are set up by hand.
- No results viewer yet.
- No MCP server yet.

## Contributing

Bug reports and PRs are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md), which covers the PR-title convention, the day-to-day scripts, and how the maintainer's AI automation in AGENTS.md relates to external contributions (it is not a prerequisite).

## License

MIT — [LICENSE](LICENSE) has the details.
