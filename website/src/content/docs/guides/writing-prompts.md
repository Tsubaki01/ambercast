---
title: Writing prompts
description: The .test.md prompt file format, natural-language statements, and the secret-grant line.
sidebar:
  order: 3
---

A prompt is a Markdown file named `<name>.test.md`. It is the single source of truth: `ambercast generate` reads it to produce a plan, and the plan is only regenerated when the prompt's meaningful content changes.

## Structure

- A headline (an H1) naming the test case.
- One or more natural-language statements describing what should happen, in plain sentences — no special syntax or DSL.

```markdown
# Sign in

When I submit valid credentials, I reach the dashboard.
```

Markdown is normalized minimally before it contributes to the plan's provenance: a leading byte-order mark is stripped and line endings are converted to LF, but nothing is trimmed, reordered, or reworded. Write the prompt the way you want it read.

## Secrets: the grant line

Prompts and plans must never contain literal credentials. Reference a secret as `{{secrets.name}}`, and explicitly authorize its use with a grant line on its own — outside any code block:

```markdown
@ambercast-secret {{secrets.password}}
```

A secret reference with no matching grant line fails closed rather than being silently honored. See [Secrets](/ambercast/guides/secrets/) for the full resolution and redaction contract.

## A realistic example

```markdown
# Sign in with a saved password

@ambercast-secret {{secrets.password}}

When I submit the username "demo@example.com" and the password {{secrets.password}}, I reach the dashboard.
```

Next: run `ambercast generate` and `ambercast run` — see [Commands](/ambercast/guides/commands/).
