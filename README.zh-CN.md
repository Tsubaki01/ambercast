[English](README.md) | [日本語](README.ja.md) | 简体中文

# ambercast

提示词原生的 E2E 测试。

[![npm version](https://img.shields.io/npm/v/ambercast)](https://www.npmjs.com/package/ambercast)
[![CI](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml/badge.svg)](https://github.com/Tsubaki01/ambercast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22.14](https://img.shields.io/badge/node-%3E%3D22.14-brightgreen)

用自然语言 Markdown 提示词编写测试用例——提示词本身就是唯一真实来源（single source of truth）。AI 生成器会把每条提示词转换成确定性的、类似锁文件（lockfile）的执行计划（plan）。此后每次运行都会重放这份计划，**零 AI 调用**：快、免费、完全可复现。当应用的 UI 发生漂移（drift）时，计划会自我修复；当测试的*语义*发生变化时，则会请人来复核。

就像琥珀中封存的昆虫，你测试的意图只需铸造一次便被完整保留——无论表层如何变化。

> [!NOTE]
> ambercast 目前是 pre-1.0 版本，仍在积极开发中。参见[状态与限制](#状态与限制)。

**完整文档：** https://tsubaki01.github.io/ambercast/zh-cn/ （English / 日本語 / 简体中文）

## 工作原理

```text
sign-in.test.md
      │  ambercast generate（AI 调用，仅一次）
      ▼
sign-in.ambercast.plan.json  +  sign-in.ambercast.grounding.json
      │  两者一并提交到 git
      ▼
ambercast run（重放——定位缓存命中时零 AI 调用）
      │
      ├─ grounding 命中 → 确定性重放
      ├─ grounding 未命中 → 实时 AI 辅助执行该步骤，并更新缓存（可用 git diff 查看）
      └─ 检测到漂移 → ambercast heal 修复计划（需人工确认）
```

1. **Generate（生成）**——AI 提供方读取一次提示词，生成一份执行计划（要执行的步骤）和一份定位缓存（grounding，即它找到的具体选择器/坐标）。两者都是纯 JSON，设计上就是要被提交并像锁文件一样被复核。
2. **Run（运行）**——使用缓存的定位缓存在真实浏览器中重放执行计划，happy path 上不产生任何 AI 调用。某一步骤的定位缓存未命中时，仅针对该步骤回退到实时 AI 辅助解析（可用 `--cache-only` 跳过这一行为）。
3. **Heal（修复）**——当 UI 漂移到重放无法自行恢复的程度时，`ambercast heal` 会重新解析、修复或重新生成受影响的计划步骤，并在写入前请求确认。

## 环境要求

- Node.js >= 22.14
- 一个 [Playwright](https://playwright.dev) 可用的 Chromium 二进制文件：

  ```bash
  npx playwright-core install chromium
  ```

- 一个已安装并完成身份验证的 AI 提供方 CLI——密钥自备，ambercast 不管理凭据：
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（`claude`），或
  - [Codex CLI](https://github.com/openai/codex)（`codex`）

  默认情况下（`ai.provider: "auto"`）ambercast 会依次探测 `claude` 和 `codex`，使用先响应的那个；也可以传 `--ai claude` / `--ai codex`，或在配置中设置 `ai.provider` 来固定使用某一个。

## 安装

```bash
npm install -D ambercast
```

或者不安装直接运行：

```bash
npx ambercast <command>
```

## 快速开始

目前还没有 `init` 命令，需要手动搭建这两部分。

1. 在项目根目录创建 `ambercast.config.json`（可选——以下即默认值）：

   ```json
   {
     "testDir": "tests/ambercast",
     "targets": {
       "web-user": { "baseUrl": "http://localhost:3000", "browser": "chromium" }
     }
   }
   ```

2. 在 `tests/ambercast/sign-in.test.md` 编写测试提示词：

   ```markdown
   # Sign in

   When I submit valid credentials, I reach the dashboard.
   ```

3. 生成执行计划，然后运行它：

   ```bash
   npx ambercast generate
   npx ambercast run
   ```

`generate` 会在提示词旁生成 `tests/ambercast/sign-in.ambercast.plan.json` 和 `tests/ambercast/sign-in.ambercast.grounding.json`。请将这三个文件一并提交。

## 命令

所有命令都支持 `--config <path>`、`--no-color`、`--json`，以及通用的 `--` 分隔符（其后的所有内容都被当作字面量的提示词路径，即便以 `--` 开头也一样）。位置参数即字面量提示词路径；不传时，ambercast 会通过 `testDir`/`testMatch`/`testIgnore` 自动发现提示词。

### `generate [files...]`

将提示词转换为执行计划。仅对需要的提示词调用一次 AI；已是最新状态的计划会被跳过。

| 参数 | 效果 |
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

### `run [files...]`

在真实 Chromium 会话中确定性地重放执行计划，除非某一步的缓存定位缺失，否则不会产生 AI 调用。

| 参数 | 效果 |
| --- | --- |
| `--grep <pattern>` | 用正则表达式过滤发现的提示词路径 |
| `--target <name>` | 选择一个已配置的 target |
| `--headed` | 以可见浏览器窗口运行 |
| `--cache-only` | 定位缓存未命中时直接失败，而不回退到 AI |
| `--update-cache` | 显式授权持久化本次运行对定位缓存（grounding-cache）的改动 |
| `--stale <fail>` | 计划过期/缺失时的新鲜度策略；目前只支持 `fail`（解析器接受 `regenerate`，但目前总是以退出码 2 拒绝） |
| `--ai <claude\|codex>` | 仅当需要 grounding-miss 回退时，覆盖所用的提供方 |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行运行 |

写入：每次调用的证据文件与 `runsDir`（默认 `tests/ambercast/.runs/`）下的 `report.json`（参见[产物](#产物)）；以及依据下方写回策略决定是否更新的定位缓存。

某次定位缓存的改动是否真正被持久化，取决于 `--update-cache`、`grounding.localWriteBack`，以及（在 CI 中）`ci.updateGroundingCache`：

| 环境 | 何时持久化 |
| --- | --- |
| 本地，`localWriteBack: "auto"`（默认） | 始终持久化 |
| 本地，`localWriteBack: "explicit"` | 传入 `--update-cache` 时 |
| CI | 传入 `--update-cache`，或设置 `ci.updateGroundingCache: true` |

### `check [files...]`

只读的新鲜度检查。不会调用任何 AI 提供方或浏览器，也不会写入任何内容。可作为 `run` 之前的 CI 门禁使用。

| 参数 | 效果 |
| --- | --- |
| `--target <name>` | 选择一个已配置的 target |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行检查 |
| `--config <path>` | 使用指定的配置文件 |

### `heal [files...]`

修复定位缓存已不再匹配真实 UI 的计划：先尝试单步重新解析，再进行结构化的步骤修复，最后才整体重新生成计划，逐级升级，仅在必要时才继续。

| 参数 | 效果 |
| --- | --- |
| `--dry-run` | 仅测算并预览修复内容，不写入任何东西 |
| `--yes`, `-y` | 无需交互式确认提示即可提交修复 |
| `--target <name>` | 选择一个已配置的 target |
| `--ai <claude\|codex>` | 覆盖本次调用的提供方选择 |
| `--allow-empty` | 零匹配的选择视为成功，而不是以退出码 5 结束 |
| `--list` | 只报告解析出的提示词路径，不执行修复 |

在 CI 中，除非设置了 `ci.heal: true`，否则 `heal` 会拒绝执行修复（退出码 2）；`heal --list` 仍可使用——参见 [CI 使用](#ci-使用)。

有两个配置项用于控制增量修复；它们的完整约定参见 [`docs/configuration.md`](docs/configuration.md)：

- `heal.maxStepRepairs` —— 每个修复批次中，真实提供方调用次数的硬性上限（可选；默认未设置，即不限制）。
- `heal.caseTimeoutMs` —— 单个修复用例的准入边界截止时间。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 断言失败（某个重放用例的期望未成立） |
| `2` | 用法或配置错误（错误的参数/配置、未解析的密钥或 target、CI 中 heal 被阻止） |
| `3` | 环境错误（浏览器启动失败、AI 提供方不可用、文件 I/O 失败、意外崩溃、被中断） |
| `4` | 执行计划或定位缓存产物不可信（缺失、`inputsDigest` 过期、1:1 对应关系被破坏）——需先重新生成再信任结果 |
| `5` | 选择结果零匹配（可用 `--allow-empty` 关闭此行为） |

当一个批次中的结果落在多个类别时，最终报告的进程退出码取优先级最高的那个，固定顺序为：**2 > 3 > 4 > 1 > 5 > 0**。每个用例各自的结果始终完整保留在 JSON 报告的 `results`/`errors` 中。

## 产物

| 文件 | 是什么 | 是否提交到 git？ |
| --- | --- | --- |
| `<name>.test.md` | 提示词——唯一真实来源 | 是 |
| `<name>.ambercast.plan.json` | 生成的执行计划 | 是（像复核锁文件一样复核它） |
| `<name>.ambercast.grounding.json` | 计划解析出的缓存选择器/状态 | 默认是（`grounding.repositoryPolicy: "committed"`） |
| `tests/ambercast/.runs/<invocation-id>/...` | 单次运行的证据与 `report.json`（位置由 `runsDir` 决定） | 否——将此目录加入 gitignore |

## 密钥

提示词和执行计划中不得包含字面量凭据。请以 `{{secrets.name}}` 的形式引用密钥，并从环境变量 `AMBERCAST_SECRET_NAME`（点号变为下划线，全部大写）中解析。

密钥引用只有在提示词中显式授予时才会生效，授予语句需独占一行且位于代码块之外：

```markdown
@ambercast-secret {{secrets.password}}
```

- 生成的执行计划如果内嵌了一个形似字面量密钥的值（`sk-...`、`ghp_...`、AWS access key，或其他高熵 token）而非一个引用，会被拒绝（`secret-literal-rejected`，退出码 2）。
- 一个被引用的密钥若没有匹配的授予语句，或没有匹配的环境变量，会直接失败（`secret-grant-unattributable` / `secret-unresolved`，退出码 2），而不是悄悄放行。
- 已解析的密钥值在写入或打印之前，会先从捕获的证据、报告和错误输出中被脱敏。

## CI 使用

在 CI 中一种安全的默认做法是：先用 `check` 做新鲜度门禁，再运行 `run`，且不启用修复或缓存写回：

```bash
npx ambercast check
npx ambercast run
```

- `heal` 不会在任何地方自动运行，并且除非在 `ambercast.config.json` 中显式设置 `ci.heal: true` 选择加入，否则它在 CI 中会拒绝执行修复（未设置时仅允许只读的 `heal --list`）。
- 除非为该次调用传入 `--update-cache`，或设置 `ci.updateGroundingCache: true`，否则 `run` 产生的定位缓存改动不会在 CI 中被持久化。
- 请以进程退出码作为流水线的判定依据（参见[退出码](#退出码)）；其中 `4` 尤其意味着已提交的执行计划/定位缓存已不再匹配提示词，需要执行 `generate` 或 `heal`，而不是简单地重新运行。

## 配置

项目根目录下的 `ambercast.config.json` 控制测试发现、target、AI 提供方、查看器（viewer）、CI 行为、定位缓存策略以及修复限制。所有字段都有默认值，因此该文件是可选的。有非显而易见约定的字段请参见 [`docs/configuration.md`](docs/configuration.md)。

## 状态与限制

ambercast 目前是 **0.x、pre-1.0** 版本：破坏性变更可能出现在次版本（minor release）中。当前范围：

- 仅支持 Chromium（Firefox 与 WebKit 在计划中）。
- 仅支持本地执行——没有托管的 runner。
- 尚无 `init` 命令——需手动搭建配置与提示词（参见[快速开始](#快速开始)）。
- 尚无结果查看器（viewer）。
- 尚无 MCP server。

## 贡献

项目的设计不变量、约定和工作流程参见 [`AGENTS.md`](AGENTS.md)。你最常用到的脚本：

- `npm run build` —— 将 `src/` 编译到 `dist/`
- `npm test` —— 先构建再运行测试套件
- `npm run typecheck` / `npm run lint`

## 许可证

MIT——参见 [LICENSE](LICENSE)。
