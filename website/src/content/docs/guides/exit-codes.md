---
title: Exit codes
description: The process exit code table and the priority order used when a batch has mixed outcomes.
sidebar:
  order: 5
---

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Assertion failed (a replayed case's expectation did not hold) |
| `2` | Usage or configuration error (bad flags/config, unresolved secret or target, heal blocked in CI) |
| `3` | Environment error (browser launch failed, AI provider unavailable, file I/O failure, unexpected crash, interrupted) |
| `4` | The plan or grounding artifact can't be trusted (missing, stale `inputsDigest`, broken 1:1 correspondence) — regenerate before trusting results |
| `5` | The selection matched zero prompts (disable with `--allow-empty`) |

When a batch has results in more than one of these categories, the reported process exit code is the highest-priority one, in this fixed order:

**2 > 3 > 4 > 1 > 5 > 0**

Individual case outcomes are always preserved in the JSON report's `results`/`errors`.

<details>
<summary>Why this order?</summary>

The order ranks by how much the process outcome should dominate a mixed batch, not by numeric severity:

- **2 (usage/config)** and **3 (environment)** outrank everything — if the invocation itself was misconfigured or the environment couldn't run, no other result in the batch can be trusted either.
- **4 (untrustworthy artifact)** comes next: a stale or broken plan means the batch's results don't reflect the current prompt.
- **1 (assertion failed)** only wins once the run itself is known to be trustworthy.
- **5 (zero matches)** ranks below a real assertion failure — a batch that found nothing to test is a weaker signal than one that found something and it failed.
- **0 (success)** is the fallback for an empty or all-success input.

This is enforced in code, not just documented: `selectExitCode` in `src/usecases/exit-code-priority.ts` keeps a rank table and asserts at module load that the ranks form a contiguous sequence with no gaps or ties.
</details>
