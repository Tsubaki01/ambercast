---
title: Getting started
description: Prerequisites, install, and a quick-start walkthrough for ambercast.
sidebar:
  order: 2
---

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

## What gets written and committed

`generate` writes `tests/ambercast/sign-in.ambercast.plan.json` and `tests/ambercast/sign-in.ambercast.grounding.json` next to the prompt. Commit all three files — see [Artifacts](/ambercast/guides/artifacts/) for the full picture and commit policy.

Next: [write your own prompts](/ambercast/guides/writing-prompts/) or read the [command reference](/ambercast/guides/commands/).
