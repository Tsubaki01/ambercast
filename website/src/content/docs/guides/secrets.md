---
title: Secrets
description: The {{secrets.name}} reference syntax, environment-variable mapping, grants, and redaction.
sidebar:
  order: 7
---

Prompts and plans must never contain literal credentials. Reference a secret as `{{secrets.name}}` and resolve it from the environment variable `AMBERCAST_SECRET_NAME` (dots become underscores, uppercased — so `{{secrets.api.key}}` resolves `AMBERCAST_SECRET_API_KEY`).

## The grant line

A secret reference is only honored when the prompt explicitly grants it, on its own line, outside code blocks:

```markdown
@ambercast-secret {{secrets.password}}
```

A grant line inside a fenced code block, an indented code block, or an inline code span is not authoritative — it is documentation, not a grant.

## Fail-closed errors

- A generated plan that embeds a literal-looking secret (`sk-...`, `ghp_...`, an AWS access key, or another high-entropy token) instead of a reference is rejected (`secret-literal-rejected`, exit 2).
- A referenced secret with no matching grant line, or no matching environment variable, fails closed (`secret-grant-unattributable` / `secret-unresolved`, exit 2) rather than silently proceeding.

## Redaction

Resolved secret values are redacted from captured evidence, reports, and error output before they are written or printed.

See [Writing prompts](/ambercast/guides/writing-prompts/) for a worked example.
