---
title: CLI reference
description: The exact --help output for the ambercast command, and the global flags shared by every subcommand.
sidebar:
  order: 1
---

Output of `ambercast --help` (0.1.0):

```text
Usage: ambercast <command> [options]

Commands:
  generate [files...]  Generate deterministic plans
  run [files...]       Replay deterministic plans
  check [files...]     Check plan freshness
  heal [files...]      Repair deterministic plans

Generate options:
  --strict  --force  --dry-run  --target <name>  --ai <claude|codex>
  --allow-empty  --list  --json  --config <path>  --no-color

Run options:
  --grep <pattern>  --target <name>  --headed  --cache-only  --update-cache  --allow-empty  --list
  --stale <fail>  --json  --no-color

Check options:
  --target <name>  --allow-empty  --list  --json  --config <path>  --no-color

Heal options:
  --dry-run  --yes, -y  --target <name>  --ai <claude|codex>  --allow-empty  --list  --json  --no-color

Heal configuration:
  heal.maxStepRepairs: Hard limit on real provider dispatches started during incremental repair. Charged at dispatch time regardless of outcome. Includes element confirmation dispatches. Excludes the cache-only baseline and Stage 3.
  heal.caseTimeoutMs: see docs/configuration.md for its admission-boundary contract.
```

## Global flags

Every command accepts:

| Flag | Effect |
| --- | --- |
| `--config <path>` | Uses an explicit config file instead of discovering `ambercast.config.json` |
| `--no-color` | Disables colored output |
| `--json` | Renders the report as JSON instead of human-readable text |
| `--` | Everything after this separator is treated as literal prompt paths, even ones starting with `--` |

See [Commands](/ambercast/guides/commands/) for what each subcommand's flags do, and the [configuration reference](/ambercast/reference/configuration/) for `heal.maxStepRepairs` and `heal.caseTimeoutMs`.
