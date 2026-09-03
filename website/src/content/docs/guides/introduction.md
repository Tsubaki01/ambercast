---
title: Introduction
description: What ambercast is, why it exists, and how the generate/run/heal cycle works.
sidebar:
  order: 1
---

Write test cases as natural-language Markdown prompts — the prompt is the single source of truth. An AI generator turns each prompt into a deterministic, lockfile-like execution plan. From then on, runs are replayed with **zero AI calls**: fast, free, and fully reproducible. When the app's UI drifts, the plan self-repairs; when the *meaning* of a test changes, a human is asked to review.

:::note
ambercast is pre-1.0 and under active development. See [Status & limitations](#status--limitations).
:::

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

## Status & limitations

ambercast is **0.x, pre-1.0**: breaking changes can land in a minor release. Current scope:

- Chromium only (Firefox and WebKit are planned).
- Local execution only — no hosted runner.
- No `init` command yet — set up config and prompts by hand (see [Getting started](/ambercast/guides/getting-started/)).
- No results viewer yet.
- No MCP server yet.
