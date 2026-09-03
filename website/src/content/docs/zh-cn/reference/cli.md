---
title: CLI 参考
description: ambercast 命令的确切 --help 输出，以及每个子命令共享的全局标志。
sidebar:
  order: 1
---

`ambercast --help` 的输出（0.1.0）：

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

## 全局标志

每个命令都支持：

| 标志 | 效果 |
| --- | --- |
| `--config <path>` | 使用指定的配置文件，而不是自动发现 `ambercast.config.json` |
| `--no-color` | 禁用彩色输出 |
| `--json` | 将报告渲染为 JSON，而不是人类可读的文本 |
| `--` | 此分隔符之后的所有内容都被当作字面量的提示词路径，即便以 `--` 开头也一样 |

各子命令标志的作用参见[命令](/ambercast/zh-cn/guides/commands/)；`heal.maxStepRepairs` 和 `heal.caseTimeoutMs` 参见[配置参考](/ambercast/reference/configuration/)。
