---
title: 命令
description: generate、run、check 和 heal —— 标志位、各自写入的内容、AI 何时被调用，以及 CI 行为。
sidebar:
  order: 4
---

所有命令都支持 `--config <path>`、`--no-color`、`--json`，以及通用的 `--` 分隔符（其后的所有内容都被当作字面量的提示词路径，即便以 `--` 开头也一样）。位置参数即字面量提示词路径；不传时，ambercast 会通过 `testDir`/`testMatch`/`testIgnore` 自动发现提示词。

## `generate [files...]`

将提示词转换为执行计划。仅对需要的提示词调用一次 AI；已是最新状态的计划会被跳过。

| 标志 | 效果 |
| --- | --- |
| `--strict` | 生成结果有歧义时直接失败，而不是仅发出警告 |
| `--force` | 无条件重新生成，即便计划已是最新 |
| `--dry-run` | 仅预览，不写入 plan/grounding 文件 |
| `--target <name>` | 选择一个已配置的 target |
| `--ai <claude\|codex>` | 覆盖本次调用的提供方选择 |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行生成 |
| `--config <path>` | 使用指定的配置文件 |

写入：`<name>.ambercast.plan.json`、`<name>.ambercast.grounding.json`。

## `run [files...]`

使用缓存的定位缓存，在真实的 Chromium 会话中确定性地重放执行计划，除非某一步的缓存定位缺失，否则不会产生 AI 调用。

| 标志 | 效果 |
| --- | --- |
| `--grep <pattern>` | 用正则表达式过滤发现的提示词路径 |
| `--target <name>` | 选择一个已配置的 target |
| `--headed` | 以可见浏览器窗口运行 |
| `--cache-only` | 定位缓存未命中时直接失败，而不回退到 AI |
| `--update-cache` | 显式授权持久化本次运行对定位缓存的改动 |
| `--stale <fail>` | 计划过期/缺失时的新鲜度策略；目前只支持 `fail`（解析器接受 `regenerate`，但目前总是以退出码 2 拒绝） |
| `--ai <claude\|codex>` | 仅当需要定位缓存未命中回退时，覆盖所用的提供方 |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行运行 |

写入：每次调用的证据文件与 `.runs/` 下的 `report.json`（参见[产物](/ambercast/zh-cn/guides/artifacts/)）；定位缓存的更新则依据下方的写回策略决定。

### 定位缓存写回

某次定位缓存的改动是否真正被持久化，取决于 `--update-cache`、`grounding.localWriteBack`，以及（在 CI 中）`ci.updateGroundingCache`：

| 环境 | 何时持久化 |
| --- | --- |
| 本地，`localWriteBack: "auto"`（默认） | 始终持久化 |
| 本地，`localWriteBack: "explicit"` | 传入 `--update-cache` 时 |
| CI | 传入 `--update-cache`，或设置 `ci.updateGroundingCache: true` |

## `check [files...]`

只读的新鲜度检查。不会调用任何 AI 提供方或浏览器，也不会写入任何内容。可作为 `run` 之前的 CI 门禁使用。

| 标志 | 效果 |
| --- | --- |
| `--target <name>` | 选择一个已配置的 target |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行检查 |
| `--config <path>` | 使用指定的配置文件 |

## `heal [files...]`

修复定位缓存已不再匹配真实 UI 的计划：先尝试单步重新解析，再进行结构化的步骤修复，最后才整体重新生成计划，逐级升级，仅在必要时才继续。

| 标志 | 效果 |
| --- | --- |
| `--dry-run` | 仅测算并预览修复内容，不写入任何东西 |
| `--yes`, `-y` | 无需交互式确认提示即可提交修复 |
| `--target <name>` | 选择一个已配置的 target |
| `--ai <claude\|codex>` | 覆盖本次调用的提供方选择 |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行修复 |

### CI 中的 heal 拒绝行为

`heal` 不会在任何地方自动运行，并且除非在 `ambercast.config.json` 中设置了 `ci.heal: true`，否则它在 CI 中会完全拒绝运行（退出码 2）—— 参见 [CI 使用](/ambercast/zh-cn/guides/ci/)。

有两个配置项用于控制增量修复；它们的完整约定参见[配置参考](/ambercast/reference/configuration/)：

- `heal.maxStepRepairs` —— 每个修复批次中，真实提供方调用次数的硬性上限（默认未设置 —— 不限制）。
- `heal.caseTimeoutMs` —— 单个修复用例的准入边界截止时间。
